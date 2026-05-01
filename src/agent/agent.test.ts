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
} from "./loop.js";
import type { LoopState, StopConditions } from "./loop.js";
import { ActionRegistry } from "./actions.js";
import {
  isNavigationOnlyResult,
  hasPostNavigationExtraction,
  isRecoverableStepError,
  computeRepeatStreak,
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
  let execInput: BrowserExecRequest | undefined;
  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      execInput = input;
      return { ok: true, stdout: "ok", durationMs: 10 };
    },
  });
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
  assert.equal(execInput?.timeoutMs, 12_000);
});

test("executeStep caps requested exec timeout", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  let execInput: BrowserExecRequest | undefined;
  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      execInput = input;
      return { ok: true, stdout: "ok", durationMs: 10 };
    },
  });

  await executeStep(
    state,
    { kind: "exec", summary: "Slow read", payload: { code: "return 1", timeoutMs: 60_000 } },
    provider,
    createMockPolicyEngine(),
  );

  assert.equal(execInput?.timeoutMs, 12_000);
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

test("approval requests carry proposed code, risk, and reason", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine({
    check(actionId) {
      return {
        id: createId("policy"),
        actionId,
        result: "require-approval",
        reason: "Matched rules: baseline-exec-risk-mutation",
      };
    },
  });

  const result = await executeStep(
    state,
    {
      kind: "exec",
      summary: "Probe API",
      payload: { code: "return fetch('/api/items', { method: 'POST', body: '{}' })" },
    },
    provider,
    policy,
  );

  assert.ok(result.pendingApproval);
  const detail = result.pendingApproval!.proposedAction;
  assert.ok(detail, "proposedAction should be populated");
  assert.equal(detail!.kind, "exec");
  assert.equal(detail!.riskKind, "unknown-mutation");
  assert.equal(detail!.reason, "Matched rules: baseline-exec-risk-mutation");
  assert.match(detail!.codeExcerpt ?? "", /method: 'POST'/u);
  // Approval-request event mirrors the detail.
  const approvalEvent = result.state.events.find((e) => e.kind === "approval-request");
  assert.ok(approvalEvent);
  const eventDetail = approvalEvent!.payload.proposedAction as Record<string, unknown> | undefined;
  assert.equal(eventDetail?.riskKind, "unknown-mutation");
});

test("approval request truncates very long code excerpts", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine({
    check(actionId) {
      return { id: createId("policy"), actionId, result: "require-approval" };
    },
  });

  const longCode = "// padding\n".repeat(300) + "fetch('/x', { method: 'POST' })";
  const result = await executeStep(
    state,
    { kind: "exec", summary: "Big code", payload: { code: longCode } },
    provider,
    policy,
  );

  const detail = result.pendingApproval!.proposedAction;
  assert.equal(detail?.truncated, true);
  assert.ok((detail?.codeExcerpt?.length ?? 0) <= 2000);
});

