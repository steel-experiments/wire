import { strict as assert } from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
import { createPolicyEngine } from "../policy/engine.js";

import { classifyRun, generateOutcomeSummary } from "./classify.js";
import { defaultAgentTurn, executeTask, resumeTask } from "./runtime.js";
import {
  applyAuthWallSignal,
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

test("latestExtractionIsVerificationProbe distinguishes Wire's generic capture from a real extraction", () => {
  const state = createLoopState(makeTask(), makeSessionId());
  const exec = (code: string): void => {
    state.events.push({
      id: createId("event"), runId: state.run.id, ts: new Date().toISOString(),
      kind: "code-exec", payload: { code },
    });
  };

  // A task-specific extraction is not a probe.
  exec("return { userAgent: navigator.userAgent, accept: 'text/html' };");
  assert.equal(latestExtractionIsVerificationProbe(state), false);

  // Wire's injected generic page-state capture is.
  const verifyCode = (buildVerificationAction().payload as { code: string }).code;
  exec(verifyCode);
  assert.equal(latestExtractionIsVerificationProbe(state), true);

  // A real extraction after the probe clears it again.
  exec("return { headers: { 'User-Agent': 'x' } };");
  assert.equal(latestExtractionIsVerificationProbe(state), false);
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
// applyAuthWallSignal
// ---------------------------------------------------------------------------

function makeAuthWallSignals(): { authWallHit: boolean; authWallStreak: number; authWallHost: string | undefined } {
  return { authWallHit: false, authWallStreak: 0, authWallHost: undefined };
}

function pushObservationEvent(state: LoopState, url: string, title: string): void {
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "observation",
    payload: { url, title },
  });
}

test("applyAuthWallSignal nudges instead of stopping on the first auth wall", () => {
  const state = createLoopState(makeTask(), makeSessionId());
  const signals = makeAuthWallSignals();
  pushObservationEvent(state, "https://www.wordplays.com/crossword-solver/clue", "Sign In | Wordplays.com");

  applyAuthWallSignal(state, signals, true);

  assert.equal(signals.authWallHit, false, "a single auth-walled page must not end the run");
  assert.equal(signals.authWallStreak, 1);
  assert.equal(signals.authWallHost, "www.wordplays.com");

  const nudge = state.events[state.events.length - 1]!;
  assert.equal(nudge.kind, "thought-summary");
  assert.equal(nudge.payload.kind, "auth-wall-detected");
  const reason = String(nudge.payload.reason);
  assert.ok(reason.includes("https://www.wordplays.com/crossword-solver/clue"), "nudge names the walled URL");
  assert.ok(/credentials/iu.test(reason), "nudge forbids credential entry");
});

test("applyAuthWallSignal stops after consecutive auth walls on the same host", () => {
  const state = createLoopState(makeTask(), makeSessionId());
  const signals = makeAuthWallSignals();

  pushObservationEvent(state, "https://www.wordplays.com/crossword-solver/clue", "Sign In | Wordplays.com");
  applyAuthWallSignal(state, signals, true);
  pushObservationEvent(state, "https://www.wordplays.com/login", "Sign In | Wordplays.com");
  applyAuthWallSignal(state, signals, true);

  assert.equal(signals.authWallHit, true, "staying on the wall after the nudge ends the run");
  assert.equal(signals.authWallStreak, 2);

  const nudges = state.events.filter(
    (e) => e.kind === "thought-summary" && e.payload.kind === "auth-wall-detected",
  );
  assert.equal(nudges.length, 1, "the nudge is not repeated while stuck on the same host");
});

test("applyAuthWallSignal treats an auth wall on a different host as a fresh dead end", () => {
  const state = createLoopState(makeTask(), makeSessionId());
  const signals = makeAuthWallSignals();

  pushObservationEvent(state, "https://www.wordplays.com/login", "Sign In | Wordplays.com");
  applyAuthWallSignal(state, signals, true);
  pushObservationEvent(state, "https://www.linkedin.com/jobs/view/123", "Sign In | LinkedIn");
  applyAuthWallSignal(state, signals, true);

  assert.equal(signals.authWallHit, false, "walls on two different sources are dead ends, not a blocked task");
  assert.equal(signals.authWallStreak, 1);
  assert.equal(signals.authWallHost, "www.linkedin.com");
});

test("applyAuthWallSignal clears the streak when the agent routes around the wall", () => {
  const state = createLoopState(makeTask(), makeSessionId());
  const signals = makeAuthWallSignals();

  pushObservationEvent(state, "https://www.wordplays.com/login", "Sign In | Wordplays.com");
  applyAuthWallSignal(state, signals, true);
  pushObservationEvent(state, "https://duckduckgo.com/?q=race", "race at DuckDuckGo");
  applyAuthWallSignal(state, signals, false);

  assert.equal(signals.authWallHit, false);
  assert.equal(signals.authWallStreak, 0);
  assert.equal(signals.authWallHost, undefined);
});

// ---------------------------------------------------------------------------
// executeStep — observe action
// ---------------------------------------------------------------------------

test("executeStep handles observe action", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const sessionId = makeSessionId();
  const provider = createMockProvider({
    async createSession(): Promise<BrowserSession> {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
  });
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
  // policy-check + code-exec + code-result + auto-observe after click
  assert.equal(result.state.events.length, 4);
  assert.equal(result.state.events[0]!.kind, "policy-check");
  assert.equal(result.state.events[1]!.kind, "code-exec");
  assert.equal(result.state.events[2]!.kind, "code-result");
  assert.equal(result.state.events[3]!.kind, "observation");
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

test("executeStep handles task-local helper rewrites", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createMockPolicyEngine();

  const result = await executeStep(
    state,
    {
      kind: "edit-helper",
      summary: "Replace helper surface for this task",
      payload: {
        source: "export function readMain() { return document.querySelector('main')?.textContent || ''; }",
      },
    },
    provider,
    policy,
  );

  assert.equal(result.policyDenied, false);
  assert.equal(result.state.helperVersion, 1);
  assert.match(result.state.helperSource, /readMain/u);
  const artifact = result.state.events.find((event) =>
    event.kind === "artifact" && event.payload.kind === "helper-diff"
  );
  assert.ok(artifact, "helper edit should emit a helper-diff artifact");
  assert.match(String(artifact.payload.content), /readMain/u);
});

test("executeStep uses rewritten helpers in later exec calls", async () => {
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

  await executeStep(
    state,
    {
      kind: "edit-helper",
      summary: "Replace helper surface for this task",
      payload: {
        source: "export function readMain() { return document.querySelector('main')?.textContent || ''; }",
      },
    },
    provider,
    policy,
  );
  await executeStep(
    state,
    {
      kind: "exec",
      summary: "Use helper",
      payload: { code: "return readMain();" },
    },
    provider,
    policy,
  );

  assert.ok(execInput?.code.includes("function readMain()"), "custom helper not prepended");
  assert.ok(!execInput?.code.includes("export function readMain"), "helper export should be stripped");
  assert.ok(execInput?.code.includes("return readMain();"), "exec code missing");
});

test("executeStep rejects invalid helper rewrites", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();

  const result = await executeStep(
    state,
    {
      kind: "edit-helper",
      summary: "Bad helper",
      payload: { source: "function bad() { return process.env.SECRET; }" },
    },
    provider,
    createMockPolicyEngine(),
  );

  assert.equal(result.state.helperVersion, 0);
  assert.match(result.state.helperSource, /clickVisibleText/u);
  assert.ok(result.state.events.some((event) =>
    event.kind === "error" && String(event.payload.code) === "EHELPER"
  ));
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

test("executeStep sends classified exec risk as structured policy metadata", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  let seenRisk: string | undefined;
  let seenPolicyKind: string | undefined;
  const policy = createMockPolicyEngine({
    check(_actionId, action) {
      seenPolicyKind = action.kind;
      seenRisk = action.metadata?.riskKind;
      return { id: createId("policy"), actionId: _actionId, result: "allow" };
    },
  });

  await executeStep(
    state,
    {
      kind: "exec",
      summary: "Badly labeled delete",
      payload: {
        policyKind: "read",
        code: "await fetch('/items/1', { method: 'DELETE' }); return 'done';",
      },
    },
    provider,
    policy,
  );

  assert.equal(seenPolicyKind, "delete");
  assert.equal(seenRisk, "delete");
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

test("defaultAgentTurn corrects wire.goto hallucinations in prompt", async () => {
  const state = createLoopState(makeTask(), makeSessionId());
  let prompt = "";
  state.events.push(
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-exec", payload: { code: 'await wire.goto("https://example.com"); return {done:true};' } },
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-result", payload: { ok: false, durationMs: 1, stderr: "TypeError: wire.goto is not a function" } },
  );
  const turn = defaultAgentTurn({ model: "test-model", async chat(messages) {
    prompt = String(messages.find((m) => m.role === "user")?.content ?? "");
    return { content: '{"kind":"exec","summary":"Navigate directly","payload":{"code":"window.location.href = \\"https://example.com\\"; return {navigated:true};"}}', model: "test-model" };
  } });

  await turn(state, createMockProvider());

  assert.match(prompt, /wire\.goto does not exist/u);
  assert.match(prompt, /window\.location\.href/u);
  assert.match(prompt, /auto-observe/u);
});

test("defaultAgentTurn corrects failed exec data URL navigation toward raw Page.navigate", async () => {
  const state = createLoopState(makeTask(), makeSessionId());
  let prompt = "";
  state.events.push(
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-exec", payload: { code: 'location.href = "data:text/html,<button id=go>Trust Check</button>"; await waitForSelector("#go", 5000);' } },
    { id: createId("event"), runId: state.run.id, ts: new Date().toISOString(), kind: "code-result", payload: { ok: false, durationMs: 5000, stderr: 'Error: waitForSelector: "#go" not found within 5000ms' } },
  );
  const turn = defaultAgentTurn({ model: "test-model", async chat(messages) {
    prompt = String(messages.find((m) => m.role === "user")?.content ?? "");
    return { content: '{"kind":"raw","summary":"Navigate to data URL","payload":{"method":"Page.navigate","params":{"url":"data:text/html,<button id=go>Trust Check</button>"}}}', model: "test-model" };
  } });

  await turn(state, createMockProvider());

  assert.match(prompt, /data: URL navigation from exec did not load/u);
  assert.match(prompt, /raw Page\.navigate/u);
  assert.match(prompt, /before wire\.click/u);
});

test("defaultAgentTurn normalizes exec data URL navigation into raw Page.navigate", async () => {
  const state = createLoopState(makeTask(), makeSessionId());
  const dataUrl = "data:text/html,<button id=go>Trust Check</button>";
  const turn = defaultAgentTurn({ model: "test-model", async chat() {
    return {
      content: JSON.stringify({
        kind: "exec",
        summary: "Navigate then click",
        payload: {
          code: `const url = "${dataUrl}"; location.href = url; await waitForSelector("#go", 5000);`,
        },
      }),
      model: "test-model",
    };
  } });

  const action = await turn(state, createMockProvider());

  assert.equal(action.kind, "raw");
  assert.equal(action.summary, "Navigate to data URL");
  assert.equal(action.payload?.method, "Page.navigate");
  assert.deepEqual(action.payload?.params, { url: dataUrl });
});

// ---------------------------------------------------------------------------
// finalizeRun
// ---------------------------------------------------------------------------

test("executeTask releases the session even when finish payload asks to keep it open", async () => {
  const task = makeTask({ objective: "Do the thing, then keep the session open" });
  const sessionId = makeSessionId();
  let stopCalled = false;
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      return { ok: true, durationMs: 5, returnValue: { answer: "done" } };
    },
    async stopSession() {
      stopCalled = true;
    },
  });

  await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 2 },
    async (state) => {
      if (state.stepCount === 0) {
        return { kind: "exec", summary: "Produce answer", payload: { code: "return { answer: 'done' }" } };
      }
      return { kind: "finish", summary: "Done — leaving browser open", payload: { keepSessionOpen: true } };
    },
  );

  assert.equal(stopCalled, true, "task text or model payload must not skip provider cleanup");
});

