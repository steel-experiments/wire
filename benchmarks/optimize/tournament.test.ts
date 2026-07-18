import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  Attempt,
  CampaignSpec,
  CandidateResponse,
  PhysicalResult,
  ScoreSummary,
} from "./model.js";
import {
  compareCandidates,
  decideGate,
  isDocumentedSimplification,
  scoreAttempts,
} from "./tournament.js";

const spec = {
  version: 1,
  id: "campaign",
  baseCommit: "a".repeat(40),
  suite: { path: "/tmp/suite", sha256: "a".repeat(64) },
  judge: { model: "judge", threshold: 0.7 },
  wire: { provider: "anthropic", model: "wire", timeoutMs: 1000 },
  cohorts: {
    smoke: { taskIds: ["a"], pairedSlots: 1 },
    targeted: { taskIds: ["a"], pairedSlots: 3 },
    broad: { taskIds: ["a"], pairedSlots: 3 },
    holdout: { externalSuitePath: "/tmp/holdout", sha256: "b".repeat(64), slots: 2 },
  },
  budget: { maxPhysicalRuns: 30, maxCandidates: 2, maxWallClockMs: 100_000, maxConcurrency: 1 },
  skillSnapshot: { path: "/tmp/skills", sha256: "c".repeat(64) },
  seed: "seed",
  gates: {
    minimumTargetedSuccessDelta: 2,
    minimumMeanJudgeDelta: 0.05,
    maxSimplificationJudgeRegression: 0.02,
    maxSmokeSuccessRegression: 0,
    maxBroadSuccessRegression: 0,
  },
} satisfies CampaignSpec;

function result(arm: "base" | "candidate", success: boolean, judge: number, wallMs = 100): PhysicalResult {
  return {
    arm,
    status: "completed",
    runId: `run_${arm}`,
    judgeScore: judge,
    success,
    wallMs,
    nativeStatus: success ? "succeeded" : "failed",
    nativeClassification: success ? "task-complete" : "partial-success",
    harnessOutputPath: "/tmp/results.jsonl",
    harnessOutputSha256: "d".repeat(64),
    subprocess: { exitCode: 0, signal: null, timedOut: false, wallMs },
    commit: arm === "base" ? "a".repeat(40) : "b".repeat(40),
    wireRoot: `/tmp/${arm}-root`,
    skillRoot: `/tmp/${arm}-skills`,
    startedAt: "2026-07-17T00:00:00.000Z",
    finishedAt: "2026-07-17T00:00:01.000Z",
    stderr: "",
  };
}

function attempt(index: number, base: [boolean, number], candidate: [boolean, number], taskId = "task-a"): Attempt {
  return {
    version: 1,
    campaignId: "campaign",
    candidateId: "candidate",
    cohort: "targeted",
    slotId: `targeted-${index}`,
    slotIndex: index,
    taskId,
    repetition: index + 1,
    order: ["base", "candidate"],
    results: [result("base", ...base), result("candidate", ...candidate)],
    complete: true,
  };
}

function summary(overrides: Partial<ScoreSummary> = {}): ScoreSummary {
  const pairedSlots = overrides.pairedSlots ?? 3;
  const requestedDelta = overrides.successDelta ?? Math.min(2, pairedSlots);
  let baseSuccesses: number;
  let candidateSuccesses: number;
  if (overrides.baseSuccesses !== undefined && overrides.candidateSuccesses !== undefined) {
    baseSuccesses = overrides.baseSuccesses;
    candidateSuccesses = overrides.candidateSuccesses;
  } else if (overrides.baseSuccesses !== undefined) {
    baseSuccesses = overrides.baseSuccesses;
    candidateSuccesses = overrides.successDelta === undefined
      ? Math.min(3, pairedSlots)
      : baseSuccesses + requestedDelta;
  } else if (overrides.candidateSuccesses !== undefined) {
    candidateSuccesses = overrides.candidateSuccesses;
    baseSuccesses = overrides.successDelta === undefined
      ? Math.min(1, pairedSlots)
      : candidateSuccesses - requestedDelta;
  } else {
    const minimumBase = Math.max(0, -requestedDelta);
    const maximumBase = Math.min(pairedSlots, pairedSlots - requestedDelta);
    baseSuccesses = Math.min(Math.max(1, minimumBase), maximumBase);
    candidateSuccesses = baseSuccesses + requestedDelta;
  }

  const meanBaseJudge = overrides.meanBaseJudge ?? 0.5;
  const meanJudgeDelta = overrides.meanJudgeDelta ?? 0.3;
  const meanCandidateJudge = overrides.meanCandidateJudge
    ?? (meanBaseJudge + meanJudgeDelta);
  return {
    pairedSlots,
    baseSuccesses,
    candidateSuccesses,
    successDelta: overrides.successDelta ?? candidateSuccesses - baseSuccesses,
    meanBaseJudge,
    meanCandidateJudge,
    meanJudgeDelta,
    taskVarianceBase: 0,
    taskVarianceCandidate: 0,
    baseMedianWallMs: 100,
    candidateMedianWallMs: 90,
    baseP90WallMs: 120,
    candidateP90WallMs: 100,
    baseFailures: overrides.baseFailures ?? pairedSlots - baseSuccesses,
    candidateFailures: overrides.candidateFailures ?? pairedSlots - candidateSuccesses,
    scorable: true,
    ...overrides,
  };
}

