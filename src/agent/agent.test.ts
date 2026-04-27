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
  SessionId,
  Task,
  TraceEvent,
} from "../shared/types.js";

import type { BrowserObserveInput, BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";

import { classifyRun, generateOutcomeSummary } from "./classify.js";
import { defaultAgentTurn, executeTask } from "./runtime.js";
import {
  createLoopState,
  executeStep,
  finalizeRun,
  shouldStop,
} from "./loop.js";
import type { LoopState, StopConditions } from "./loop.js";
import { ActionRegistry } from "./actions.js";
import {
  isNavigationOnlyResult,
  hasPostNavigationExtraction,
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

test("createLoopState creates state with running run", () => {
  const task = makeTask();
  const sessionId = makeSessionId();
  const state = createLoopState(task, sessionId);

  assert.equal(state.task.id, task.id);
  assert.equal(state.sessionId, sessionId);
  assert.equal(state.run.taskId, task.id);
  assert.equal(state.run.status, "running");
  assert.equal(state.stepCount, 0);
  assert.deepEqual(state.events, []);
  assert.ok(state.startedAt);
  assert.ok(state.run.startedAt);
});

// ---------------------------------------------------------------------------
// shouldStop
// ---------------------------------------------------------------------------

test("shouldStop returns false when no conditions are met", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const conditions: StopConditions = {
    maxSteps: 10,
    budgetExhausted: false,
    policyDenied: false,
    authWallHit: false,
    userCancelled: false,
  };

  const result = shouldStop(state, conditions);
  assert.equal(result.stop, false);
  assert.equal(result.reason, undefined);
});

test("shouldStop returns true when user cancelled", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const conditions: StopConditions = {
    maxSteps: 10,
    budgetExhausted: false,
    policyDenied: false,
    authWallHit: false,
    userCancelled: true,
  };

  const result = shouldStop(state, conditions);
  assert.equal(result.stop, true);
  assert.equal(result.reason, "User cancelled");
});

test("shouldStop returns true when policy denied", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const conditions: StopConditions = {
    maxSteps: 10,
    budgetExhausted: false,
    policyDenied: true,
    authWallHit: false,
    userCancelled: false,
  };

  const result = shouldStop(state, conditions);
  assert.equal(result.stop, true);
  assert.equal(result.reason, "Policy denied further progress");
});

test("shouldStop returns true when auth wall hit", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const conditions: StopConditions = {
    maxSteps: 10,
    budgetExhausted: false,
    policyDenied: false,
    authWallHit: true,
    userCancelled: false,
  };

  const result = shouldStop(state, conditions);
  assert.equal(result.stop, true);
  assert.equal(result.reason, "Auth wall requires user assistance");
});

test("shouldStop returns true when budget exhausted", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const conditions: StopConditions = {
    maxSteps: 10,
    budgetExhausted: true,
    policyDenied: false,
    authWallHit: false,
    userCancelled: false,
  };

  const result = shouldStop(state, conditions);
  assert.equal(result.stop, true);
  assert.equal(result.reason, "Budget exhausted");
});

test("shouldStop returns true when max steps reached", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  state.stepCount = 10;
  const conditions: StopConditions = {
    maxSteps: 10,
    budgetExhausted: false,
    policyDenied: false,
    authWallHit: false,
    userCancelled: false,
  };

  const result = shouldStop(state, conditions);
  assert.equal(result.stop, true);
  assert.equal(result.reason, "Maximum steps reached");
});

test("shouldStop prioritizes user cancellation over other conditions", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const conditions: StopConditions = {
    maxSteps: 0,
    budgetExhausted: true,
    policyDenied: true,
    authWallHit: true,
    userCancelled: true,
  };

  const result = shouldStop(state, conditions);
  assert.equal(result.stop, true);
  assert.equal(result.reason, "User cancelled");
});

// ---------------------------------------------------------------------------
// executeStep — observe action
// ---------------------------------------------------------------------------

test("executeStep handles observe action", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine();

  const result = await executeStep(state, { kind: "observe", summary: "Look at page" }, provider, policy);

  assert.equal(result.policyDenied, false);
  assert.equal(result.state.stepCount, 1);
  assert.equal(result.state.events.length, 1);
  assert.equal(result.state.events[0]!.kind, "observation");
});

// ---------------------------------------------------------------------------
// executeStep — exec action
// ---------------------------------------------------------------------------

