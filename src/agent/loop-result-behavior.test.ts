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

  assert.equal(result.run.status, "partial");
  assert.equal(result.run.result, undefined);
  assert.equal(result.classification.kind, "partial-success");
  assert.ok(result.outcomeSummary.includes("partial-success"));
});

test("finalizeRun exposes a RunScore with 5 components on LoopResult", () => {
  // The score lets programmatic callers (supervisor, dashboards, A/B
  // tooling) see why a run was classified as it was without re-running
  // the evaluator. It's the same scoreRun() that powers `wire export`
  // and `wire review`, surfaced as a first-class field.
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
      kind: "code-result",
      payload: { ok: true, durationMs: 10, stdout: "Final answer" },
    },
  );

  const result = finalizeRun(state);

  assert.ok(result.score, "expected LoopResult.score to be present");
  assert.equal(typeof result.score!.total, "number");
  assert.ok(result.score!.total >= 0 && result.score!.total <= 1, "total in [0,1]");
  // The 5 weighted components from scoring.ts WEIGHTS.
  for (const key of ["classification", "contract", "evidence", "efficiency", "policy"] as const) {
    assert.equal(typeof result.score!.components[key], "number", `component ${key} missing`);
  }
});

test("finalizeRun persists lightweight run audit linkage", () => {
  const sessionId = makeSessionId();
  const state = createLoopState(makeTask(), sessionId);
  state.stepCount = 3;
  state.reviewFailureCount = 1;
  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, returnValue: { answer: "done" } },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "artifact",
      payload: { kind: "answer", content: "done" },
    },
  );

  const result = finalizeRun(state);

  assert.equal(result.run.sessionId, sessionId);
  assert.equal(result.run.stepCount, 3);
  assert.equal(result.run.eventCount, 2);
  assert.equal(result.run.artifactCount, 1);
  assert.equal(result.run.reviewFailureCount, 1);
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

test("finalizeRun does not classify max-step empty JSON output as task-complete", () => {
  const task = makeTask({ objective: "find what people are saying about steel.dev" });
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://duckduckgo.com/?q=steel.dev", title: "steel.dev at DuckDuckGo" },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://steel.apidocumentation.com/api-reference", title: "Steel API" },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, returnValue: { results: [], answer: "" } },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "thought-summary",
      payload: { reason: "Maximum steps reached" },
    },
  );
  state.stepCount = 20;

  const result = finalizeRun(state, { maxStepsReached: true });

  assert.equal(result.run.status, "failed");
  assert.equal(result.classification.kind, "agent-error");
  assert.match(result.outcomeSummary, /Maximum steps reached/u);
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
  // A bare click acknowledgement is an interaction ack, not an extracted answer.
  assert.equal(isNavigationOnlyResult(makeEvent({ clicked: true })), true);
  assert.equal(isNavigationOnlyResult(makeEvent({ temperature: "43°F" })), false);
  assert.equal(isNavigationOnlyResult(makeEvent({ navigatedTo: "https://weather.com", temperature: "43°F" })), false);
  assert.equal(isNavigationOnlyResult(makeEvent({ clicked: true, temperature: "43°F" })), false);
  assert.equal(isNavigationOnlyResult(makeEvent("just a string")), false);
  assert.equal(isNavigationOnlyResult(makeEvent(null)), false);
});

test("deriveRunResult never surfaces a bare click ack as the result", () => {
  const mk = (returnValue: JsonValue): TraceEvent => ({
    id: createId("event"),
    runId: "run_test" as never,
    ts: new Date().toISOString(),
    kind: "code-result" as const,
    payload: { ok: true, durationMs: 5, returnValue },
  });
  // A click ack as the only "result" must not become the answer (task mode → undefined).
  assert.equal(deriveRunResult([mk({ clicked: true })], "task"), undefined);
  // A real extraction after a click ack is preferred over the ack.
  const withExtraction = [mk({ clicked: true }), mk({ filingDate: "2025-10-31", formType: "10-K" })];
  const result = deriveRunResult(withExtraction, "task");
  assert.ok(result?.includes("10-K"), `expected the extraction, got: ${result}`);
  assert.ok(!result?.includes("clicked"), "click ack must not be surfaced");
});