describe("script-computed tournament score", () => {
  it("reports a clear paired win and wall-time percentiles", () => {
    const score = scoreAttempts([
      attempt(0, [false, 0.4], [true, 0.9]),
      attempt(1, [false, 0.5], [true, 0.8]),
      attempt(2, [true, 0.8], [true, 0.9]),
    ]);
    assert.equal(score.successDelta, 2);
    assert.ok((score.meanJudgeDelta ?? 0) > 0.29);
    assert.equal(score.pairedSlots, 3);
  });

  it("marks an unscorable judge as infrastructure evidence", () => {
    const bad = attempt(0, [true, 0.8], [true, 0.8]);
    bad.results[1] = { ...bad.results[1]!, judgeScore: null };
    assert.equal(scoreAttempts([bad]).scorable, false);
  });

  it("measures task-level variance", () => {
    const score = scoreAttempts([
      attempt(0, [true, 0.8], [true, 0.8], "a"),
      attempt(1, [true, 0.8], [false, 0.2], "a"),
    ]);
    assert.equal(score.taskVarianceCandidate, 0.25);
  });

  it("does not score an attempt containing a duplicate arm result", () => {
    const duplicate = attempt(0, [true, 0.8], [true, 0.8]);
    duplicate.results.push(result("candidate", true, 0.8));
    const score = scoreAttempts([duplicate]);
    assert.equal(score.scorable, false);
    assert.equal(score.pairedSlots, 0);
  });
});

describe("promotion gates", () => {
  it("advances a clear targeted win", () => {
    assert.equal(decideGate({
      cohort: "targeted", score: summary(), expectedPairedSlots: 3, spec,
    }).status, "survives-targeted");
  });

  it("does not advance one lucky slot", () => {
    assert.equal(decideGate({
      cohort: "targeted",
      score: summary({ pairedSlots: 1, successDelta: 1 }),
      expectedPairedSlots: 3,
      spec,
    }).status, "inconclusive");
  });

  it("does not accept overcomplete current evidence", () => {
    assert.equal(decideGate({
      cohort: "targeted",
      score: summary({ pairedSlots: 4 }),
      expectedPairedSlots: 3,
      spec,
    }).status, "inconclusive");
  });

  it("does not consume overcomplete prior evidence", () => {
    assert.equal(decideGate({
      cohort: "broad",
      score: summary({ successDelta: 0, meanJudgeDelta: 0 }),
      expectedPairedSlots: 3,
      spec,
      priorScores: {
        targeted: summary({ pairedSlots: 4 }),
        smoke: summary({ pairedSlots: 1, successDelta: 0, meanJudgeDelta: 0 }),
      },
    }).status, "inconclusive");
  });

  it("does not consume internally impossible summaries", () => {
    for (const score of [
      summary({ pairedSlots: 3, candidateSuccesses: 4 }),
      summary({ baseSuccesses: 1, candidateSuccesses: 3, successDelta: 1 }),
      summary({ meanCandidateJudge: Number.NaN }),
    ]) {
      const decision = decideGate({
        cohort: "targeted", score, expectedPairedSlots: 3, spec,
      });
      assert.equal(decision.status, "inconclusive");
      assert.match(decision.reasons.join(" "), /score summary/u);
    }
  });

  it("rejects a smoke regression", () => {
    assert.equal(decideGate({
      cohort: "broad",
      score: summary({ successDelta: 0, meanJudgeDelta: 0 }),
      expectedPairedSlots: 3,
      spec,
      priorScores: { smoke: summary({ pairedSlots: 1, successDelta: -1 }) },
    }).status, "rejected");
  });

  it("allows a documented simplification within the declared judge tolerance", () => {
    assert.equal(decideGate({
      cohort: "targeted",
      score: summary({ successDelta: 0, meanJudgeDelta: -0.01 }),
      expectedPairedSlots: 3,
      spec,
      documentedSimplification: true,
    }).status, "survives-targeted");
  });

  it("keeps unscorable evidence inconclusive", () => {
    assert.equal(decideGate({
      cohort: "targeted", score: summary({ scorable: false }), expectedPairedSlots: 3, spec,
    }).status, "inconclusive");
  });

  it("rejects before scoring when hard validity fails", () => {
    assert.equal(decideGate({
      cohort: "targeted",
      score: summary(),
      expectedPairedSlots: 3,
      spec,
      hardValidityReasons: ["candidate introduced a policy violation"],
    }).status, "rejected");
  });

  it("cannot recommend promotion without a broader result", () => {
    assert.equal(decideGate({
      cohort: "holdout", score: summary({ pairedSlots: 2, successDelta: 0, meanJudgeDelta: 0 }), expectedPairedSlots: 2, spec,
    }).status, "inconclusive");
  });

  it("rejects a sealed holdout failure", () => {
    assert.equal(decideGate({
      cohort: "holdout",
      score: summary({ pairedSlots: 2, successDelta: -1 }),
      expectedPairedSlots: 2,
      spec,
      priorScores: {
        targeted: summary(),
        smoke: summary({ pairedSlots: 1, successDelta: 0, meanJudgeDelta: 0 }),
        broad: summary(),
      },
    }).status, "rejected");
  });

  it("recommends only after broader and holdout non-regression", () => {
    assert.equal(decideGate({
      cohort: "holdout",
      score: summary({ pairedSlots: 2, successDelta: 0, meanJudgeDelta: 0 }),
      expectedPairedSlots: 2,
      spec,
      priorScores: {
        targeted: summary(),
        smoke: summary({ pairedSlots: 1, successDelta: 0, meanJudgeDelta: 0 }),
        broad: summary(),
      },
    }).status, "recommend-promote");
  });

  it("does not promote when a targeted win becomes only a broad tie", () => {
    const decision = decideGate({
      cohort: "holdout",
      score: summary({ pairedSlots: 2, successDelta: 0, meanJudgeDelta: 0 }),
      expectedPairedSlots: 2,
      spec,
      priorScores: {
        targeted: summary(),
        smoke: summary({ pairedSlots: 1, successDelta: 0, meanJudgeDelta: 0 }),
        broad: summary({ successDelta: 0, meanJudgeDelta: 0 }),
      },
    });
    assert.equal(decision.status, "inconclusive");
    assert.match(decision.reasons.join(" "), /broader result.*preserve/);
  });

  it("allows a documented simplification to promote on broad non-regression", () => {
    assert.equal(decideGate({
      cohort: "holdout",
      score: summary({ pairedSlots: 2, successDelta: 0, meanJudgeDelta: 0 }),
      expectedPairedSlots: 2,
      spec,
      documentedSimplification: true,
      priorScores: {
        targeted: summary({ successDelta: 0, meanJudgeDelta: -0.01 }),
        smoke: summary({ pairedSlots: 1, successDelta: 0, meanJudgeDelta: 0 }),
        broad: summary({ successDelta: 0, meanJudgeDelta: 0 }),
      },
    }).status, "recommend-promote");
  });
});