test("executeTask stops the session when the agent finishes without keepSessionOpen", async () => {
  const task = makeTask({ objective: "Do the thing and finish" });
  const sessionId = makeSessionId();
  let stopCalled = false;
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      return { ok: true, durationMs: 5, returnValue: { answer: "done" } };
    },
    async stopSession() {
      stopCalled = true;
    },
  });

  await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 2 },
    async (state) => {
      if (state.stepCount === 0) {
        return { kind: "exec", summary: "Produce answer", payload: { code: "return { answer: 'done' }" } };
      }
      return { kind: "finish", summary: "Done" };
    },
  );

  assert.equal(stopCalled, true, "session should close normally when keepSessionOpen is not requested");
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

test("executeTask records skill-load match score reasons", async () => {
  const task = makeTask({
    objective: "Open pricing on example.com",
    successCriteria: ["Pricing visible"],
  });
  const sessionId = makeSessionId();
  const provider = createMockProvider({
    async createSession(): Promise<BrowserSession> {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
  });
  const skillDir = await mkdtemp(join(tmpdir(), "wire-agent-skills-"));
  const skillId = createId("skill");
  const skillContent = [
    "---",
    `id: ${skillId}`,
    "scope: domain",
    "hostnamePatterns:",
    "  - example.com",
    "tags:",
    "  - pricing",
    "updatedAt: 2026-04-24",
    "source: generated",
    "confidence: 0.5",
    "---",
    "",
    "## Facts",
    "Use /pricing directly.",
  ].join("\n");

  await writeFile(join(skillDir, "example.md"), skillContent, "utf-8");
  await writeSkillStats(skillDir, skillId, {
    loadedCount: 4,
    successCount: 4,
    outcomeCounts: { "task-complete": 4 },
    totalSteps: 16,
    totalTokens: 12_000,
    lastLoadedAt: "2026-05-20T10:00:00.000Z",
    recentRuns: [],
  });

  const llmProvider = {
    model: "test-model",
    async chat() {
      return {
        content: JSON.stringify({ kind: "finish", summary: "Done" }),
        model: "test-model",
      };
    },
  };

  try {
    const session: BrowserSession = {
      id: makeSessionId(),
      provider: "steel",
      createdAt: new Date().toISOString(),
      status: "ready",
    };
    const result = await executeTask(
      task,
      { provider, policyEngine: createMockPolicyEngine(), maxSteps: 2, skillDir, llmProvider, existingSession: session },
    );
    const skillLoad = result.events.find((event) => event.kind === "skill-load");
    assert.ok(skillLoad);
    const matches = skillLoad.payload.matches;
    assert.ok(Array.isArray(matches));
    const match = matches[0] as { skillId: string; reasons: unknown[] };
    assert.equal(match.skillId, skillId);
    assert.ok(Array.isArray(match.reasons));
    assert.ok(match.reasons.some((reason: unknown) =>
      typeof reason === "string" && reason.startsWith("effective-success")
    ));
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

  assert.equal(result.run.status, "partial");
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

test("appendExtractedResultArtifact preserves explicit file artifact envelopes", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "code-result",
    payload: {
      ok: true,
      durationMs: 10,
      returnValue: {
        artifacts: [
          {
            filename: "comparison.md",
            kind: "markdown",
            mimeType: "text/markdown",
            content: "| Provider | Price |\n|---|---:|\n| Vercel | $20 |",
          },
        ],
        data: { providers: 1 },
      },
    },
  });

  appendExtractedResultArtifact(state);

  const artifactEvent = state.events.find((event) => event.kind === "artifact");
  assert.ok(artifactEvent);
  assert.equal(artifactEvent.payload.filename, "comparison.md");
  assert.equal(artifactEvent.payload.kind, "markdown");
  assert.equal(artifactEvent.payload.mimeType, "text/markdown");
  assert.match(String(artifactEvent.payload.path), /^artifacts\/artifact_.+-comparison\.md$/u);
  assert.match(String(artifactEvent.payload.content), /Provider/u);
});

test("appendExtractedResultArtifact accepts multiple generic artifact kinds and sanitizes filenames", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "code-result",
    payload: {
      ok: true,
      durationMs: 10,
      returnValue: {
        artifacts: [
          { filename: "../../report.csv", kind: "csv", mimeType: "text/csv", content: "name,value\nA,1\n" },
          { filename: "script.py", kind: "python", mimeType: "text/x-python", content: "print('ok')\n" },
        ],
      },
    },
  });

  appendExtractedResultArtifact(state);

  const artifactEvents = state.events.filter((event) => event.kind === "artifact");
  assert.equal(artifactEvents.length, 2);
  assert.equal(artifactEvents[0]!.payload.filename, "report.csv");
  assert.equal(artifactEvents[0]!.payload.kind, "csv");
  assert.equal(artifactEvents[0]!.payload.mimeType, "text/csv");
  assert.doesNotMatch(String(artifactEvents[0]!.payload.path), /\.\./u);
  assert.equal(artifactEvents[1]!.payload.filename, "script.py");
  assert.equal(artifactEvents[1]!.payload.kind, "python");
});

