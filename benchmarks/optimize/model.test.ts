import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  autopsySchema,
  campaignRecipeSchema,
  campaignSpecSchema,
  campaignStateSchema,
  candidateResponseSchema,
  hasRequiredCandidateChecks,
  physicalResultSchema,
  scoreSummarySchema,
} from "./model.js";

const sha = "a".repeat(64);
const commit = "b".repeat(40);

function validRecipe(): Record<string, unknown> {
  return {
    version: 1,
    id: "navigation-2026-07",
    baseCommit: commit,
    suite: { path: "fixtures/suite.json", sha256: sha },
    judge: { model: "judge-model", threshold: 0.7 },
    wire: { provider: "anthropic", model: "wire-model", timeoutMs: 60_000 },
    cohorts: {
      smoke: { taskIds: ["task-a"], pairedSlots: 1 },
      targeted: { taskIds: ["task-a"], pairedSlots: 2 },
      broad: { taskIds: ["task-a", "task-b"], pairedSlots: 2 },
    },
    budget: {
      maxPhysicalRuns: 10,
      maxCandidates: 2,
      maxWallClockMs: 600_000,
      maxConcurrency: 1,
    },
    skillSnapshot: { path: "fixtures/skills", sha256: sha },
    seed: "fixed-seed",
    gates: {
      minimumTargetedSuccessDelta: 2,
      minimumMeanJudgeDelta: 0.05,
      maxSimplificationJudgeRegression: 0.02,
      maxSmokeSuccessRegression: 0,
      maxBroadSuccessRegression: 0,
    },
  };
}

describe("campaign contracts", () => {
  it("persists the manifest's explicit promotion gates", () => {
    const campaign = campaignRecipeSchema.parse(validRecipe());
    assert.deepEqual(campaign.gates, {
      minimumTargetedSuccessDelta: 2,
      minimumMeanJudgeDelta: 0.05,
      maxSimplificationJudgeRegression: 0.02,
      maxSmokeSuccessRegression: 0,
      maxBroadSuccessRegression: 0,
    });
  });

  it("rejects a manifest that leaves promotion gates implicit", () => {
    const input = validRecipe();
    delete input.gates;
    assert.throws(() => campaignRecipeSchema.parse(input));
  });

  it("forbids smoke or broad success-regression allowances", () => {
    for (const field of ["maxSmokeSuccessRegression", "maxBroadSuccessRegression"] as const) {
      const input = validRecipe();
      input.gates = { ...(input.gates as Record<string, unknown>), [field]: 1 };
      assert.throws(() => campaignRecipeSchema.parse(input));
    }
  });

  it("rejects unsupported versions and unsafe campaign ids", () => {
    assert.throws(() => campaignRecipeSchema.parse({ ...validRecipe(), version: 2 }));
    assert.throws(() => campaignRecipeSchema.parse({ ...validRecipe(), id: "../escape" }));
    assert.throws(() => campaignRecipeSchema.parse({ ...validRecipe(), id: "Uppercase" }));
  });

  it("rejects missing or malformed hashes", () => {
    const missing = validRecipe();
    missing.suite = { path: "suite.json" };
    assert.throws(() => campaignRecipeSchema.parse(missing));
    assert.throws(() => campaignRecipeSchema.parse({
      ...validRecipe(),
      skillSnapshot: { path: "skills", sha256: "short" },
    }));
  });

  it("rejects duplicate task ids", () => {
    const input = validRecipe();
    input.cohorts = {
      smoke: { taskIds: ["task-a", "task-a"], pairedSlots: 1 },
      targeted: { taskIds: ["task-a"], pairedSlots: 1 },
      broad: { taskIds: ["task-a"], pairedSlots: 1 },
    };
    assert.throws(() => campaignRecipeSchema.parse(input), /duplicate task id/u);
  });

  it("rejects empty budgets, non-positive timeouts, and concurrency above one", () => {
    assert.throws(() => campaignRecipeSchema.parse({ ...validRecipe(), budget: {} }));
    assert.throws(() => campaignRecipeSchema.parse({
      ...validRecipe(),
      wire: { provider: "openai", model: "m", timeoutMs: 0 },
    }));
    assert.throws(() => campaignRecipeSchema.parse({
      ...validRecipe(),
      budget: {
        maxPhysicalRuns: 10,
        maxCandidates: 1,
        maxWallClockMs: 100,
        maxConcurrency: 2,
      },
    }));
  });

  it("requires complete holdout provenance", () => {
    const input = validRecipe();
    input.cohorts = {
      smoke: { taskIds: ["task-a"], pairedSlots: 1 },
      targeted: { taskIds: ["task-a"], pairedSlots: 1 },
      broad: { taskIds: ["task-a"], pairedSlots: 1 },
      holdout: { slots: 2, sha256: sha },
    };
    assert.throws(() => campaignRecipeSchema.parse(input));
  });

  it("requires absolute paths in resolved campaign specs", () => {
    assert.throws(() => campaignSpecSchema.parse(validRecipe()), /must be absolute/u);
    const absolute = validRecipe();
    absolute.suite = { path: "/tmp/suite.json", sha256: sha };
    absolute.skillSnapshot = { path: "/tmp/skills", sha256: sha };
    assert.equal(campaignSpecSchema.parse(absolute).suite.path, "/tmp/suite.json");
  });

  it("requires the state to anchor the exact resolved manifest digest", () => {
    const state: Record<string, unknown> = {
      version: 1,
      campaignId: "navigation-2026-07",
      baseCommit: commit,
      campaignSpecSha256: sha,
      phase: "initialized",
      createdAt: "2026-07-17T00:00:00.000Z",
      updatedAt: "2026-07-17T00:00:00.000Z",
      physicalRunsUsed: 0,
      wallClockMsUsed: 0,
      buildWallClockMsUsed: 0,
      verificationWallClockMsUsed: 0,
      candidatesUsed: 0,
      completedSlots: [],
      builtRevisions: [],
      packetSequence: 0,
      candidates: {},
    };
    assert.equal(campaignStateSchema.parse(state).campaignSpecSha256, sha);
    delete state.campaignSpecSha256;
    assert.throws(() => campaignStateSchema.parse(state));
  });
});

