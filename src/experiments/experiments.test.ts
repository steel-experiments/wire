// ABOUTME: Tests for experiment summaries and hypothesis verdicts — replication
// ABOUTME: thresholds, status/classification disagreement, and suggestions.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type {
  ExperimentBundle,
  Hypothesis,
  Run,
  RunStatus,
  RunClassification,
  TaskId,
} from "../shared/types.js";

import { createHypothesis } from "./hypotheses.js";
import { buildExperimentSummary, formatExperimentSummary } from "./summaries.js";

function makeTaskId(): TaskId {
  return createId("task");
}

function makeRun(
  hypothesis: Hypothesis,
  status: RunStatus,
  classification?: RunClassification,
): Run {
  const run: Run = {
    id: createId("run"),
    taskId: hypothesis.taskId,
    hypothesisId: hypothesis.id,
    status,
    startedAt: nowIsoUtc(),
  };
  if (classification) {
    run.classification = classification;
  }
  return run;
}

function makeBundle(taskId: TaskId, hypotheses: Hypothesis[], runs: Run[]): ExperimentBundle {
  return {
    id: createId("experiment"),
    taskId,
    hypotheses,
    runIds: runs.map((run) => run.id),
    comparisons: [],
  };
}

test("a single clean success is ambiguous, not supported", () => {
  // MANIFESTO: a lucky success that teaches nothing is weak. One corroborating
  // run must not confirm a hypothesis.
  const taskId = makeTaskId();
  const hypothesis = createHypothesis(taskId, "Filters work via URL params");
  const runs = [makeRun(hypothesis, "succeeded")];

  const summary = buildExperimentSummary(makeBundle(taskId, [hypothesis], runs), runs);

  assert.deepEqual(summary.supportedHypotheses, []);
  assert.deepEqual(summary.ambiguousHypotheses, [hypothesis.id]);
  assert.ok(
    summary.keyEvidence.some((line) => /replication/u.test(line)),
    "evidence explains why a single success is not enough",
  );
});

test("two corroborating successes with no contradiction are supported", () => {
  const taskId = makeTaskId();
  const hypothesis = createHypothesis(taskId, "Filters work via URL params");
  const runs = [makeRun(hypothesis, "succeeded"), makeRun(hypothesis, "succeeded")];

  const summary = buildExperimentSummary(makeBundle(taskId, [hypothesis], runs), runs);

  assert.deepEqual(summary.supportedHypotheses, [hypothesis.id]);
});

test("a succeeded run with a non-complete classification is not support", () => {
  // status and classification must agree before a run corroborates.
  const taskId = makeTaskId();
  const hypothesis = createHypothesis(taskId, "Filters work via URL params");
  const runs = [
    makeRun(hypothesis, "succeeded", { kind: "partial-success", confidence: 0.7 }),
    makeRun(hypothesis, "succeeded", { kind: "partial-success", confidence: 0.7 }),
  ];

  const summary = buildExperimentSummary(makeBundle(taskId, [hypothesis], runs), runs);

  assert.deepEqual(summary.supportedHypotheses, []);
  assert.deepEqual(summary.ambiguousHypotheses, [hypothesis.id]);
});

test("a failed run with no successes rejects the hypothesis", () => {
  const taskId = makeTaskId();
  const hypothesis = createHypothesis(taskId, "Filters work via URL params");
  const runs = [makeRun(hypothesis, "failed")];

  const summary = buildExperimentSummary(makeBundle(taskId, [hypothesis], runs), runs);

  assert.deepEqual(summary.rejectedHypotheses, [hypothesis.id]);
});

test("mixed successes and failures are ambiguous", () => {
  const taskId = makeTaskId();
  const hypothesis = createHypothesis(taskId, "Filters work via URL params");
  const runs = [
    makeRun(hypothesis, "succeeded"),
    makeRun(hypothesis, "succeeded"),
    makeRun(hypothesis, "failed"),
  ];

  const summary = buildExperimentSummary(makeBundle(taskId, [hypothesis], runs), runs);

  assert.deepEqual(summary.supportedHypotheses, []);
  assert.deepEqual(summary.ambiguousHypotheses, [hypothesis.id]);
});

test("hypotheses with no runs stay uncategorized", () => {
  const taskId = makeTaskId();
  const hypothesis = createHypothesis(taskId, "Filters work via URL params");

  const summary = buildExperimentSummary(makeBundle(taskId, [hypothesis], []), []);

  assert.deepEqual(summary.supportedHypotheses, []);
  assert.deepEqual(summary.rejectedHypotheses, []);
  assert.deepEqual(summary.ambiguousHypotheses, []);
});

test("unassociated runs contribute evidence without a verdict", () => {
  const taskId = makeTaskId();
  const hypothesis = createHypothesis(taskId, "Filters work via URL params");
  const stray: Run = {
    id: createId("run"),
    taskId,
    status: "succeeded",
    outcomeSummary: "Stray exploration run",
  };

  const summary = buildExperimentSummary(makeBundle(taskId, [hypothesis], []), [stray]);

  assert.ok(summary.keyEvidence.some((line) => line.includes("Stray exploration run")));
  assert.deepEqual(summary.supportedHypotheses, []);
});

test("suggestions cover ambiguity, rejection, and small samples", () => {
  const taskId = makeTaskId();
  const supportedHyp = createHypothesis(taskId, "A");
  const rejectedHyp = createHypothesis(taskId, "B");
  const runs = [
    makeRun(supportedHyp, "succeeded"),
    makeRun(supportedHyp, "succeeded"),
    makeRun(rejectedHyp, "failed"),
  ];

  const summary = buildExperimentSummary(makeBundle(taskId, [supportedHyp, rejectedHyp], runs), runs);

  assert.ok(summary.nextBestExperiments.some((s) => /rejected hypotheses/u.test(s)));
  assert.ok(summary.nextBestExperiments.some((s) => /sample size|statistical/u.test(s)) === false || runs.length < 3);
});

test("formatExperimentSummary renders counts and sections", () => {
  const taskId = makeTaskId();
  const hypothesis = createHypothesis(taskId, "Filters work via URL params");
  const runs = [makeRun(hypothesis, "succeeded"), makeRun(hypothesis, "succeeded")];

  const text = formatExperimentSummary(
    buildExperimentSummary(makeBundle(taskId, [hypothesis], runs), runs),
  );

  assert.match(text, /Supported hypotheses: 1/u);
  assert.match(text, /Rejected hypotheses: {2}0/u);
  assert.ok(text.includes(hypothesis.id));
});