test("executeStep handles exec action with allowed policy", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine();

  const result = await executeStep(
    state,
    {
      kind: "exec",
      summary: "Click button",
      payload: { code: "document.querySelector('#btn').click()" },
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

test("executeStep handles exec action denied by policy", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine({
    check(actionId) {
      return {
        id: createId("policy"),
        actionId,
        result: "deny",
        reason: "Dangerous action",
      };
    },
  });

  const result = await executeStep(
    state,
    { kind: "exec", summary: "Delete everything" },
    provider,
    policy,
  );

  assert.equal(result.policyDenied, true);
  assert.equal(result.state.events.length, 1);
  assert.equal(result.state.events[0]!.kind, "policy-check");
  assert.equal(result.state.stepCount, 0);
});

test("executeStep handles exec action requiring approval", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine({
    check(actionId) {
      return {
        id: createId("policy"),
        actionId,
        result: "require-approval",
        reason: "Submit requires approval",
      };
    },
  });

  const result = await executeStep(
    state,
    { kind: "exec", summary: "Submit form", payload: { policyKind: "submit" } },
    provider,
    policy,
  );

  assert.equal(result.policyDenied, false);
  assert.ok(result.pendingApproval);
  assert.ok(result.pendingAction);
  // policy-check + approval-request = 2 events
  assert.equal(result.state.events.length, 2);
  assert.equal(result.state.events[1]!.kind, "approval-request");
  assert.equal(result.state.stepCount, 0);
});

// ---------------------------------------------------------------------------
// executeStep — finish action
// ---------------------------------------------------------------------------

test("executeStep handles finish action without events", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine();

  const result = await executeStep(state, { kind: "finish", summary: "Done" }, provider, policy);

  assert.equal(result.policyDenied, false);
  assert.equal(result.state.stepCount, 1);
  assert.equal(result.state.events.length, 0);
});

// ---------------------------------------------------------------------------
// executeStep — thought/default action
// ---------------------------------------------------------------------------

test("executeStep handles unknown action kind as thought-summary after policy check", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine();

  const result = await executeStep(
    state,
    { kind: "plan" as "observe", summary: "Thinking about next step" },
    provider,
    policy,
  );

  assert.equal(result.state.stepCount, 1);
  // Non-trivial actions now get a policy-check + the default thought-summary
  assert.equal(result.state.events.length, 2);
  assert.equal(result.state.events[0]!.kind, "policy-check");
  assert.equal(result.state.events[1]!.kind, "thought-summary");
});

test("defaultAgentTurn falls back to observe when LLM returns prose", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const turn = defaultAgentTurn({
    async chat() {
      return {
        content: "The title is probably Example Domain.",
        model: "test-model",
      };
    },
  });

  const action = await turn(state, provider);

  assert.equal(action.kind, "observe");
  assert.equal(action.summary, "Observe current browser state");
});

test("defaultAgentTurn parses raw JSON without code fences", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const turn = defaultAgentTurn({
    async chat() {
      return {
        content: '{"kind":"observe","summary":"Inspect page"}',
        model: "test-model",
      };
    },
  });

  const action = await turn(state, provider);

  assert.equal(action.kind, "observe");
  assert.equal(action.summary, "Inspect page");
});

// ---------------------------------------------------------------------------
// finalizeRun
// ---------------------------------------------------------------------------

test("finalizeRun classifies ambiguous run with no events", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  const result = finalizeRun(state);

  assert.equal(result.run.status, "failed");
  assert.equal(result.classification.kind, "ambiguous");
  assert.ok(result.outcomeSummary);
  assert.ok(result.run.finishedAt);
});

test("finalizeRun keeps task-mode observation-only runs as partial-success", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  // Add successful code execution events with observations (evidence)
  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-exec",
      payload: { code: "1+1" },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10 },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com", title: "Example" },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com/done", title: "Done" },
    },
  );

  const result = finalizeRun(state);

  assert.equal(result.run.status, "failed");
  assert.equal(result.run.result, undefined);
  assert.equal(result.classification.kind, "partial-success");
  assert.ok(result.outcomeSummary.includes("partial-success"));
});

test("finalizeRun persists final result from successful code output", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com", title: "Example" },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com/result", title: "Result" },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, stdout: "Final answer" },
    },
  );

  const result = finalizeRun(state);

  assert.equal(result.run.result, "Final answer");
});

test("finalizeRun persists final result from successful returnValue", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com", title: "Example" },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com/result", title: "Result" },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, returnValue: { answer: "Final answer", price: 29 } },
    },
  );

  const result = finalizeRun(state);

  assert.equal(result.run.result, '{"answer":"Final answer","price":29}');
});

test("finalizeRun does not persist finish summary as task result", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "thought-summary",
    payload: { summary: "Completed search for San Francisco and New York", kind: "finish" },
  });

  const result = finalizeRun(state);

  assert.equal(result.run.result, undefined);
  assert.equal(result.run.status, "failed");
});