test("executeTask does not invent numeric repeat-objective finish gates", async () => {
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
          : { game: "2048", runs: [1, 2, 3, 4, 5].map((run) => ({ run, status: "completed", score: run * 10, over: true })) },
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

  assert.equal(execCount, 1);
  assert.equal(result.run.status, "succeeded");
});


test("executeTask blocks finish when artifact review finds problems", async () => {
  const task = makeTask({ objective: "Extract pricing and save as markdown table in md format" });
  const sessionId = makeSessionId();
  let execCount = 0;
  let reviewCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      execCount++;
      const enterprisePrice = execCount === 1 ? "Pricing Ask AI" : "Custom";
      const content = [
        "| Plan | Price |",
        "|---|---|",
        "| Hobby | Free |",
        "| Pro | $20/mo |",
        `| Enterprise | ${enterprisePrice} |`,
      ].join("\n");
      return {
        ok: true,
        durationMs: 10,
        returnValue: {
          artifacts: [{ filename: "pricing.md", kind: "markdown", mimeType: "text/markdown", content }],
        },
      };
    },
    async stopSession() {},
  });
  const llmProvider: LLMProvider = {
    model: "reviewer",
    async chat(messages) {
      const prompt = messages.map((message) => message.content).join("\n");
      if (!prompt.includes("Review the final artifact against the objective")) {
        return { model: "reviewer", content: "{}" };
      }
      reviewCount++;
      return {
        model: "reviewer",
        content: reviewCount === 1
          ? JSON.stringify({ passed: false, problems: ["Enterprise price appears to be navigation text."] })
          : JSON.stringify({ passed: true, problems: [] }),
      };
    },
  };

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), llmProvider, maxSteps: 6 },
    async (state) => {
      const reviews = state.events.filter((event) => event.kind === "artifact-review");
      if (state.stepCount === 0) return { kind: "exec", summary: "Extract bad artifact", payload: { code: "return bad" } };
      if (reviews.some((event) => event.payload.passed === false) && execCount === 1) {
        return { kind: "exec", summary: "Fix artifact", payload: { code: "return fixed" } };
      }
      return { kind: "finish", summary: "Done" };
    },
  );

  const reviews = result.events.filter((event) => event.kind === "artifact-review");
  assert.equal(execCount, 2);
  assert.equal(reviewCount, 2);
  assert.equal(reviews.length, 2);
  assert.equal(reviews[0]!.payload.passed, false);
  assert.equal(reviews[1]!.payload.passed, true);
  assert.equal(result.run.status, "succeeded");
});

