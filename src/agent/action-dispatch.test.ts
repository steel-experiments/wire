import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  BrowserSession,
  JsonValue,
  RunCheckpoint,
  SessionId,
  Task,
  TraceEvent,
} from "../shared/types.js";

import type { BrowserObserveInput, BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";

import { classifyRun, generateOutcomeSummary } from "./classify.js";
import { defaultAgentTurn, executeTask, resumeTask } from "./runtime.js";
import {
  createLoopState,
  executeStep,
  finalizeRun,
  shouldStop,
  deriveRunResult,
} from "./loop.js";
import type { LoopState, StopConditions } from "./loop.js";
import { ActionRegistry } from "./actions.js";
import { writeSkillStats } from "../skills/stats.js";
import type { LLMProvider } from "../providers/llm/openai.js";
import {
  isNavigationOnlyResult,
  appendExtractedResultArtifact,
  hasPostNavigationExtraction,
  isRecoverableStepError,
  computeRepeatStreak,
  buildVerificationAction,
  latestExtractionIsVerificationProbe,
} from "./state-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Test task",
    mode: "task",
    objective: "Complete a test task",
    constraints: [],
    successCriteria: ["Page loads successfully"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSessionId(): SessionId {
  return createId("session");
}

function createMockProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    async createSession() {
      throw new Error("not implemented");
    },
    async getSession() {
      throw new Error("not implemented");
    },
    async stopSession() {
      throw new Error("not implemented");
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      return {
        sessionId: input.sessionId,
        url: "https://example.com",
        title: "Example",
        tabs: [
          { id: "tab-1", title: "Example", url: "https://example.com", active: true },
        ],
      };
    },
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      return {
        ok: true,
        stdout: "ok",
        durationMs: 10,
      };
    },
    ...overrides,
  };
}

function createMockPolicyEngine(overrides: Partial<PolicyEngine> = {}): PolicyEngine {
  return {
    check(_actionId, _action) {
      return {
        id: createId("policy"),
        actionId: _actionId,
        result: "allow",
      };
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createLoopState
// ---------------------------------------------------------------------------

test("executeStep handles raw CDP action and triggers policy check", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider({
    async raw() {
      return { result: { value: 2 } };
    },
  });
  const policy = createMockPolicyEngine();

  const result = await executeStep(
    state,
    {
      kind: "raw",
      summary: "Send CDP command",
      payload: { method: "Runtime.evaluate", params: { expression: "1+1" } },
    },
    provider,
    policy,
  );

  assert.equal(result.policyDenied, false);
  assert.equal(result.state.stepCount, 1);
  // policy-check + code-exec + code-result = 3 events
  assert.equal(result.state.events.length, 3);
  assert.equal(result.state.events[0]!.kind, "policy-check");
  assert.equal(result.state.events[1]!.kind, "code-exec");
  assert.equal(result.state.events[2]!.kind, "code-result");
});

test("executeStep denies raw CDP action when policy denies it", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine({
    check(actionId) {
      return {
        id: createId("policy"),
        actionId,
        result: "deny",
        reason: "Raw CDP access not allowed",
      };
    },
  });

  const result = await executeStep(
    state,
    {
      kind: "raw",
      summary: "Send dangerous CDP command",
      payload: { method: "Browser.close" },
    },
    provider,
    policy,
  );

  assert.equal(result.policyDenied, true);
  assert.equal(result.state.events.length, 1);
  assert.equal(result.state.events[0]!.kind, "policy-check");
  assert.equal(result.state.stepCount, 0);
});

// ---------------------------------------------------------------------------
// classifyRun — failure classification mapping
// ---------------------------------------------------------------------------

test("executeStep executes wireActions from exec returnValue (object)", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  let rawBatchCalled = false;
  let rawBatchCommands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const provider = createMockProvider({
    async exec() {
      return {
        ok: true,
        durationMs: 10,
        returnValue: {
          wireActions: [
            { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "ArrowDown", windowsVirtualKeyCode: 40 } },
            { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "ArrowDown", windowsVirtualKeyCode: 40 } },
          ],
        },
      };
    },
  } as Partial<BrowserProvider> & { rawBatch?: (sessionId: SessionId, commands: Array<{ method: string; params?: Record<string, unknown> }>) => Promise<unknown> });
  // Attach rawBatch to provider
  (provider as unknown as Record<string, unknown>).rawBatch = async (_sessionId: SessionId, commands: Array<{ method: string; params?: Record<string, unknown> }>) => {
    rawBatchCalled = true;
    rawBatchCommands = commands;
    return { ok: true };
  };
  const policy = createMockPolicyEngine();

  const result = await executeStep(
    state,
    {
      kind: "exec",
      summary: "Read board and send moves",
      payload: { code: "return JSON.stringify({wireActions:[...]})" },
    },
    provider,
    policy,
  );

  assert.equal(result.policyDenied, false);
  assert.equal(result.state.stepCount, 1);
  assert.ok(rawBatchCalled, "rawBatch should be called");
  assert.equal(rawBatchCommands.length, 2);
  assert.equal(rawBatchCommands[0]!.method, "Input.dispatchKeyEvent");
  // Events: policy-check, code-exec, code-result (exec), code-result (wireActions)
  const codeResults = result.state.events.filter((e) => e.kind === "code-result");
  assert.equal(codeResults.length, 2);
  const waEvent = codeResults[1]!;
  assert.equal(waEvent.payload.source, "wireActions");
  assert.equal(waEvent.payload.commandsExecuted, 2);
  assert.equal(waEvent.payload.ok, true);
});