test("finalizeRun persists finish summary for investigate mode", () => {
  const task = makeTask({ mode: "investigate" });
  const state = createLoopState(task, makeSessionId());

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "thought-summary",
    payload: { summary: "The failure reproduces after login", kind: "finish" },
  });

  const result = finalizeRun(state);

  assert.equal(result.run.result, "The failure reproduces after login");
});

test("finalizeRun classifies run with mixed results as partial-success", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10 },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: false, durationMs: 10 },
    },
  );

  const result = finalizeRun(state);

  assert.equal(result.classification.kind, "partial-success");
});

test("finalizeRun preserves all events", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "observation",
    payload: { url: "https://example.com" },
  });

  const result = finalizeRun(state);

  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]!.kind, "observation");
});

test("finalizeRun keeps pending approval runs open", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  const result = finalizeRun(state, { awaitingApproval: true });

  assert.equal(result.run.status, "awaiting-approval");
  assert.equal(result.run.finishedAt, undefined);
  assert.equal(result.classification.kind, "ambiguous");
});

test("executeTask proposes domain skill updates from reusable trace evidence", async () => {
  const task = makeTask({ objective: "Inspect example pricing" });
  const skillDir = await mkdtemp(join(tmpdir(), "wire-agent-skills-"));
  const sessionId = makeSessionId();
  let observeCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      return {
        sessionId: input.sessionId,
        url: observeCount === 1 ? "https://example.com" : "https://example.com/pricing",
        title: observeCount === 1 ? "Example" : "Pricing",
        tabs: [
          { id: "tab-1", title: "Example", url: "https://example.com", active: true },
        ],
      };
    },
    async exec(): Promise<BrowserExecResult> {
      return {
        ok: true,
        stdout: "ok",
        durationMs: 10,
      };
    },
    async stopSession() {},
  });
  const policy = createMockPolicyEngine();

  const mockLlmProvider = {
    async chat(messages: { content: string | import("../providers/llm/openai.js").ContentPart[] }[]) {
      const userMsg = messages.find((m) => typeof m.content === "string" && m.content.includes("[observation]"));
      if (userMsg) {
        return {
          content: JSON.stringify({
            hostname: "example.com",
            facts: ["Pricing page at /pricing"],
            selectors: [],
            routes: ["/pricing"],
            waits: [],
            traps: [],
            confidence: 0.8,
          }),
          model: "test-model",
        };
      }
      return { content: "NONE", model: "test-model" };
    },
  };

  try {
    const result = await executeTask(
      task,
      { provider, policyEngine: policy, maxSteps: 3, skillDir, llmProvider: mockLlmProvider },
      async (state) => {
        if (state.stepCount === 0) {
          return {
            kind: "exec",
            summary: "Use direct route",
            payload: { code: "window.location.href = 'https://example.com/pricing';" },
          };
        }
        if (state.stepCount === 1) {
          return { kind: "observe", summary: "Verify pricing route" };
        }
        return { kind: "finish", summary: "Done" };
      },
    );

    const proposal = result.events.find((event) => event.kind === "skill-proposal");
    assert.ok(proposal);
    assert.equal(proposal.payload.hostname, "example.com");
    assert.match(String(proposal.payload.proposal ?? ""), /hostnamePatterns/u);
    assert.equal(typeof proposal.payload.path, "string");
    const skillFile = await readFile(String(proposal.payload.path), "utf-8");
    assert.match(skillFile, /example\.com/u);
  } finally {
    await rm(skillDir, { recursive: true, force: true });
  }
});

test("executeTask loads matched skills into the live agent prompt", async () => {
  const task = makeTask({ objective: "Inspect example pricing" });
  const skillDir = await mkdtemp(join(tmpdir(), "wire-agent-skills-"));
  const sessionId = makeSessionId();
  let capturedUserPrompt = "";
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      return {
        sessionId: input.sessionId,
        url: "https://example.com/pricing",
        title: "Pricing",
        tabs: [
          { id: "tab-1", title: "Pricing", url: "https://example.com/pricing", active: true },
        ],
      };
    },
    async stopSession() {},
  });

  const skillContent = [
    "---",
    `id: ${createId("skill")}`,
    "scope: domain",
    "hostnamePatterns:",
    "  - example.com",
    "tags:",
    "  - pricing",
    "updatedAt: 2026-04-24",
    "source: team",
    "---",
    "",
    "## Facts",
    "Use /pricing directly when the site supports it.",
  ].join("\n");

  await writeFile(join(skillDir, "example.md"), skillContent, "utf-8");

  const llmProvider = {
    async chat(messages: { role: string; content: string | import("../providers/llm/openai.js").ContentPart[] }[]) {
      const raw = messages.find((message) => message.role === "user")?.content ?? "";
      const userPrompt = typeof raw === "string" ? raw : raw.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
      if (userPrompt.includes("Loaded skills:")) {
        capturedUserPrompt = userPrompt;
        return {
          content: JSON.stringify({ kind: "finish", summary: "Done" }),
          model: "test-model",
        };
      }
      return {
        content: "NONE",
        model: "test-model",
      };
    },
  };

  try {
    await executeTask(
      task,
      { provider, policyEngine: createMockPolicyEngine(), maxSteps: 2, skillDir, llmProvider },
    );
    assert.match(capturedUserPrompt, /Loaded skills:/u);
    assert.match(capturedUserPrompt, /Use \/pricing directly/u);
  } finally {
    await rm(skillDir, { recursive: true, force: true });
  }
});