describe("documented simplification", () => {
  function record(hypothesis: string, productionLineDelta: number) {
    const response = {
      version: 1,
      campaignId: "campaign",
      requestId: "request-1",
      candidateId: "candidate-1",
      baseCommit: "a".repeat(40),
      worktreePath: "/tmp/candidate",
      candidateCommit: "b".repeat(40),
      hypothesis,
      recommendedHome: "core",
      changedFiles: ["src/core.ts"],
      testsRun: ["pnpm check"],
    } satisfies CandidateResponse;
    return { response, productionLineDelta };
  }

  it("does not infer documentation from a negative line delta", () => {
    assert.equal(isDocumentedSimplification(record(
      "Fix the navigation race when a page redirects",
      -20,
    )), false);
  });

  it("requires both an explicit simplification hypothesis and fewer production lines", () => {
    assert.equal(isDocumentedSimplification(record(
      "Simplify navigation by deleting redundant dispatch logic",
      -20,
    )), true);
    assert.equal(isDocumentedSimplification(record(
      "Simplify navigation by deleting redundant dispatch logic",
      1,
    )), false);
  });
});

describe("lexicographic ranking", () => {
  it("uses fewer changed lines only after outcome/reliability/efficiency ties", () => {
    const common = { hardValid: true, targeted: summary(), productionLineDelta: 0 };
    assert.ok(compareCandidates(
      { ...common, changedProductionLines: 2 },
      { ...common, changedProductionLines: 20 },
    ) > 0);
  });

  it("prefers lower variance before simplicity", () => {
    assert.ok(compareCandidates(
      { hardValid: true, targeted: summary({ taskVarianceCandidate: 0 }), productionLineDelta: 10, changedProductionLines: 20 },
      { hardValid: true, targeted: summary({ taskVarianceCandidate: 0.25 }), productionLineDelta: 0, changedProductionLines: 1 },
    ) > 0);
  });

  it("prefers a net deletion over a small addition after measured outcomes tie", () => {
    const common = { hardValid: true, targeted: summary(), changedProductionLines: 100 };
    assert.ok(compareCandidates(
      { ...common, productionLineDelta: -100 },
      { ...common, productionLineDelta: 1, changedProductionLines: 1 },
    ) > 0);
  });
});