describe("candidate response contract", () => {
  const response = {
    version: 1,
    campaignId: "navigation-2026-07",
    requestId: "request-0001",
    candidateId: "candidate-1",
    baseCommit: commit,
    worktreePath: "/tmp/candidate",
    candidateCommit: "c".repeat(40),
    hypothesis: "Use an observed link after a not-found page.",
    recommendedHome: "core",
    changedFiles: ["src/agent/action-guidance.ts"],
    testsRun: ["pnpm check"],
  };

  it("accepts the versioned response", () => {
    assert.equal(candidateResponseSchema.parse(response).recommendedHome, "core");
  });

  it("rejects traversal and duplicate changed files", () => {
    assert.throws(() => candidateResponseSchema.parse({
      ...response,
      changedFiles: ["../package.json"],
    }));
    assert.throws(() => candidateResponseSchema.parse({
      ...response,
      changedFiles: ["src/a.ts", "src/a.ts"],
    }), /duplicate changed file/u);
    assert.throws(() => candidateResponseSchema.parse({
      ...response,
      changedFiles: ["src\\ambiguous.ts"],
    }));
  });

  it("bounds candidate-authored handoff fields", () => {
    assert.throws(() => candidateResponseSchema.parse({
      ...response,
      hypothesis: "x".repeat(2_001),
    }));
    assert.throws(() => candidateResponseSchema.parse({
      ...response,
      testsRun: Array.from({ length: 51 }, () => "pnpm check"),
    }));
  });
});

describe("candidate verification contract", () => {
  it("rejects traversal-shaped run ids before evidence paths are opened", () => {
    const physical = {
      arm: "candidate",
      status: "completed",
      runId: "run_fixture",
      judgeScore: 0.8,
      success: true,
      wallMs: 10,
      nativeStatus: "succeeded",
      nativeClassification: "success",
      harnessOutputPath: "/tmp/result.jsonl",
      harnessOutputSha256: sha,
      subprocess: { exitCode: 0, signal: null, timedOut: false, wallMs: 10 },
      commit,
      wireRoot: "/tmp/wire-root",
      skillRoot: "/tmp/skill-root",
      startedAt: "2026-07-17T00:00:00.000Z",
      finishedAt: "2026-07-17T00:00:00.010Z",
      stderr: "",
    };
    assert.equal(physicalResultSchema.parse(physical).runId, "run_fixture");
    assert.throws(() => physicalResultSchema.parse({ ...physical, runId: "../../state" }));
    assert.throws(() => autopsySchema.parse({
      version: 1,
      campaignId: "navigation-2026-07",
      runId: "../../state",
      attemptSlotId: "slot-targeted-0001-deadbeef",
      arm: "candidate",
      signatures: [],
      evidence: [],
      artifactIds: [],
      artifacts: [],
      generatedAt: "2026-07-17T00:00:00.000Z",
    }));
  });

  it("requires the exact ordered unique candidate checks", () => {
    assert.equal(hasRequiredCandidateChecks(["pnpm check", "pnpm optimize:test"]), true);
    assert.equal(hasRequiredCandidateChecks(["pnpm check", "pnpm check"]), false);
    assert.equal(hasRequiredCandidateChecks(["x", "y"]), false);
    assert.equal(hasRequiredCandidateChecks(["pnpm optimize:test", "pnpm check"]), false);
  });

  it("rejects impossible persisted score summaries", () => {
    const score = {
      pairedSlots: 2,
      baseSuccesses: 1,
      candidateSuccesses: 2,
      successDelta: 1,
      meanBaseJudge: 0.4,
      meanCandidateJudge: 0.9,
      meanJudgeDelta: 0.5,
      taskVarianceBase: 0,
      taskVarianceCandidate: 0,
      baseMedianWallMs: 80,
      candidateMedianWallMs: 70,
      baseP90WallMs: 90,
      candidateP90WallMs: 75,
      baseFailures: 1,
      candidateFailures: 0,
      scorable: true,
    };
    assert.equal(scoreSummarySchema.parse(score).successDelta, 1);
    assert.throws(() => scoreSummarySchema.parse({ ...score, candidateSuccesses: 3 }));
    assert.throws(() => scoreSummarySchema.parse({ ...score, successDelta: 0 }));
    assert.throws(() => scoreSummarySchema.parse({ ...score, baseFailures: 0 }));
  });
});