test("executeTask persists a task note artifact when finishing without extracted output", async () => {
  const task = makeTask({ objective: "Search Booking.com" });
  const sessionId = makeSessionId();
  let observeCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      return {
        sessionId: input.sessionId,
        url: observeCount === 1
          ? "https://www.booking.com"
          : "https://www.booking.com/searchresults.html?ss=New%20York",
        title: observeCount === 1 ? "Booking.com" : "Search results",
        tabs: [
          { id: "tab-1", title: "Booking.com", url: "https://www.booking.com", active: true },
        ],
      };
    },
    async exec(): Promise<BrowserExecResult> {
      return {
        ok: true,
        durationMs: 10,
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 3 },
    async (state) => {
      if (state.stepCount === 0) {
        return {
          kind: "exec",
          summary: "Open search results",
          payload: { code: "window.location.href = 'https://www.booking.com/searchresults.html?ss=New%20York';" },
        };
      }
      return { kind: "finish", summary: "Completed search for New York" };
    },
  );

  assert.equal(result.run.status, "failed");
  assert.equal(result.classification.kind, "partial-success");
  const noteArtifact = result.events.find((event) =>
    event.kind === "artifact" &&
    event.payload.kind === "task-summary" &&
    typeof event.payload.content === "string"
  );
  assert.ok(noteArtifact);
  assert.match(String(noteArtifact.payload.content ?? ""), /URL: https:\/\/www\.booking\.com/u);
});

test("executeTask forces a generic extraction pass before finishing task mode", async () => {
  const task = makeTask({ objective: "Extract booking results" });
  const sessionId = makeSessionId();
  let execCount = 0;
  let observeCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      return {
        sessionId: input.sessionId,
        url: `https://example.com/obs-${observeCount}`,
        title: `Observation ${observeCount}`,
        tabs: [],
      };
    },
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      execCount++;
      if (execCount === 1) {
        return { ok: true, durationMs: 10 };
      }
      assert.match(input.code, /wire:extract/u);
      return {
        ok: true,
        durationMs: 10,
        returnValue: {
          title: "Booking.com results",
          cards: [{ title: "Hotel One", prices: ["$199"] }],
        },
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 4 },
    async (state) => {
      if (state.stepCount === 0) {
        return {
          kind: "exec",
          summary: "Navigate to results",
          payload: { code: "window.location.href = 'https://www.booking.com/searchresults.html';" },
        };
      }
      return { kind: "finish", summary: "Done" };
    },
  );

  assert.equal(execCount, 2);
  assert.equal(result.run.status, "succeeded");
  assert.match(result.run.result ?? "", /"Hotel One"/u);
  const artifactEvent = result.events.find((event) =>
    event.kind === "artifact" && event.payload.kind === "json-output"
  );
  assert.ok(artifactEvent);
  assert.match(String(artifactEvent.payload.content ?? ""), /"Hotel One"/u);
});

test("executeTask streams trace events to an optional sink", async () => {
  const task = makeTask({ objective: "Observe and finish" });
  const sessionId = makeSessionId();
  const streamed: TraceEvent[] = [];
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    {
      provider,
      policyEngine: createMockPolicyEngine(),
      maxSteps: 2,
      traceSink: {
        onEvent(event) {
          streamed.push(event);
        },
      },
    },
    async () => ({ kind: "finish", summary: "Done" }),
  );

  assert.ok(streamed.length > 0);
  assert.equal(streamed.length, result.events.length);
  assert.equal(streamed[0]!.kind, "observation");
});

test("executeTask retries after a recoverable step error when budget remains", async () => {
  const task = makeTask({ objective: "Recover from transient browser error" });
  const sessionId = makeSessionId();
  let execCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async exec(): Promise<BrowserExecResult> {
      execCount++;
      if (execCount === 1) {
        throw new Error("Target not found: page");
      }
      return {
        ok: true,
        stdout: "Recovered answer",
        durationMs: 10,
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 3 },
    async (state) => {
      const hasRecoveredAnswer = state.events.some((event) =>
        event.kind === "code-result" && event.payload.stdout === "Recovered answer"
      );
      if (hasRecoveredAnswer) {
        return { kind: "finish", summary: "Recovered answer" };
      }
      if (state.stepCount === 0) {
        return { kind: "exec", summary: "First try", payload: { code: "1" } };
      }
      return { kind: "exec", summary: "Retry after error", payload: { code: "2" } };
    },
  );

  assert.equal(execCount, 2);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.result, "Recovered answer");
});