test("resumeTask executes an approved pending action without re-requesting approval", async () => {
  const task = makeTask({ objective: "Submit approved form" });
  const sessionId = makeSessionId();
  let execCount = 0;
  let policyChecks = 0;
  const provider = createMockProvider({
    async createSession(): Promise<BrowserSession> {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async exec(): Promise<BrowserExecResult> {
      execCount++;
      return { ok: true, stdout: "approved done", durationMs: 10 };
    },
    async stopSession() {},
  });
  const policy = createMockPolicyEngine({
    check(actionId) {
      policyChecks++;
      return {
        id: createId("policy"),
        actionId,
        result: "require-approval",
        reason: "Submit requires approval",
      };
    },
  });

  const first = await executeTask(
    task,
    { provider, policyEngine: policy, maxSteps: 3 },
    async () => ({ kind: "exec", summary: "Submit form", payload: { policyKind: "submit", code: "return 'submitted'" } }),
  );

  assert.ok(first.pendingApproval);
  assert.ok(first.pendingAction);
  assert.equal(execCount, 0);
  assert.equal(policyChecks, 1);

  const checkpoint: RunCheckpoint = {
    runId: first.run.id,
    task,
    run: first.run,
    sessionId: first.sessionId,
    events: first.events,
    stepCount: first.stepCount,
    startedAt: first.startedAt,
    pendingAction: first.pendingAction,
    approvalRequestId: first.pendingApproval.id,
    savedAt: new Date().toISOString(),
  };

  const resumed = await resumeTask(
    checkpoint,
    { provider, policyEngine: policy, maxSteps: 3 },
    async () => ({ kind: "finish", summary: "Done" }),
  );

  assert.equal(execCount, 1);
  assert.equal(policyChecks, 1, "approved action should not re-run policy");
  assert.equal(resumed.pendingApproval, undefined);
  assert.equal(resumed.run.result, "approved done");
  assert.equal(
    resumed.events.filter((event) => event.kind === "approval-request").length,
    1,
    "resume should not add another approval request",
  );
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
    model: "test-model",
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
    model: "test-model",
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

test("defaultAgentTurn includes metacognition warnings in prompt", async () => {
  const state = createLoopState(makeTask(), makeSessionId());
  let prompt = "";
  state.events.push(
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-exec", payload: { code: "return wait()" } },
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-exec", payload: { code: "return wait()" } },
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "error", payload: { message: "CDP command timed out after 12000ms: Runtime.evaluate" } },
  );
  const turn = defaultAgentTurn({ model: "test-model", async chat(messages) {
    prompt = String(messages.find((m) => m.role === "user")?.content ?? "");
    return { content: '{"kind":"observe","summary":"Retry differently"}', model: "test-model" };
  } });

  await turn(state, createMockProvider());

  assert.match(prompt, /identical exec code was tried 2 times/u);
  assert.match(prompt, /Reactive constraint/u);
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

test("finalizeRun skips error-shaped returnValue when picking final result", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, returnValue: { score: 4668, title: "2048" } },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 8, returnValue: { error: "Start Bot not found", buttons: ["a", "b"] } },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 5, returnValue: { clicked: false, reason: "no match" } },
    },
  );

  const result = finalizeRun(state);
  assert.ok(result.run.result, "expected a derived result");
  assert.ok(!result.run.result!.includes("Start Bot not found"), `expected error-shaped result to be skipped: ${result.run.result}`);
  assert.ok(result.run.result!.includes("4668"), `expected to pick the meaningful earlier result: ${result.run.result}`);
});

test("finalizeRun falls back to error-shaped result when nothing better exists", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "code-result",
    payload: { ok: true, durationMs: 5, returnValue: { error: "Only error" } },
  });

  const result = finalizeRun(state);
  assert.ok(result.run.result?.includes("Only error"), `expected error-shaped fallback: ${result.run.result}`);
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
    model: "test-model",
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
    model: "test-model",
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
    event.payload.kind === "note" &&
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

test("executeTask blocks finish until numeric objective evidence is present", async () => {
  const task = makeTask({ objective: "play 2048 and refresh for new game 5 times" });
  const sessionId = makeSessionId();
  let execCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      execCount++;
      return {
        ok: true,
        durationMs: 10,
        returnValue: execCount === 1
          ? { score: 68, runs: [{ run: 1, score: 68 }] }
          : { game: "2048", runs: [1, 2, 3, 4, 5].map((run) => ({ run, score: run * 10 })) },
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 4 },
    async (state) => state.stepCount === 0
      ? { kind: "exec", summary: "Play once", payload: { code: "return score" } }
      : { kind: "finish", summary: "Done" },
  );

  assert.equal(execCount, 2);
  assert.equal(result.run.status, "succeeded");
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

test("executeTask leaves browser session open when requested", async () => {
  const task = makeTask({ objective: "Keep session open" });
  const sessionId = makeSessionId();
  let stopped = false;
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async stopSession() {
      stopped = true;
    },
  });

  await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 1, keepSessionOpen: true },
    async () => ({ kind: "finish", summary: "Done" }),
  );

  assert.equal(stopped, false);
});

test("executeTask retries after a recoverable step error when budget remains", async () => {
  const task = makeTask({ objective: "Recover from transient browser error" });
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
        url: "https://example.com/recovered",
        title: "Recovered",
        tabs: [],
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
  assert.equal(observeCount, 2);
  assert.equal(result.run.status, "succeeded");
  assert.equal(result.run.result, "Recovered answer");
});