test("executeTask does not record finish when artifact review still fails after retry", async () => {
  const task = makeTask({ objective: "Extract pricing and save as markdown table in md format" });
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
        returnValue: {
          artifacts: [{
            filename: "pricing.md",
            kind: "markdown",
            mimeType: "text/markdown",
            content: [
              "| Plan | Price |",
              "|---|---|",
              "| Hobby | Free |",
              "| Pro | $20/mo |",
              "| Enterprise | Pricing Ask AI |",
            ].join("\n"),
          }],
        },
      };
    },
    async stopSession() {},
  });
  const llmProvider: LLMProvider = {
    model: "reviewer",
    async chat() {
      return {
        model: "reviewer",
        content: JSON.stringify({ passed: false, problems: ["Placeholder extraction claim remains."] }),
      };
    },
  };

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), llmProvider, maxSteps: 5 },
    async (state) => {
      const failedReview = state.events.some((event) =>
        event.kind === "artifact-review" && event.payload.passed === false
      );
      if (state.stepCount === 0 || (failedReview && execCount < 2)) {
        return { kind: "exec", summary: "Extract bad artifact", payload: { code: "return bad" } };
      }
      return { kind: "finish", summary: "Done" };
    },
  );

  assert.equal(execCount, 2);
  assert.equal(result.run.status, "partial");
  assert.equal(result.classification.kind, "partial-success");
  assert.equal(result.events.some((event) =>
    event.kind === "thought-summary" && event.payload.kind === "finish"
  ), false);
  assert.ok(result.events.some((event) =>
    event.kind === "thought-summary" &&
    event.payload.reason === "Artifact review failed after retry budget"
  ));
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
  assert.equal(streamed[0]!.kind, "contract-check");
  assert.equal(streamed[1]!.kind, "observation");
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
  // Reconfigure is gated on real block evidence: give the state a blocked-page
  // observation so the swap is justified and the handler runs.
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "observation",
    payload: { url: "https://blocked.example/", title: "Just a moment...", pageSummary: { headings: [], forms: 0, buttons: 0, dialogs: 0, tables: 0, links: 0, inputs: 0 } },
  });

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
  // Reconfigure is gated on real block evidence: give the state a blocked-page
  // observation so the swap is justified and the handler runs.
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "observation",
    payload: { url: "https://blocked.example/", title: "Just a moment...", pageSummary: { headings: [], forms: 0, buttons: 0, dialogs: 0, tables: 0, links: 0, inputs: 0 } },
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