test("executeTask persists failure note artifact for task runs that stop on error", async () => {
  const task = makeTask({ objective: "Search booking.com" });
  const sessionId = makeSessionId();
  let observeCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      return {
        sessionId: input.sessionId,
        url: observeCount === 1 ? "about:blank" : "https://www.booking.com/searchresults.html?ss=San+Francisco",
        title: observeCount === 1 ? "about:blank" : "Booking.com search results",
        tabs: [
          {
            id: "tab-1",
            title: "Booking.com",
            url: "https://www.booking.com/searchresults.html?ss=San+Francisco",
            active: true,
          },
        ],
      };
    },
    async exec(): Promise<BrowserExecResult> {
      return {
        ok: true,
        durationMs: 10,
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 2 },
    async (state) => {
      if (state.stepCount === 0) {
        return { kind: "observe", summary: "Check booking results" };
      }
      throw new Error("Target not found: page");
    },
  );

  assert.equal(result.run.status, "failed");
  assert.match(result.run.result ?? "", /Run stopped with error: Target not found: page/u);
  const noteArtifact = result.events.find((event) =>
    event.kind === "artifact" &&
    event.payload.kind === "task-summary" &&
    typeof event.payload.content === "string"
  );
  assert.ok(noteArtifact);
  assert.match(String(noteArtifact.payload.content ?? ""), /Reached Booking\.com search results/u);
});

// ---------------------------------------------------------------------------
// classifyRun — detailed tests (T013)
// ---------------------------------------------------------------------------

test("classifyRun returns task-complete for all-successful code execs with observations", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com", title: "Example" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com/done", title: "Done" },
    },
  ];

  const result = classifyRun({
    mode: "investigate",
    events,
    successCriteria: ["Task completed"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "task-complete");
  assert.ok(result.confidence >= 0.8);
});

test("classifyRun does not return task-complete when the latest evidence is missing", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://steel.dev/pricing", title: "Pricing" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10 },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: ["Pricing captured"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "partial-success");
  assert.match(result.notes?.[0] ?? "", /did not record a final answer or artifact/i);
});

test("classifyRun returns task-complete when the final exec extracts an answer", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://steel.dev/pricing", title: "Pricing" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://steel.dev/pricing", title: "Pricing" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, stdout: "{\"plans\":[\"...\"]}" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: ["Pricing captured"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "task-complete");
});

test("classifyRun returns partial-success for code success with no evidence", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: ["Task completed"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "partial-success");
  assert.ok(result.notes?.some((n) => /did not record a final answer or artifact/i.test(n)));
});

test("classifyRun returns ambiguous when awaiting approval", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
    awaitingApproval: true,
  });

  assert.equal(result.kind, "ambiguous");
  assert.match(result.notes?.[0] ?? "", /Awaiting human approval/);
});

test("classifyRun returns partial-success for mixed results", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: false },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "partial-success");
  assert.ok(result.notes);
  assert.ok(result.notes!.length > 0);
});

test("classifyRun returns blocked-auth when auth wall hit", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 0,
    authWallHit: true,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "blocked-auth");
  assert.ok(result.confidence >= 0.9);
});

test("classifyRun returns agent-error when policy denied", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: true,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "agent-error");
});

test("classifyRun returns ambiguous when budget exhausted", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: true,
  });

  assert.equal(result.kind, "ambiguous");
});

test("classifyRun returns infra-error for network failures", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { code: "ECONNREFUSED", message: "Connection refused" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 1,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "infra-error");
});

test("classifyRun returns site-error for all-failed code execs", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: false },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "site-error");
});

test("classifyRun returns ambiguous for empty events", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "ambiguous");
  assert.ok(result.confidence < 0.5);
});

test("classifyRun returns agent-error for high error count", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 10,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "agent-error");
});

// ---------------------------------------------------------------------------
// generateOutcomeSummary
// ---------------------------------------------------------------------------

test("generateOutcomeSummary includes classification and confidence", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-exec",
      payload: { code: "1+1" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com" },
    },
  ];

  const summary = generateOutcomeSummary(
    { kind: "task-complete", confidence: 0.9 },
    events,
  );

  assert.ok(summary.includes("task-complete"));
  assert.ok(summary.includes("0.9"));
  assert.ok(summary.includes("1 code executions"));
  assert.ok(summary.includes("1 observations"));
});

