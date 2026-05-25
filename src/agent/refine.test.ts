// ABOUTME: Tests for policy-gated refinement (Skills v2 Milestone 4).
// ABOUTME: Exercises safety classification, gate checks, and the refinement loop.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type { LoopResult, LoopState } from "./loop.js";
import type { JsonObject, TraceEvent, Run, RunId, Task } from "../shared/types.js";

import {
  classifyRunSafety,
  canRefineRun,
  refineRun,
  type RefinementResult,
  type RefinementOptions,
} from "./refine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: createId("run"),
    taskId: createId("task"),
    status: "succeeded",
    startedAt: "2026-05-06T10:00:00.000Z",
    finishedAt: "2026-05-06T10:00:42.000Z",
    classification: { kind: "task-complete", confidence: 0.95 },
    outcomeSummary: "Task completed.",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Check SEC filing status",
    mode: "experiment",
    objective: "Look up the latest Apple 10-K filing",
    constraints: [],
    successCriteria: ["Filing status is returned"],
    createdAt: "2026-05-06T10:00:00.000Z",
    ...overrides,
  };
}

function makeLoopResult(overrides: {
  run?: Run;
  task?: Task;
  events?: TraceEvent[];
  stepCount?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
}): LoopResult {
  const run = overrides.run ?? makeRun();
  const result: LoopResult = {
    run,
    events: overrides.events ?? [],
    classification: { kind: "task-complete", confidence: 0.95 },
    outcomeSummary: "Done",
    sessionId: createId("session"),
    stepCount: overrides.stepCount ?? 5,
    startedAt: run.startedAt ?? "2026-05-06T10:00:00.000Z",
    helperSource: "function noop() {}",
    helperVersion: 0,
    reviewFailureCount: 0,
  };
  if (overrides.usage !== undefined) result.usage = overrides.usage;
  return result;
}

function makeEvent(kind: string, payload: Record<string, unknown>): TraceEvent {
  return {
    id: createId("event"),
    runId: createId("run"),
    ts: "2026-05-06T10:00:01.000Z",
    kind: kind as TraceEvent["kind"],
    payload: payload as JsonObject,
  };
}

// ---------------------------------------------------------------------------
// classifyRunSafety
// ---------------------------------------------------------------------------

test("classifyRunSafety returns safe for read-only observation events", () => {
  const events: TraceEvent[] = [
    makeEvent("observation", { url: "https://example.com/page", title: "Example" }),
    makeEvent("code-exec", { code: "return document.querySelectorAll('.result').length" }),
    makeEvent("code-result", { ok: true, stdout: "5" }),
  ];

  const { safe, reasons } = classifyRunSafety(events);
  assert.equal(safe, true);
  assert.deepEqual(reasons, []);
});

test("classifyRunSafety detects form submission", () => {
  const events: TraceEvent[] = [
    makeEvent("code-exec", { code: "document.querySelector('form').submit()" }),
    makeEvent("code-result", { ok: true }),
  ];

  const { safe, reasons } = classifyRunSafety(events);
  assert.equal(safe, false);
  assert.ok(reasons.some((r) => /submission/iu.test(r)));
});

test("classifyRunSafety detects POST/PUT/DELETE fetch", () => {
  const events: TraceEvent[] = [
    makeEvent("code-exec", { code: "await fetch('/api/data', { method: 'POST', body: 'test' })" }),
    makeEvent("code-result", { ok: true }),
  ];

  const { safe, reasons } = classifyRunSafety(events);
  assert.equal(safe, false);
  assert.ok(reasons.some((r) => /POST/iu.test(r)));
});

test("classifyRunSafety detects PUT fetch", () => {
  const events: TraceEvent[] = [
    makeEvent("code-exec", { code: "fetch('/api/item', {method:'PUT'})" }),
  ];

  const { safe } = classifyRunSafety(events);
  assert.equal(safe, false);
});

test("classifyRunSafety detects approval-request events", () => {
  const events: TraceEvent[] = [
    makeEvent("approval-request", { summary: "Submit form", consequences: ["Execute action"] }),
  ];

  const { safe, reasons } = classifyRunSafety(events);
  assert.equal(safe, false);
  assert.ok(reasons.some((r) => /approval/iu.test(r)));
});

test("classifyRunSafety detects policy-check with require-approval", () => {
  const events: TraceEvent[] = [
    makeEvent("policy-check", { actionKind: "exec", result: "require-approval" }),
  ];

  const { safe } = classifyRunSafety(events);
  assert.equal(safe, false);
});

test("classifyRunSafety detects checkout/payment URLs", () => {
  const events: TraceEvent[] = [
    makeEvent("observation", { url: "https://shop.example.com/checkout", title: "Checkout" }),
  ];

  const { safe, reasons } = classifyRunSafety(events);
  assert.equal(safe, false);
  assert.ok(reasons.some((r) => /checkout/iu.test(r)));
});

test("classifyRunSafety detects credential entry in code", () => {
  const events: TraceEvent[] = [
    makeEvent("code-exec", { code: "document.querySelector('input[type=password]').value = 'secret'" }),
  ];

  const { safe, reasons } = classifyRunSafety(events);
  assert.equal(safe, false);
  assert.ok(reasons.some((r) => /credential/iu.test(r)));
});

test("classifyRunSafety allows GET fetch", () => {
  const events: TraceEvent[] = [
    makeEvent("code-exec", { code: "await fetch('https://api.example.com/data')" }),
    makeEvent("code-result", { ok: true }),
  ];

  const { safe } = classifyRunSafety(events);
  assert.equal(safe, true);
});

// ---------------------------------------------------------------------------
// canRefineRun
// ---------------------------------------------------------------------------