test("isRecoverableStepError treats transient WebSocket failures as recoverable", () => {
  assert.equal(isRecoverableStepError("WebSocket error"), true);
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
    event.payload.kind === "note" &&
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
    model: "test-model",
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
    model: "test-model",
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
    model: "test-model",
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
    model: "test-model",
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
// isNoProgressResult
// ---------------------------------------------------------------------------

test("isNoProgressResult flags empty/nav-only/error-shaped successful results", async () => {
  const { isNoProgressResult } = await import("./state-helpers.js");
  const make = (payload: Record<string, unknown>): TraceEvent => ({
    id: createId("event"),
    runId: "run_test" as never,
    ts: new Date().toISOString(),
    kind: "code-result" as const,
    payload: { ok: true, durationMs: 10, ...payload },
  });

  assert.equal(isNoProgressResult(make({})), true, "empty payload");
  assert.equal(isNoProgressResult(make({ returnValue: {} })), true, "empty object");
  assert.equal(isNoProgressResult(make({ returnValue: [] })), true, "empty array");
  assert.equal(isNoProgressResult(make({ returnValue: "" })), true, "empty string");
  assert.equal(isNoProgressResult(make({ returnValue: null })), true, "null");
  assert.equal(isNoProgressResult(make({ returnValue: { navigatedTo: "https://x.com" } })), true, "nav-only");
  assert.equal(isNoProgressResult(make({ returnValue: { error: "not found" } })), true, "error-only");
  assert.equal(isNoProgressResult(make({ returnValue: { temperature: "43°F" } })), false, "real data");
  assert.equal(isNoProgressResult(make({ stdout: "real text" })), false, "stdout text");
  assert.equal(
    isNoProgressResult({ ...make({ returnValue: {} }), payload: { ok: false, durationMs: 10 } } as TraceEvent),
    false,
    "failed result is not no-progress",
  );
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

test("executeTask aborts when same exec succeeds with same return value repeatedly", async () => {
  const task = makeTask({ objective: "Test stuck-on-success guard" });
  const sessionId = makeSessionId();
  const stuckCode = "return { score: null, best: null };";
  let execCallCount = 0;
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
      execCallCount++;
      return {
        ok: true,
        durationMs: 10,
        returnValue: { score: null, best: null },
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 30 },
    async () => ({
      kind: "exec",
      summary: "Probe with no progress",
      payload: { code: stuckCode },
    }),
  );

  // STUCK_THRESHOLD=3 means we bail on the 5th identical attempt.
  assert.ok(execCallCount <= 6, `expected the loop to bail before maxSteps, got ${execCallCount} exec calls`);

  const stopReason = result.events.find((e) =>
    e.kind === "thought-summary" &&
    typeof e.payload["reason"] === "string" &&
    /returned the same result/iu.test(e.payload["reason"] as string),
  );
  assert.ok(stopReason, "expected a stuck-on-success stop reason");
});

test("executeTask aborts when same exec sig repeats with cosmetically varying results", async () => {
  // Reproduces the slow-stuck case: same probe code, return value differs in
  // small ways each time (added field, renamed field) but the agent isn't
  // making real progress. Digest matching keeps resetting; sig-only backstop
  // must catch it.
  const task = makeTask({ objective: "Test sig-only backstop" });
  const sessionId = makeSessionId();
  let execCallCount = 0;
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
      execCallCount++;
      // Vary one field per call so the digest keeps changing
      return {
        ok: true,
        durationMs: 10,
        returnValue: {
          score: null,
          best: null,
          probeId: execCallCount,
          [`field${execCallCount}`]: true,
        },
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 30 },
    async () => ({
      kind: "exec",
      summary: "Probe with cosmetic variation",
      payload: { code: "return probeStuff()" },
    }),
  );

  // SIG_ONLY_THRESHOLD=6 → bail on the 7th attempt (8th call would not happen).
  assert.ok(execCallCount <= 8, `expected sig-only backstop to bail, got ${execCallCount} exec calls`);

  const stopReason = result.events.find((e) =>
    e.kind === "thought-summary" &&
    typeof e.payload["reason"] === "string" &&
    /attempted .+ times in a row/iu.test(e.payload["reason"] as string),
  );
  assert.ok(stopReason, "expected a sig-only stop reason");
});

test("executeTask does not bail when same code returns different results", async () => {
  const task = makeTask({ objective: "Test stuck guard does not false-positive on progress" });
  const sessionId = makeSessionId();
  let execCallCount = 0;
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
      execCallCount++;
      return {
        ok: true,
        durationMs: 10,
        returnValue: { i: execCallCount },
      };
    },
    async stopSession() {},
  });

  await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 8 },
    async () => ({
      kind: "exec",
      summary: "Probe that progresses",
      payload: { code: "return { i: progress }" },
    }),
  );

  // Same action sig but each result is unique → counter should reset every turn
  assert.ok(execCallCount >= 7, `expected the loop to keep going, got ${execCallCount} exec calls`);
});