test("generateOutcomeSummary includes notes when present", () => {
  const summary = generateOutcomeSummary(
    { kind: "ambiguous", confidence: 0.5, notes: ["No evidence", "Budget left"] },
    [],
  );

  assert.ok(summary.includes("No evidence"));
  assert.ok(summary.includes("Budget left"));
});

test("generateOutcomeSummary includes error count", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { message: "Failed" },
    },
  ];

  const summary = generateOutcomeSummary({ kind: "agent-error", confidence: 0.7 }, events);

  assert.ok(summary.includes("Errors: 1"));
});

// ---------------------------------------------------------------------------
// executeStep — raw CDP action policy gate
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

test("classifyRun returns infra-error when session crash is detected", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { message: "Session crashed unexpectedly", code: "session_crash" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 1,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "infra-error");
  assert.ok(result.confidence >= 0.8);
});

test("classifyRun returns blocked-auth when captcha indicators are present", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com/recaptcha", title: "Recaptcha Challenge" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "blocked-auth");
  assert.ok(result.confidence >= 0.7);
});

test("classifyRun returns site-error when 429 error is detected", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { message: "429 Too Many Requests", code: "HTTP429" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 1,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "site-error");
  assert.ok(result.confidence >= 0.8);
});

test("classifyRun returns infra-error when ETIMEDOUT is detected", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { message: "connection timed out", code: "ETIMEDOUT" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 1,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(result.kind, "infra-error");
  assert.ok(result.confidence >= 0.8);
});

// ---------------------------------------------------------------------------
// tryParseAction — malformed LLM payload rejection
// ---------------------------------------------------------------------------

test("defaultAgentTurn rejects LLM payload with missing kind", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const turn = defaultAgentTurn({
    async chat() {
      return {
        content: '{"summary":"Do something","payload":{}}',
        model: "test-model",
      };
    },
  });

  const action = await turn(state, provider);

  // Missing kind should fall back to observe (no prior observation) or finish
  assert.ok(action.kind === "observe" || action.kind === "finish");
});

test("defaultAgentTurn rejects LLM payload with unknown kind", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const turn = defaultAgentTurn({
    async chat() {
      return {
        content: '{"kind":"unknown-action","summary":"Do something"}',
        model: "test-model",
      };
    },
  });

  const action = await turn(state, provider);

  assert.ok(action.kind === "observe" || action.kind === "finish");
});

test("defaultAgentTurn rejects non-object LLM payload (bare function string)", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const turn = defaultAgentTurn({
    async chat() {
      return {
        content: 'function() { return "malicious"; }',
        model: "test-model",
      };
    },
  });

  const action = await turn(state, provider);

  assert.ok(action.kind === "observe" || action.kind === "finish");
});

test("defaultAgentTurn rejects array LLM payload", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const turn = defaultAgentTurn({
    async chat() {
      return {
        content: '[{"kind":"observe","summary":"Array payload"}]',
        model: "test-model",
      };
    },
  });

  const action = await turn(state, provider);

  assert.ok(action.kind === "observe" || action.kind === "finish");
});

// ---------------------------------------------------------------------------
// executeStep — wireActions from exec returnValue
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

// ---------------------------------------------------------------------------
// isNavigationOnlyResult
// ---------------------------------------------------------------------------

test("isNavigationOnlyResult identifies navigation-only return values", () => {
  const makeEvent = (returnValue: JsonValue): TraceEvent => ({
    id: createId("event"),
    runId: "run_test" as never,
    ts: new Date().toISOString(),
    kind: "code-result" as const,
    payload: { ok: true, returnValue, durationMs: 10 },
  });

  assert.equal(isNavigationOnlyResult(makeEvent({ navigatedTo: "https://weather.com" })), true);
  assert.equal(isNavigationOnlyResult(makeEvent({ navigated: true })), true);
  assert.equal(isNavigationOnlyResult(makeEvent({ url: "https://example.com", redirected: "https://other.com" })), true);
  assert.equal(isNavigationOnlyResult(makeEvent({ temperature: "43°F" })), false);
  assert.equal(isNavigationOnlyResult(makeEvent({ navigatedTo: "https://weather.com", temperature: "43°F" })), false);
  assert.equal(isNavigationOnlyResult(makeEvent("just a string")), false);
  assert.equal(isNavigationOnlyResult(makeEvent(null)), false);
});

// ---------------------------------------------------------------------------
// hasPostNavigationExtraction
// ---------------------------------------------------------------------------

test("hasPostNavigationExtraction returns true when no navigation occurred", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  state.events.push(
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-exec", payload: { code: "return document.title" } },
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-result", payload: { ok: true, stdout: "My Page", durationMs: 10 } },
  );
  assert.equal(hasPostNavigationExtraction(state), true);
});