test("executeStep refuses reconfigure on an unblocked loaded page without stopping the run", async () => {
  const task = makeTask();
  const oldSessionId = makeSessionId();
  const state = createLoopState(task, oldSessionId);
  // A page that already loaded real content with no anti-bot signal — a proxy
  // swap here would needlessly discard a working session (the SEC EDGAR case).
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "observation",
    payload: { url: "https://www.sec.gov/cgi-bin/browse-edgar", title: "EDGAR Search Results", pageSummary: { headings: ["EDGAR Search Results"], forms: 1, buttons: 2, dialogs: 0, tables: 1, links: 30, inputs: 3 } },
  });

  let createSessionCalled = false;
  const provider = createMockProvider({
    async createSession() {
      createSessionCalled = true;
      return { id: makeSessionId(), provider: "steel", createdAt: new Date().toISOString(), status: "ready" } satisfies BrowserSession;
    },
  });
  const policy = createMockPolicyEngine();
  const registry = new ActionRegistry();
  registry.register({
    kind: "reconfigure",
    description: "test reconfigure",
    async execute(s, _action, prov) {
      await prov.createSession({ sessionConfig: {} });
      return {};
    },
  });

  const result = await executeStep(
    state,
    { kind: "reconfigure", summary: "Recover from anti-bot challenge with proxy and captcha support", payload: { useProxy: true, solveCaptcha: true } },
    provider,
    policy,
    { actionRegistry: registry },
  );

  assert.equal(createSessionCalled, false, "reconfigure handler must not run on an unblocked page");
  assert.equal(result.policyDenied, false, "graceful refusal must not terminate the run");
  assert.equal(result.state.sessionId, oldSessionId, "session must be unchanged");
  const refusal = result.state.events.find(
    (e) => e.kind === "thought-summary" && e.payload.kind === "reconfigure-refused",
  );
  assert.ok(refusal, "should record a reconfigure-refused trace event");
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