test("finalizeRun skips wireActions envelopes when picking final result", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, returnValue: { score: 4668, board: "...2...4..." } },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: {
        ok: true,
        durationMs: 5,
        returnValue: {
          wireActions: [{ method: "Input.dispatchKeyEvent", params: { key: "ArrowUp" } }],
          state: { score: 0, over: false, text: "current board" },
        },
      },
    },
  );

  const result = finalizeRun(state);
  assert.ok(result.run.result, "expected a derived result");
  assert.ok(result.run.result!.includes("4668"), `expected to skip wireActions envelope: ${result.run.result}`);
  assert.ok(!result.run.result!.includes("wireActions"), "result should not be the command envelope");
});

test("finalizeRun falls back to wireActions envelope when nothing else is meaningful", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "code-result",
    payload: {
      ok: true,
      durationMs: 5,
      returnValue: {
        wireActions: [{ method: "Input.dispatchKeyEvent" }],
        state: { score: 0 },
      },
    },
  });

  const result = finalizeRun(state);
  // No better candidate exists — the second tier (merely meaningful) accepts
  // the envelope rather than returning nothing.
  assert.ok(result.run.result?.includes("wireActions"), "expected fallback to envelope when nothing better exists");
});

test("finalizeRun skips bare CDP nav-ack {frameId, loaderId} when picking final result", () => {
  // Repro of the Amazon run: the agent extracted real product data, then
  // wireActions-navigated to the review page. The nav ack returned
  // {frameId, loaderId} — non-empty, no error, no wireActions key —
  // so deriveRunResult picked it as the final answer instead of the real
  // extraction. The expanded looksLikeWireCommand catches this shape too.
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 12, returnValue: { title: "Top Product", price: "$11.99" } },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 5, returnValue: { frameId: "ABC123", loaderId: "DEF456" } },
    },
  );

  const result = finalizeRun(state);
  assert.ok(result.run.result, "expected a derived result");
  assert.ok(result.run.result!.includes("Top Product"), `expected to skip nav ack and pick extraction: ${result.run.result}`);
  assert.ok(!result.run.result!.includes("frameId"), "result must not be the nav ack");
});

test("finalizeRun skips empty returnValue payloads when picking final result", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, returnValue: { score: 4668 } },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 5, returnValue: {} },
    },
  );

  const result = finalizeRun(state);
  assert.ok(result.run.result, "expected a derived result");
  assert.ok(result.run.result!.includes("4668"), `expected to skip empty {} and pick meaningful result: ${result.run.result}`);
});

test("executeTask aborts when same exec signature fails repeatedly", async () => {
  const task = makeTask({ objective: "Test repeat-fail guard" });
  const sessionId = makeSessionId();
  const stuckCode = "const sleep = ms => new Promise(r => setTimeout(r, ms)); for (let i=0;i<100;i++){await sleep(500);}";
  let execCallCount = 0;
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
      execCallCount++;
      return {
        ok: false,
        stderr: "CDP command timed out after 30000ms: Runtime.evaluate",
        durationMs: 30000,
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 30 },
    async () => ({
      kind: "exec",
      summary: "Run the stuck script",
      payload: { code: stuckCode },
    }),
  );

  // Three failures should be enough to bail (2 repeats past the threshold).
  assert.ok(execCallCount <= 4, `expected the loop to bail early, got ${execCallCount} exec calls`);

  const stopReason = result.events.find((e) =>
    e.kind === "thought-summary" &&
    typeof e.payload["reason"] === "string" &&
    /failed.+times in a row/iu.test(e.payload["reason"] as string),
  );
  assert.ok(stopReason, "expected a repeat-fail stop reason in trace events");
});

test("executeTask does not bail when failures are interleaved with successes", async () => {
  const task = makeTask({ objective: "Test repeat-fail reset" });
  const sessionId = makeSessionId();
  let execCallCount = 0;
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
      execCallCount++;
      // alternating fail/success — should never hit the repeat threshold
      return execCallCount % 2 === 1
        ? { ok: false, stderr: "boom", durationMs: 10 }
        : { ok: true, stdout: "ok", durationMs: 10 };
    },
    async stopSession() {},
  });

  let turnCount = 0;
  await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 6 },
    async () => {
      turnCount++;
      // Same exec code each turn, but exec alternates ok/err
      return {
        kind: "exec",
        summary: "Try again",
        payload: { code: `attempt ${turnCount}` },
      };
    },
  );

  // Should run the full budget — alternating success resets the counter
  assert.ok(execCallCount >= 5, `expected the loop to keep going, got ${execCallCount} exec calls`);
});