test("hasPostNavigationExtraction returns false after navigation with no extraction", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  state.events.push(
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-exec", payload: { code: "window.location.href='https://weather.com'; return {navigatedTo:'https://weather.com'}" } },
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-result", payload: { ok: true, returnValue: { navigatedTo: "https://weather.com" }, durationMs: 10 } },
  );
  assert.equal(hasPostNavigationExtraction(state), false);
});

test("hasPostNavigationExtraction returns true after navigation + real extraction", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  state.events.push(
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-exec", payload: { code: "window.location.href='https://weather.com'" } },
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-result", payload: { ok: true, returnValue: { navigated: true }, durationMs: 10 } },
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-exec", payload: { code: "return { temp: document.querySelector('.temp').textContent }" } },
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-result", payload: { ok: true, returnValue: { temp: "43°F" }, durationMs: 10 } },
  );
  assert.equal(hasPostNavigationExtraction(state), true);
});

// ---------------------------------------------------------------------------
// Extraction guard in executeTask
// ---------------------------------------------------------------------------

test("executeTask forces verification when agent finishes after navigation-only code", async () => {
  const task = makeTask({ objective: "Get NYC temperature" });
  const sessionId = makeSessionId();
  let execCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      execCount++;
      return { ok: true, returnValue: { navigatedTo: "https://weather.com" }, durationMs: 10 };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 5 },
    async (state) => {
      if (state.stepCount === 0) {
        return { kind: "exec", summary: "Navigate", payload: { code: "window.location.href='https://weather.com'; return {navigatedTo:'https://weather.com'}" } };
      }
      return { kind: "finish", summary: "Temperature found" };
    },
  );

  // Agent should have been forced to run verification, not allowed to finish immediately
  assert.ok(execCount >= 2, `expected execCount >= 2, got ${execCount}`);
  const codeExecs = result.events.filter((e) => e.kind === "code-exec");
  assert.ok(codeExecs.length >= 2, "should have at least 2 code-exec events (navigate + verify)");
});

// ---------------------------------------------------------------------------
// executeStep — reconfigure action
// ---------------------------------------------------------------------------

test("executeStep reconfigure creates new session, stops old, updates state", async () => {
  const task = makeTask();
  const oldSessionId = makeSessionId();
  const newSessionId = makeSessionId();
  const state = createLoopState(task, oldSessionId);

  let createdSessionInput: import("../shared/types.js").CreateSessionInput | undefined;
  let stoppedSessionId: SessionId | undefined;

  const provider = createMockProvider({
    async createSession(input) {
      createdSessionInput = input;
      return {
        id: newSessionId,
        provider: "steel",
        createdAt: new Date().toISOString(),
        status: "ready",
        liveUrl: "https://viewer.steel.dev/new-session",
        profileId: "profile_test" as never,
      } satisfies BrowserSession;
    },
    async stopSession(id) {
      stoppedSessionId = id;
    },
  });
  const policy = createMockPolicyEngine();

  // Register reconfigure handler in the action registry
  const registry = new ActionRegistry();
  registry.register({
    kind: "reconfigure",
    description: "test reconfigure",
    async execute(s, action, prov) {
      const requested = action.payload as import("../shared/types.js").JsonObject | undefined;
      const merged: Record<string, unknown> = { ...s.sessionConfig };
      if (requested?.useProxy !== undefined) merged.useProxy = Boolean(requested.useProxy);
      if (requested?.solveCaptcha !== undefined) merged.solveCaptcha = Boolean(requested.solveCaptcha);
      if (typeof requested?.userAgent === "string") merged.userAgent = requested.userAgent;
      if (typeof requested?.region === "string") merged.region = requested.region;

      const oldSid = s.sessionId;
      const input: import("../shared/types.js").CreateSessionInput = { sessionConfig: merged };
      if (s.profileId) input.profileId = s.profileId;
      const newSession = await prov.createSession(input);
      try { await prov.stopSession(oldSid); } catch { /* best-effort */ }

      s.sessionId = newSession.id;
      s.sessionConfig = merged;
      if (newSession.liveUrl) s.sessionLiveUrl = newSession.liveUrl;
      if (newSession.profileId) s.profileId = newSession.profileId;

      s.events.push({
        id: createId("event"),
        runId: s.run.id,
        ts: new Date().toISOString(),
        kind: "thought-summary",
        payload: { summary: action.summary, kind: "reconfigure", oldSessionId: oldSid, newSessionId: newSession.id, config: merged as import("../shared/types.js").JsonObject },
      });

      const observation = await prov.observe({ sessionId: s.sessionId });
      s.events.push({
        id: createId("event"),
        runId: s.run.id,
        ts: new Date().toISOString(),
        kind: "observation",
        payload: { url: observation.url, title: observation.title },
      });
      return {};
    },
  });

  const result = await executeStep(
    state,
    {
      kind: "reconfigure",
      summary: "Enable proxy and captcha solver",
      payload: { useProxy: true, solveCaptcha: true },
    },
    provider,
    policy,
    { actionRegistry: registry },
  );

  assert.equal(result.policyDenied, false);
  assert.equal(result.state.sessionId, newSessionId, "sessionId should be updated");
  assert.equal(result.state.sessionLiveUrl, "https://viewer.steel.dev/new-session");
  assert.equal(result.state.sessionConfig?.useProxy, true);
  assert.equal(result.state.sessionConfig?.solveCaptcha, true);
  assert.equal(stoppedSessionId, oldSessionId, "old session should be stopped");

  // Check session config was passed to createSession
  assert.ok(createdSessionInput);
  assert.equal(createdSessionInput!.sessionConfig?.useProxy, true);
  assert.equal(createdSessionInput!.sessionConfig?.solveCaptcha, true);

  // Trace events: thought-summary (reconfigure), observation (auto-observe)
  const events = result.state.events;
  const reconfigureEvent = events.find((e) => e.kind === "thought-summary" && e.payload.kind === "reconfigure");
  assert.ok(reconfigureEvent, "should have a reconfigure trace event");
  assert.equal(reconfigureEvent!.payload.oldSessionId, oldSessionId);
  assert.equal(reconfigureEvent!.payload.newSessionId, newSessionId);

  // Auto-observation
  const observations = events.filter((e) => e.kind === "observation");
  assert.ok(observations.length >= 1, "should auto-observe new session");

  assert.equal(result.state.stepCount, 1);
});

