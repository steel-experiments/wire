// ABOUTME: Content tests for task metric computation, aggregation, and the
// ABOUTME: evaluation report formatter.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type { Run, TraceEvent } from "../shared/types.js";

import { aggregateMetrics, computeTaskMetrics, formatEvaluationReport } from "./metrics.js";

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: createId("run"),
    taskId: createId("task"),
    status: "succeeded",
    classification: { kind: "task-complete", confidence: 0.9 },
    ...overrides,
  };
}

function makeEvent(kind: TraceEvent["kind"], ts: string, payload: TraceEvent["payload"] = {}): TraceEvent {
  return { id: createId("event"), runId: createId("run"), ts, kind, payload };
}

test("computeTaskMetrics counts event kinds and derives success from classification", () => {
  const run = makeRun();
  const events: TraceEvent[] = [
    makeEvent("observation", "2026-06-10T00:00:00.000Z"),
    makeEvent("code-exec", "2026-06-10T00:00:01.000Z"),
    makeEvent("code-result", "2026-06-10T00:00:02.000Z", { ok: true }),
    makeEvent("error", "2026-06-10T00:00:03.000Z", { message: "boom" }),
    makeEvent("policy-check", "2026-06-10T00:00:04.000Z"),
  ];

  const metrics = computeTaskMetrics(run, events, 2);

  assert.equal(metrics.success, true);
  assert.equal(metrics.classification, "task-complete");
  assert.equal(metrics.codeExecutions, 1);
  assert.equal(metrics.observations, 1);
  assert.equal(metrics.errors, 1);
  assert.equal(metrics.artifacts, 2);
  assert.equal(metrics.policyChecks, 1);
  assert.equal(metrics.durationMs, 4000);
});

test("computeTaskMetrics treats an unclassified run as an unconfident ambiguous failure", () => {
  const run = makeRun({ classification: undefined as never });
  delete (run as Partial<Run>).classification;

  const metrics = computeTaskMetrics(run, [], 0);

  assert.equal(metrics.success, false);
  assert.equal(metrics.classification, "ambiguous");
  assert.equal(metrics.confidence, 0);
});

test("aggregateMetrics computes rates and breakdown; empty input yields zeros", () => {
  const run1 = makeRun();
  const run2 = makeRun({ classification: { kind: "site-error", confidence: 0.5 } });
  const aggregate = aggregateMetrics([
    computeTaskMetrics(run1, [], 1),
    computeTaskMetrics(run2, [], 0),
  ]);

  assert.equal(aggregate.totalRuns, 2);
  assert.equal(aggregate.successRate, 0.5);
  assert.equal(aggregate.avgConfidence, 0.7);
  assert.equal(aggregate.classificationBreakdown["task-complete"], 1);
  assert.equal(aggregate.classificationBreakdown["site-error"], 1);

  const empty = aggregateMetrics([]);
  assert.equal(empty.totalRuns, 0);
  assert.equal(empty.successRate, 0);
});

test("formatEvaluationReport marks failing runs FAIL and includes totals", () => {
  const passing = computeTaskMetrics(makeRun(), [], 1);
  const failing = computeTaskMetrics(
    makeRun({ classification: { kind: "agent-error", confidence: 0.8 } }),
    [],
    0,
  );
  const text = formatEvaluationReport([passing, failing], aggregateMetrics([passing, failing]));

  assert.match(text, /Total runs: {5}2/u);
  assert.match(text, /Success rate: {3}50\.0%/u);
  assert.ok(text.includes(`[PASS] ${passing.runId}`));
  assert.ok(text.includes(`[FAIL] ${failing.runId}`));
});