test("computeRepeatStreak counts trailing identical exec signatures", () => {
  const events = [
    { id: "e1" as never, runId: "r" as never, ts: "1", kind: "code-exec" as const, payload: { code: "alpha" } },
    { id: "e2" as never, runId: "r" as never, ts: "2", kind: "code-result" as const, payload: { ok: true, returnValue: 1 } },
    { id: "e3" as never, runId: "r" as never, ts: "3", kind: "code-exec" as const, payload: { code: "alpha" } },
    { id: "e4" as never, runId: "r" as never, ts: "4", kind: "code-result" as const, payload: { ok: true, returnValue: 1 } },
    { id: "e5" as never, runId: "r" as never, ts: "5", kind: "code-exec" as const, payload: { code: "alpha" } },
    { id: "e6" as never, runId: "r" as never, ts: "6", kind: "code-result" as const, payload: { ok: true, returnValue: 1 } },
  ];
  const streak = computeRepeatStreak(events);
  assert.equal(streak.sameSig, 3);
  assert.equal(streak.sameResult, 3);
});

test("computeRepeatStreak resets when sig changes", () => {
  const events = [
    { id: "e1" as never, runId: "r" as never, ts: "1", kind: "code-exec" as const, payload: { code: "alpha" } },
    { id: "e2" as never, runId: "r" as never, ts: "2", kind: "code-result" as const, payload: { ok: true, returnValue: 1 } },
    { id: "e3" as never, runId: "r" as never, ts: "3", kind: "code-exec" as const, payload: { code: "alpha" } },
    { id: "e4" as never, runId: "r" as never, ts: "4", kind: "code-result" as const, payload: { ok: true, returnValue: 1 } },
    { id: "e5" as never, runId: "r" as never, ts: "5", kind: "code-exec" as const, payload: { code: "beta" } },
    { id: "e6" as never, runId: "r" as never, ts: "6", kind: "code-result" as const, payload: { ok: true, returnValue: 2 } },
  ];
  const streak = computeRepeatStreak(events);
  assert.equal(streak.sameSig, 1);
  assert.equal(streak.sameResult, 1);
});

test("computeRepeatStreak counts sig matches but not result when results differ", () => {
  const events = [
    { id: "e1" as never, runId: "r" as never, ts: "1", kind: "code-exec" as const, payload: { code: "alpha" } },
    { id: "e2" as never, runId: "r" as never, ts: "2", kind: "code-result" as const, payload: { ok: true, returnValue: 1 } },
    { id: "e3" as never, runId: "r" as never, ts: "3", kind: "code-exec" as const, payload: { code: "alpha" } },
    { id: "e4" as never, runId: "r" as never, ts: "4", kind: "code-result" as const, payload: { ok: true, returnValue: 2 } },
  ];
  const streak = computeRepeatStreak(events);
  assert.equal(streak.sameSig, 2);
  assert.equal(streak.sameResult, 1);
});

test("computeNoProgressStreak counts trailing empty/nav-only/error successes", async () => {
  const { computeNoProgressStreak } = await import("./state-helpers.js");
  const events = [
    { id: "e1" as never, runId: "r" as never, ts: "1", kind: "code-result" as const, payload: { ok: true, returnValue: { score: 5 } } },
    { id: "e2" as never, runId: "r" as never, ts: "2", kind: "code-result" as const, payload: { ok: true, returnValue: {} } },
    { id: "e3" as never, runId: "r" as never, ts: "3", kind: "code-result" as const, payload: { ok: true, returnValue: { error: "not found" } } },
    { id: "e4" as never, runId: "r" as never, ts: "4", kind: "code-result" as const, payload: { ok: true, returnValue: { navigated: true } } },
  ];
  assert.equal(computeNoProgressStreak(events), 3);
});

test("computeNoProgressStreak resets when a meaningful result lands at the tail", async () => {
  const { computeNoProgressStreak } = await import("./state-helpers.js");
  const events = [
    { id: "e1" as never, runId: "r" as never, ts: "1", kind: "code-result" as const, payload: { ok: true, returnValue: {} } },
    { id: "e2" as never, runId: "r" as never, ts: "2", kind: "code-result" as const, payload: { ok: true, returnValue: {} } },
    { id: "e3" as never, runId: "r" as never, ts: "3", kind: "code-result" as const, payload: { ok: true, returnValue: { score: 100 } } },
  ];
  assert.equal(computeNoProgressStreak(events), 0);
});