test("executeStep reconfigure merges with existing sessionConfig", async () => {
  const task = makeTask();
  const oldSessionId = makeSessionId();
  const newSessionId = makeSessionId();
  const state = createLoopState(task, oldSessionId, undefined, {
    sessionConfig: { useProxy: true, region: "us-east-1" },
  });

  let createdSessionInput: import("../shared/types.js").CreateSessionInput | undefined;
  const provider = createMockProvider({
    async createSession(input) {
      createdSessionInput = input;
      return {
        id: newSessionId,
        provider: "steel",
        createdAt: new Date().toISOString(),
        status: "ready",
      } satisfies BrowserSession;
    },
    async stopSession() {},
  });
  const policy = createMockPolicyEngine();

  // Register reconfigure handler in the action registry
  const registry = new ActionRegistry();
  registry.register({
    kind: "reconfigure",
    description: "test reconfigure",
    async execute(s, action, prov) {
      const requested = action.payload as import("../shared/types.js").JsonObject | undefined;
      const merged: Record<string, unknown> = { ...s.sessionConfig };
      if (requested?.useProxy !== undefined) merged.useProxy = Boolean(requested.useProxy);
      if (requested?.solveCaptcha !== undefined) merged.solveCaptcha = Boolean(requested.solveCaptcha);
      if (typeof requested?.userAgent === "string") merged.userAgent = requested.userAgent;
      if (typeof requested?.region === "string") merged.region = requested.region;

      const oldSid = s.sessionId;
      const input: import("../shared/types.js").CreateSessionInput = { sessionConfig: merged };
      if (s.profileId) input.profileId = s.profileId;
      const newSession = await prov.createSession(input);
      try { await prov.stopSession(oldSid); } catch { /* best-effort */ }

      s.sessionId = newSession.id;
      s.sessionConfig = merged;
      if (newSession.liveUrl) s.sessionLiveUrl = newSession.liveUrl;

      s.events.push({
        id: createId("event"),
        runId: s.run.id,
        ts: new Date().toISOString(),
        kind: "thought-summary",
        payload: { summary: action.summary, kind: "reconfigure", config: merged as import("../shared/types.js").JsonObject },
      });
      return {};
    },
  });

  const result = await executeStep(
    state,
    {
      kind: "reconfigure",
      summary: "Enable captcha solver",
      payload: { solveCaptcha: true },
    },
    provider,
    policy,
    { actionRegistry: registry },
  );

  // Should merge: useProxy from initial + solveCaptcha from reconfigure
  assert.equal(result.state.sessionConfig?.useProxy, true, "useProxy should persist from initial config");
  assert.equal(result.state.sessionConfig?.solveCaptcha, true, "solveCaptcha should be added from reconfigure");
  assert.equal(result.state.sessionConfig?.region, "us-east-1", "region should persist from initial config");

  // Verify merged config was sent to createSession
  assert.equal(createdSessionInput!.sessionConfig?.useProxy, true);
  assert.equal(createdSessionInput!.sessionConfig?.solveCaptcha, true);
  assert.equal(createdSessionInput!.sessionConfig?.region, "us-east-1");
});