test("executeTask aborts repeated page snapshots as stuck work", async () => {
  const task = makeTask({ objective: "play 2048 and achieve high score for 5 games" });
  const sessionId = makeSessionId();
  let execCallCount = 0;
  const snapshot = {
    ok: true,
    evidence: {
      title: "Play 2048 Game",
      url: "https://elgoog.im/2048/",
      text: "2048\n12036\nStop Bot!\nNew Game\nHOW TO PLAY: Use your arrow keys",
    },
    reason: "Captured current page state for task verification",
  };
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
        returnValue: snapshot,
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 30 },
    async () => ({
      kind: "exec",
      summary: "Capture page",
      payload: {
        code: "/* wire:extract wire:verify */ return window.snapshot",
      },
    }),
  );

  assert.ok(execCallCount <= 6, `expected stuck guard to bail, got ${execCallCount} exec calls`);
  assert.equal(result.run.status, "partial");
  assert.equal(result.run.classification?.kind, "partial-success");
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

test("executeTask does not bail on a progressing watch loop (stable shape, changing values)", async () => {
  // The elgoog 2048 case: the agent re-runs the same monitoring probe to poll a
  // live, climbing score. The result shape is stable but the values advance
  // every turn — real progress, not spinning. The sig-only backstop must not
  // kill it.
  const task = makeTask({ objective: "Watch a live score climb" });
  const sessionId = makeSessionId();
  let execCallCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      execCallCount++;
      return {
        ok: true,
        durationMs: 10,
        returnValue: { score: execCallCount * 1000, best: 0, running: true },
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 20 },
    async () => ({
      kind: "exec",
      summary: "Poll the live score",
      payload: { code: "return readScore()" },
    }),
  );

  // Should run the full step budget, not bail at the sig-only threshold (8).
  assert.ok(execCallCount >= 15, `expected the watch loop to keep going, got ${execCallCount} exec calls`);
  const bailed = result.events.find((e) =>
    e.kind === "thought-summary" &&
    typeof e.payload["reason"] === "string" &&
    /attempted .+ times in a row/iu.test(e.payload["reason"] as string),
  );
  assert.ok(!bailed, "sig-only backstop should not fire on a progressing watch loop");
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

// ---------------------------------------------------------------------------
// finalizeRun — userCancelled result gate
// ---------------------------------------------------------------------------