test("executeStep executes wireActions from exec returnValue (JSON string)", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  let rawBatchCalled = false;
  const provider = createMockProvider({
    async exec() {
      return {
        ok: true,
        durationMs: 10,
        returnValue: JSON.stringify({
          wireActions: [
            { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "ArrowUp", windowsVirtualKeyCode: 38 } },
          ],
        }),
      };
    },
  } as Partial<BrowserProvider>);
  (provider as unknown as Record<string, unknown>).rawBatch = async () => {
    rawBatchCalled = true;
    return { ok: true };
  };
  const policy = createMockPolicyEngine();

  const result = await executeStep(
    state,
    {
      kind: "exec",
      summary: "Parse string return and send CDP",
      payload: { code: "return JSON.stringify({wireActions:[...]})" },
    },
    provider,
    policy,
  );

  assert.ok(rawBatchCalled, "rawBatch should be called for JSON string returnValue");
  const codeResults = result.state.events.filter((e) => e.kind === "code-result");
  assert.equal(codeResults.length, 2);
  assert.equal(codeResults[1]!.payload.source, "wireActions");
});

test("executeStep auto-observes after wireActions Page.navigate", async () => {
  // Repro of grants.gov run_48b5ae4d: agent navigated via wireActions
  // Page.navigate, but no auto-observation followed, so it flew blind.
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  let observeCount = 0;
  const provider = createMockProvider({
    async exec() {
      return {
        ok: true,
        durationMs: 10,
        returnValue: { wireActions: [{ method: "Page.navigate", params: { url: "https://example.com/x" } }] },
      };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      return {
        sessionId: input.sessionId,
        url: "https://example.com/x",
        title: "After nav",
        tabs: [{ id: "tab-1", title: "After nav", url: "https://example.com/x", active: true }],
      };
    },
  } as Partial<BrowserProvider>);
  (provider as unknown as Record<string, unknown>).rawBatch = async () => ({ ok: true });

  await executeStep(
    state,
    { kind: "exec", summary: "Navigate via CDP", payload: { code: "return {wireActions:[{method:'Page.navigate',params:{url:'https://example.com/x'}}]}" } },
    provider,
    createMockPolicyEngine(),
  );

  assert.equal(observeCount, 1, "should auto-observe once after Page.navigate via wireActions");
  const observations = state.events.filter((e) => e.kind === "observation");
  assert.equal(observations.length, 1);
  assert.equal(observations[0]!.payload.url, "https://example.com/x");
});

test("executeStep auto-observes after raw Page.navigate", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  let observeCount = 0;
  const provider = createMockProvider({
    async raw() { return { ok: true }; },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      return {
        sessionId: input.sessionId,
        url: "https://example.com/raw",
        title: "Raw nav",
        tabs: [{ id: "tab-1", title: "Raw nav", url: "https://example.com/raw", active: true }],
      };
    },
  } as Partial<BrowserProvider>);

  await executeStep(
    state,
    { kind: "raw", summary: "Raw navigate", payload: { method: "Page.navigate", params: { url: "https://example.com/raw" } } },
    provider,
    createMockPolicyEngine(),
  );

  assert.equal(observeCount, 1);
});

test("executeStep auto-observes after clicks and records tab drift", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "observation",
    payload: {
      targetId: "tab-1",
      url: "https://example.com",
      title: "Before",
      tabs: [{ id: "tab-1", title: "Before", url: "https://example.com", active: true }],
    },
  });
  let observeCount = 0;
  const provider = createMockProvider({
    async exec() {
      return { ok: true, durationMs: 10, returnValue: { clicked: true } };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      return {
        sessionId: input.sessionId,
        targetId: "tab-2",
        url: "https://example.com/cookies",
        title: "Cookie Policy",
        tabs: [
          { id: "tab-1", title: "Before", url: "https://example.com", active: false },
          { id: "tab-2", title: "Cookie Policy", url: "https://example.com/cookies", active: true },
        ],
      };
    },
  } as Partial<BrowserProvider>);

  await executeStep(
    state,
    { kind: "exec", summary: "Click cookie consent", payload: { code: "document.querySelector('button').click(); return {clicked:true}" } },
    provider,
    createMockPolicyEngine(),
  );

  assert.equal(observeCount, 1);
  const latest = state.events.filter((e) => e.kind === "observation").at(-1)!;
  assert.equal((latest.payload.tabDrift as Record<string, unknown>).targetChanged, true);
  assert.match(String((latest.payload.tabDrift as Record<string, unknown>).message), /new tab/u);
});