test("deriveRunResult never surfaces a synthetic task-summary note as the result", () => {
  const note = (source: string | undefined, content: string): TraceEvent => ({
    id: createId("event"),
    runId: "run_test" as never,
    ts: new Date().toISOString(),
    kind: "artifact" as const,
    payload: source !== undefined
      ? { kind: "note", source, content }
      : { kind: "note", content },
  });
  // Runtime narration ("Reached X at URL") must not pass for an answer —
  // surfacing it would defeat the agent-error downgrade for empty runs.
  assert.equal(
    deriveRunResult([note("task-summary", "Done\nTitle: Example\nURL: https://example.com")], "task"),
    undefined,
  );
  // A genuine note artifact still surfaces.
  assert.equal(deriveRunResult([note(undefined, "The answer is 42")], "task"), "The answer is 42");
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

test("finalizeRun returns no result when only wireActions envelope exists", () => {
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
  // wireActions envelopes are never valid answers — even as a fallback.
  assert.equal(result.run.result, undefined, "wireActions envelope should not be used as result");
});

test("finalizeRun reports partial-success as status 'partial', not 'failed'", () => {
  const task = makeTask({ objective: "Mixed success/failure run" });
  const state = createLoopState(task, makeSessionId());

  for (let i = 0; i < 3; i++) {
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 5, returnValue: { step: i } },
    });
  }
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "code-result",
    payload: { ok: false, durationMs: 5, stderr: "boom" },
  });

  const result = finalizeRun(state);
  assert.equal(result.run.classification?.kind, "partial-success");
  assert.equal(result.run.status, "partial", "partial-success must not be flattened to 'failed'");
});

test("finalizeRun skips raw-action CDP results when picking final result", () => {
  // The `raw` action emits code-results with source: "raw" — these are
  // control-plane (CDP method dispatch) events, not the agent's answer.
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, returnValue: { extracted: "real answer" } },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 5, source: "raw", returnValue: { frameId: "X", loaderId: "Y" } },
    },
  );

  const result = finalizeRun(state);
  assert.ok(result.run.result?.includes("real answer"), `expected to skip raw CDP result: ${result.run.result}`);
  assert.ok(!result.run.result?.includes("frameId"));
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
      payload: { ok: true, durationMs: 5, source: "wireActions", returnValue: { frameId: "ABC123", loaderId: "DEF456" } },
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

test("finalizeRun does not surface a navigation ack as the result", () => {
  // Repro of the post-fix Hacker News run: extraction came back empty, so the
  // only remaining code-result was the navigation-only exec's `{navigated:true}`
  // marker — the shape the prompt prescribes for navigation. A nav ack is never
  // an answer; surfacing it produces a misleading non-answer (judge 0.00). The
  // run should instead be classified honestly as incomplete.
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "code-result",
    payload: { ok: true, durationMs: 5, returnValue: { navigated: true } },
  });

  const result = finalizeRun(state);
  assert.ok(!result.run.result?.includes("navigated"), `nav ack must not become the result: ${result.run.result}`);
});

test("finalizeRun skips a trailing navigation ack and picks the real extraction", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push(
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 12, returnValue: [{ rank: 1, title: "Real Story", points: 200 }] },
    },
    {
      id: createId("event"),
      runId: state.run.id,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 5, returnValue: { navigated: true } },
    },
  );

  const result = finalizeRun(state);
  assert.ok(result.run.result?.includes("Real Story"), `expected to skip nav ack and pick extraction: ${result.run.result}`);
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

test("finalizeRun omits non-meaningful result when userCancelled", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  // Only a navigation-only result (empty object) — not meaningful
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "code-result",
    payload: { ok: true, durationMs: 5, returnValue: {} },
  });

  const result = finalizeRun(state, { userCancelled: true });
  assert.equal(result.run.result, undefined, "non-meaningful partial result should be omitted on cancel");
});

test("finalizeRun keeps meaningful result even when userCancelled", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "code-result",
    payload: { ok: true, durationMs: 10, stdout: "San Francisco: $1500/mo, New York: $3200/mo" },
  });

  const result = finalizeRun(state, { userCancelled: true });
  assert.ok(result.run.result?.includes("San Francisco"), "meaningful result should be preserved on cancel");
});

test("finalizeRun preserves result behaviour unchanged when not cancelled", () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: new Date().toISOString(),
    kind: "code-result",
    payload: { ok: true, durationMs: 5, stdout: "found result" },
  });

  // Without cancellation the result should be set normally
  const result = finalizeRun(state, { userCancelled: false });
  assert.ok(result.run.result?.includes("found result"), "result should be set normally without cancel");
});