test("canRefineRun allows experiment mode with safe events", () => {
  const task = makeTask({ mode: "experiment" });
  const result = makeLoopResult({
    events: [
      makeEvent("observation", { url: "https://sec.gov/filing", title: "SEC" }),
      makeEvent("code-exec", { code: "return document.querySelector('.title').textContent" }),
      makeEvent("code-result", { ok: true, stdout: "10-K Filing" }),
    ],
  });

  const { allowed, reason } = canRefineRun(task, result);
  assert.equal(allowed, true);
  assert.equal(reason, undefined);
});

test("canRefineRun allows investigate mode", () => {
  const task = makeTask({ mode: "investigate" });
  const result = makeLoopResult({});

  const { allowed } = canRefineRun(task, result);
  assert.equal(allowed, true);
});

test("canRefineRun blocks task mode", () => {
  const task = makeTask({ mode: "task" });
  const result = makeLoopResult({});

  const { allowed, reason } = canRefineRun(task, result);
  assert.equal(allowed, false);
  assert.match(reason!, /task mode/iu);
});

test("canRefineRun blocks when baseline failed", () => {
  const task = makeTask({ mode: "experiment" });
  const result = makeLoopResult({
    run: makeRun({ status: "failed" }),
  });
  result.classification = { kind: "agent-error", confidence: 0.9 };

  const { allowed, reason } = canRefineRun(task, result);
  assert.equal(allowed, false);
  assert.match(reason!, /agent-error/iu);
});

test("canRefineRun blocks when baseline required approval", () => {
  const task = makeTask({ mode: "experiment" });
  const result = makeLoopResult({
    events: [
      makeEvent("approval-request", { summary: "Click submit" }),
    ],
  });

  const { allowed, reason } = canRefineRun(task, result);
  assert.equal(allowed, false);
  assert.match(reason!, /approval/iu);
});

test("canRefineRun blocks when destructive actions detected", () => {
  const task = makeTask({ mode: "experiment" });
  const result = makeLoopResult({
    events: [
      makeEvent("code-exec", { code: "document.querySelector('form').submit()" }),
    ],
  });

  const { allowed, reason } = canRefineRun(task, result);
  assert.equal(allowed, false);
  assert.match(reason!, /destructive/iu);
});

// ---------------------------------------------------------------------------
// refineRun
// ---------------------------------------------------------------------------

test("refineRun skips when gate does not pass", async () => {
  const task = makeTask({ mode: "task" });
  const baseline = makeLoopResult({});

  const result = await refineRun(task, baseline, async () => {
    assert.fail("should not execute when gate fails");
  });

  assert.equal(result.attempted, false);
  assert.ok(result.gateReason);
  assert.equal(result.comparison, undefined);
  assert.equal(result.iterations, 0);
});

test("refineRun executes candidate run and produces comparison", async () => {
  const task = makeTask({ mode: "experiment" });
  const baseline = makeLoopResult({
    run: makeRun({
      startedAt: "2026-05-06T10:00:00.000Z",
      finishedAt: "2026-05-06T10:00:42.000Z",
    }),
    events: [
      makeEvent("observation", { url: "https://example.com", title: "Example" }),
      makeEvent("code-exec", { code: "return 1" }),
      makeEvent("code-result", { ok: true, stdout: "1" }),
    ],
    stepCount: 8,
  });

  let executeCallCount = 0;
  const result = await refineRun(task, baseline, async (t) => {
    executeCallCount++;
    return makeLoopResult({
      run: makeRun({
        startedAt: "2026-05-06T10:01:00.000Z",
        finishedAt: "2026-05-06T10:01:19.000Z",
      }),
      task: t,
      stepCount: 4,
      usage: { promptTokens: 3000, completionTokens: 4000, totalTokens: 7000 },
    });
  }, { maxIterations: 1 });

  assert.equal(result.attempted, true);
  assert.equal(result.gateReason, undefined);
  assert.equal(executeCallCount, 1);
  assert.ok(result.comparison);
  assert.equal(result.comparison!.runs.length, 2);
  assert.equal(result.iterations, 1);
});

test("refineRun stops when candidate fails but baseline succeeded", async () => {
  const task = makeTask({ mode: "experiment" });
  const baseline = makeLoopResult({
    run: makeRun({
      startedAt: "2026-05-06T10:00:00.000Z",
      finishedAt: "2026-05-06T10:00:42.000Z",
    }),
    events: [
      makeEvent("observation", { url: "https://example.com", title: "Example" }),
    ],
    stepCount: 5,
  });

  const result = await refineRun(task, baseline, async () => {
    const r = makeLoopResult({
      run: makeRun({ status: "failed" }),
      stepCount: 10,
    });
    r.classification = { kind: "agent-error", confidence: 0.8 };
    return r;
  });

  assert.equal(result.attempted, true);
  assert.ok(result.comparison);
  assert.match(result.comparison!.conclusion, /regression/iu);
  assert.equal(result.iterations, 1);
  assert.equal(result.stoppedEarly, true);
});

test("refineRun respects maxIterations option", async () => {
  const task = makeTask({ mode: "experiment" });
  const baseline = makeLoopResult({
    run: makeRun({
      startedAt: "2026-05-06T10:00:00.000Z",
      finishedAt: "2026-05-06T10:00:42.000Z",
    }),
    events: [
      makeEvent("observation", { url: "https://example.com", title: "Example" }),
    ],
    stepCount: 5,
  });

  let callCount = 0;
  const result = await refineRun(
    task,
    baseline,
    async () => {
      callCount++;
      return makeLoopResult({ stepCount: 3 });
    },
    { maxIterations: 1 },
  );

  assert.equal(callCount, 1);
  assert.equal(result.iterations, 1);
});