test("executeStep records wire.click events and auto-observes", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  let observeCount = 0;
  const provider = createMockProvider({
    async exec() {
      return {
        ok: true,
        durationMs: 10,
        returnValue: "clicked",
        wireEvents: [
          {
            source: "wireBinding",
            action: "click",
            ok: true,
            x: 100,
            y: 200,
            button: "left",
            target: { tag: "button", text: "Continue", selectorHint: "#continue" },
          },
        ],
      };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      return {
        sessionId: input.sessionId,
        targetId: "tab-1",
        url: "https://example.com/next",
        title: "Next",
        tabs: [{ id: "tab-1", title: "Next", url: "https://example.com/next", active: true }],
      };
    },
  } as Partial<BrowserProvider>);

  await executeStep(
    state,
    { kind: "exec", summary: "Trusted click", payload: { code: "await wire.click('#continue'); return 'clicked';" } },
    provider,
    createMockPolicyEngine(),
  );

  assert.equal(observeCount, 1);
  const result = state.events.find((event) => event.kind === "code-result")!;
  const wireEvents = result.payload.wireEvents as Array<Record<string, unknown>>;
  assert.equal(wireEvents[0]?.source, "wireBinding");
  assert.equal(wireEvents[0]?.action, "click");
  assert.equal((wireEvents[0]?.target as Record<string, unknown>).text, "Continue");
});

test("executeStep caps oversized wireActions batches", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const requested = Array.from({ length: 100 }, () => ({ method: "Input.dispatchKeyEvent" }));
  let received = 0;
  const provider = createMockProvider({
    async exec() {
      return { ok: true, durationMs: 10, returnValue: { wireActions: requested } };
    },
  } as Partial<BrowserProvider>);
  (provider as unknown as Record<string, unknown>).rawBatch = async (_sessionId: SessionId, commands: Array<{ method: string }>) => {
    received = commands.length;
    return { ok: true };
  };

  const result = await executeStep(
    state,
    { kind: "exec", summary: "Large CDP batch", payload: { code: "return {wireActions}" } },
    provider,
    createMockPolicyEngine(),
  );

  assert.equal(received, 80);
  const wireResult = result.state.events.filter((event) => event.kind === "code-result").at(-1)!;
  assert.equal(wireResult.payload.source, "wireActions");
  assert.equal(wireResult.payload.commandsRequested, 100);
  assert.equal(wireResult.payload.commandsExecuted, 80);
  assert.equal(wireResult.payload.truncated, true);
});

test("executeStep drops Runtime.evaluate from wireActions", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  let methods: string[] = [];
  const provider = createMockProvider({
    async exec() {
      return {
        ok: true,
        durationMs: 10,
        returnValue: {
          wireActions: [
            { method: "Runtime.evaluate", params: { expression: "new Promise(()=>{})" } },
            { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "ArrowDown" } },
          ],
        },
      };
    },
  } as Partial<BrowserProvider>);
  (provider as unknown as Record<string, unknown>).rawBatch = async (_sessionId: SessionId, commands: Array<{ method: string }>) => {
    methods = commands.map((command) => command.method);
    return { ok: true };
  };

  await executeStep(
    state,
    { kind: "exec", summary: "Mixed wire actions", payload: { code: "return {wireActions}" } },
    provider,
    createMockPolicyEngine(),
  );

  assert.deepEqual(methods, ["Input.dispatchKeyEvent"]);
});

test("executeStep falls back to sequential execRaw when rawBatch unavailable", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  let rawCallCount = 0;
  const provider = createMockProvider({
    async exec() {
      return {
        ok: true,
        durationMs: 10,
        returnValue: {
          wireActions: [
            { method: "Input.dispatchKeyEvent", params: { type: "keyDown", key: "ArrowLeft" } },
            { method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "ArrowLeft" } },
          ],
        },
      };
    },
    async raw() {
      rawCallCount++;
      return { result: true };
    },
  } as Partial<BrowserProvider>);
  // Deliberately do NOT attach rawBatch
  const policy = createMockPolicyEngine();

  const result = await executeStep(
    state,
    {
      kind: "exec",
      summary: "Sequential fallback",
      payload: { code: "return {wireActions:[...]}" },
    },
    provider,
    policy,
  );

  assert.equal(rawCallCount, 2, "should call raw twice sequentially");
  const codeResults = result.state.events.filter((e) => e.kind === "code-result");
  assert.equal(codeResults.length, 2);
  assert.equal(codeResults[1]!.payload.source, "wireActions");
  assert.equal(codeResults[1]!.payload.commandsExecuted, 2);
});
