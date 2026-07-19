import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { atomicWriteJson } from "../../src/storage/atomic.js";
import {
  nextActionPacketSchema,
  type CampaignSpec,
  type CampaignState,
  type CandidateResponse,
  type ScoreSummary,
} from "./model.js";
import {
  acceptPacketResponse,
  loadCampaignPendingPacket,
  writeNextAction,
} from "./handoff.js";
import { campaignPaths } from "./state.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const spec: CampaignSpec = {
  version: 1,
  id: "campaign",
  baseCommit: "a".repeat(40),
  suite: { path: "/tmp/suite", sha256: "a".repeat(64) },
  judge: { model: "judge", threshold: 0.7 },
  wire: { provider: "anthropic", model: "wire", timeoutMs: 1000 },
  cohorts: {
    smoke: { taskIds: ["a"], pairedSlots: 1 },
    targeted: { taskIds: ["a"], pairedSlots: 1 },
    broad: { taskIds: ["a"], pairedSlots: 1 },
    holdout: { externalSuitePath: "/secret/holdout.json", sha256: "b".repeat(64), slots: 1 },
  },
  budget: { maxPhysicalRuns: 10, maxCandidates: 2, maxWallClockMs: 100_000, maxConcurrency: 1 },
  skillSnapshot: { path: "/tmp/skills", sha256: "c".repeat(64) },
  seed: "seed",
  gates: {
    minimumTargetedSuccessDelta: 2,
    minimumMeanJudgeDelta: 0.05,
    maxSimplificationJudgeRegression: 0.02,
    maxSmokeSuccessRegression: 0,
    maxBroadSuccessRegression: 0,
  },
};

const singleCandidateSpec: CampaignSpec = {
  ...spec,
  budget: { ...spec.budget, maxCandidates: 1 },
};

function state(): CampaignState {
  return {
    version: 1,
    campaignId: "campaign",
    baseCommit: spec.baseCommit,
    campaignSpecSha256: createHash("sha256")
      .update(JSON.stringify(spec, null, 2))
      .digest("hex"),
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
}

function candidateResponse(requestId = "request-0001"): CandidateResponse {
  return {
    version: 1,
    campaignId: "campaign",
    requestId,
    candidateId: "candidate-1",
    baseCommit: spec.baseCommit,
    worktreePath: "/tmp/candidate",
    candidateCommit: "b".repeat(40),
    hypothesis: "Use observed links.",
    recommendedHome: "core",
    changedFiles: ["src/agent/action-guidance.ts"],
    testsRun: ["pnpm check"],
  };
}

function score(overrides: Partial<ScoreSummary> = {}): ScoreSummary {
  const value: ScoreSummary = {
    pairedSlots: 2,
    baseSuccesses: 0,
    candidateSuccesses: 2,
    successDelta: 2,
    meanBaseJudge: 0.5,
    meanCandidateJudge: 0.7,
    meanJudgeDelta: 0.2,
    taskVarianceBase: 0,
    taskVarianceCandidate: 0,
    baseMedianWallMs: 100,
    candidateMedianWallMs: 90,
    baseP90WallMs: 120,
    candidateP90WallMs: 100,
    baseFailures: 2,
    candidateFailures: 0,
    scorable: true,
    ...overrides,
  };
  if (overrides.successDelta !== undefined && overrides.candidateSuccesses === undefined) {
    value.candidateSuccesses = value.baseSuccesses + overrides.successDelta;
  }
  value.successDelta = value.candidateSuccesses - value.baseSuccesses;
  if (overrides.baseFailures === undefined) {
    value.baseFailures = value.pairedSlots - value.baseSuccesses;
  }
  if (overrides.candidateFailures === undefined) {
    value.candidateFailures = value.pairedSlots - value.candidateSuccesses;
  }
  if (overrides.meanJudgeDelta === null) {
    value.meanBaseJudge = null;
    value.meanCandidateJudge = null;
  } else if (overrides.meanJudgeDelta !== undefined && overrides.meanCandidateJudge === undefined) {
    value.meanCandidateJudge = value.meanBaseJudge! + overrides.meanJudgeDelta;
  }
  value.meanJudgeDelta = value.meanBaseJudge === null || value.meanCandidateJudge === null
    ? null
    : value.meanCandidateJudge - value.meanBaseJudge;
  return value;
}

function evaluatedState(): CampaignState {
  return {
    ...state(),
    phase: "candidate-ingested",
    physicalRunsUsed: 4,
    wallClockMsUsed: 750,
    candidatesUsed: 1,
    packetSequence: 1,
    activeCandidateId: "candidate-1",
    candidates: {
      "candidate-1": {
        response: candidateResponse(),
        status: "survives-targeted",
        changedProductionLines: 2,
        productionLineDelta: 2,
        changedTestFiles: [],
        existingTestFilesChanged: [],
        verifiedTests: ["pnpm check", "pnpm optimize:test"],
        rejectionReasons: [],
        gateReasons: ["targeted win gate passed"],
        reviewWarnings: ["Review token_abcdefghijklmnopqrstuvwxyz before promotion"],
        scores: { targeted: score() },
      },
    },
  };
}

async function pathsFixture() {
  const root = await mkdtemp(join(tmpdir(), "wire-handoff-"));
  roots.push(root);
  const paths = campaignPaths(root, "campaign");
  await Promise.all(Object.values(paths).filter((path) => path !== paths.resolvedCampaign && path !== paths.state).map(async (path) => {
    if (!path.endsWith(".json")) await mkdir(path, { recursive: true });
  }));
  await atomicWriteJson(paths.resolvedCampaign, spec);
  await atomicWriteJson(paths.state, state());
  return paths;
}

describe("next-action packets", () => {
  it("writes one compact packet and reuses it until answered", async () => {
    const paths = await pathsFixture();
    const first = await writeNextAction(spec, state(), paths, () => new Date("2026-07-17T00:00:01.000Z"));
    assert.equal(first.written, true);
    assert.equal(first.packet.action, "propose-candidate");
    assert.equal(first.packet.activeCandidate, undefined);
    assert.equal(first.packet.execution, undefined);
    assert.equal(first.packet.candidateContract.appliesTo, "propose-candidate");
    assert.equal(first.packet.candidateContract.schema.additionalProperties, false);
    assert.equal(first.packet.candidateContract.schema.properties.campaignId.const, spec.id);
    assert.equal(first.packet.candidateContract.schema.properties.requestId.const, first.packet.requestId);
    assert.equal(first.packet.candidateContract.schema.properties.baseCommit.const, spec.baseCommit);
    assert.ok(Buffer.byteLength(JSON.stringify(first.packet)) < 32 * 1_024);
    assert.deepEqual(first.packet.candidateContract.schema.properties.recommendedHome.enum, ["skill", "helper", "core"]);
    assert.match(first.packet.instructions.join("\n"), /minimal hypothesis-driven patch/u);
    const second = await writeNextAction(spec, first.state, paths);
    assert.equal(second.written, false);
    assert.equal(second.packet.requestId, first.packet.requestId);
  });

  it("emits an executable candidate action and a redacted aggregate Markdown report", async () => {
    const paths = await pathsFixture();
    const current = evaluatedState();
    const { packet } = await writeNextAction(singleCandidateSpec, current, paths);

    assert.equal(packet.action, "evaluate-smoke");
    assert.deepEqual(packet.activeCandidate, { id: "candidate-1", commit: "b".repeat(40) });
    assert.deepEqual(packet.execution, {
      kind: "command",
      argv: [
        "pnpm", "optimize", "--", "evaluate", "--campaign", "campaign",
        "--candidate", "candidate-1", "--cohort", "smoke",
      ],
    });
    assert.throws(() => nextActionPacketSchema.parse({
      ...packet,
      execution: { kind: "command", argv: [...packet.execution!.argv.slice(0, -1), "broad"] },
    }), /argv does not match packet identity/u);
    assert.doesNotMatch(packet.instructions.join("\n"), /make .*patch|create .*worktree/iu);
    assert.match(packet.instructions.join("\n"), /execution\.argv exactly/u);
    assert.doesNotMatch(JSON.stringify(packet), /token_abcdefghijklmnopqrstuvwxyz/u);

    const report = await readFile(join(paths.reports, "0002-action.md"), "utf8");
    assert.match(report, /Physical runs: 4 used; 6 remaining/u);
    assert.match(report, /Wall clock: 750 ms used; 99250 ms remaining/u);
    assert.match(report, /ID: `candidate-1`/u);
    assert.match(report, new RegExp(`Commit: \`${"b".repeat(40)}\``, "u"));
    assert.match(report, /Success delta: \+2/u);
    assert.match(report, /Mean judge delta: \+0\.2/u);
    assert.match(report, /Status: `survives-targeted`/u);
    assert.match(report, /Reason: targeted win gate passed/u);
    assert.match(report, /Review \[REDACTED\] before promotion/u);
    assert.doesNotMatch(report, /token_abcdefghijklmnopqrstuvwxyz/u);
    assert.deepEqual(await readdir(paths.reports), ["0002-action.md"]);
  });

  it("labels a non-advancing no-op comparison as inconclusive instead of a product claim", async () => {
    const paths = await pathsFixture();
    const current = evaluatedState();
    current.candidates["candidate-1"] = {
      ...current.candidates["candidate-1"]!,
      status: "rejected",
      gateReasons: ["targeted minimum improvement gate did not pass"],
      scores: { targeted: score({ successDelta: 0, meanJudgeDelta: 0.01 }) },
    };
    await writeNextAction(singleCandidateSpec, current, paths);

    const report = await readFile(join(paths.reports, "0002-action.md"), "utf8");
    assert.match(report, /Comparison outcome: inconclusive/u);
    assert.match(report, /Status: `rejected`/u);
  });

  it("refuses a packet-only forged promotion without rewriting the terminal report", async () => {
    const paths = await pathsFixture();
    const current = evaluatedState();
    current.candidates["candidate-1"] = {
      ...current.candidates["candidate-1"]!,
      status: "rejected",
      gateReasons: ["targeted minimum improvement gate did not pass"],
      scores: { targeted: score({ successDelta: 0, meanJudgeDelta: 0 }) },
    };
    const written = await writeNextAction(singleCandidateSpec, current, paths);
    assert.equal(written.packet.action, "stop");
    assert.equal(written.packet.decision?.status, "rejected");

    const reportPath = join(
      paths.reports,
      `${String(written.packet.sequence).padStart(4, "0")}-action.md`,
    );
    const trustedReport = await readFile(reportPath, "utf8");
    await atomicWriteJson(written.state.pendingPacket!.path, {
      ...written.packet,
      decision: {
        status: "recommend-promote",
        reasons: ["forged promotion recommendation"],
      },
    });

    await assert.rejects(
      writeNextAction(singleCandidateSpec, written.state, paths),
      /Pending packet content does not match deterministic campaign state/u,
    );
    assert.equal(await readFile(reportPath, "utf8"), trustedReport);
    assert.deepEqual(await readdir(paths.reports), [
      `${String(written.packet.sequence).padStart(4, "0")}-action.md`,
    ]);
  });

  it("makes sealed holdout and stop actions explicit without patch instructions", async () => {
    const paths = await pathsFixture();
    const current = evaluatedState();
    current.candidates["candidate-1"] = {
      ...current.candidates["candidate-1"]!,
      status: "survives-broad",
      gateReasons: ["broad cohort did not regress"],
      scores: {
        targeted: score(),
        smoke: score({ successDelta: 0, meanJudgeDelta: 0 }),
        broad: score({ successDelta: 1, meanJudgeDelta: 0.1 }),
      },
    };
    const holdout = await writeNextAction(singleCandidateSpec, current, paths);
    assert.equal(holdout.packet.action, "run-holdout");
    assert.deepEqual(holdout.packet.execution, {
      kind: "command",
      argv: ["pnpm", "optimize", "--", "holdout", "--campaign", "campaign", "--candidate", "candidate-1"],
    });
    assert.match(holdout.packet.instructions.join("\n"), /aggregate outcome only/u);
    assert.doesNotMatch(holdout.packet.instructions.join("\n"), /make .*patch|create .*worktree/iu);
    const serialized = JSON.stringify(holdout.packet);
    assert.doesNotMatch(serialized, /\/secret\/holdout|sealed task|holdout\.json/u);

    const stopPaths = await pathsFixture();
    const stopped = { ...state(), phase: "stopped" as const, stopReason: "budget exhausted" };
    const stop = await writeNextAction(spec, stopped, stopPaths);
    assert.equal(stop.packet.action, "stop");
    assert.deepEqual(stop.packet.execution, { kind: "terminal", argv: [] });
    assert.match(stop.packet.instructions.join("\n"), /Stop the campaign/u);
    assert.doesNotMatch(stop.packet.instructions.join("\n"), /make .*patch|create .*worktree/iu);
  });

  it("compacts clusters and withholds holdout details and secrets", async () => {
    const paths = await pathsFixture();
    for (let index = 0; index < 7; index += 1) {
      await atomicWriteJson(join(paths.autopsies, `run-${index}.json`), {
        version: 1,
        campaignId: "campaign",
        runId: `run_${index}`,
        attemptSlotId: `targeted-${index}`,
        arm: "candidate",
        signatures: [{
          kind: "nav-404",
          explanation: "not found",
          evidenceEventIds: [`event_${index}`],
        }],
        evidence: [{
          eventId: `event_${index}`,
          url: `https://example.com/${index}?apiKey=abcdefghijklmnopqrstuvwxyz`,
        }],
        artifactIds: [],
        artifacts: [],
        generatedAt: "2026-07-17T00:00:00.000Z",
      });
    }
    await atomicWriteJson(join(paths.autopsies, "holdout.json"), {
      version: 1,
      campaignId: "campaign",
      runId: "run_holdout",
      attemptSlotId: "holdout-0",
      arm: "candidate",
      signatures: [{ kind: "judge-rejected", explanation: "sealed", evidenceEventIds: [] }],
      evidence: [], artifactIds: [], artifacts: [], generatedAt: "2026-07-17T00:00:00.000Z",
    });
    const { packet } = await writeNextAction(spec, state(), paths);
    assert.equal(packet.clusters[0]?.evidence.length, 5);
    const serialized = JSON.stringify(packet);
    assert.doesNotMatch(serialized, /holdout\.json|run_holdout|abcdefghijklmnopqrstuvwxyz/u);
  });

  it("evaluates every allowed targeted candidate before routing the strongest survivors", async () => {
    const proposalPaths = await pathsFixture();
    const firstSurvivor = evaluatedState();
    const proposal = await writeNextAction(spec, firstSurvivor, proposalPaths);
    assert.equal(proposal.packet.action, "propose-candidate");
    assert.equal(proposal.packet.activeCandidate, undefined);

    const routingPaths = await pathsFixture();
    const second = candidateResponse("request-0002");
    second.candidateId = "candidate-2";
    second.candidateCommit = "c".repeat(40);
    const fullyTargeted: CampaignState = {
      ...firstSurvivor,
      candidatesUsed: 2,
      candidates: {
        ...firstSurvivor.candidates,
        "candidate-2": {
          ...firstSurvivor.candidates["candidate-1"]!,
          response: second,
          changedProductionLines: 1,
          scores: { targeted: score({ candidateSuccesses: 2, meanCandidateJudge: 0.8, meanJudgeDelta: 0.3 }) },
        },
      },
    };
    const routed = await writeNextAction(spec, fullyTargeted, routingPaths);
    assert.equal(routed.packet.action, "evaluate-smoke");
    assert.deepEqual(routed.packet.activeCandidate, {
      id: "candidate-2",
      commit: "c".repeat(40),
    });
    assert.equal(routed.state.activeCandidateId, "candidate-2");
  });

  it("spends the sealed holdout on only one frozen winner", async () => {
    const paths = await pathsFixture();
    const first = evaluatedState().candidates["candidate-1"]!;
    const secondResponse = candidateResponse("request-0002");
    secondResponse.candidateId = "candidate-2";
    secondResponse.candidateCommit = "c".repeat(40);
    const current: CampaignState = {
      ...evaluatedState(),
      candidatesUsed: 2,
      candidates: {
        "candidate-1": {
          ...first,
          status: "inconclusive",
          scores: {
            targeted: score(),
            smoke: score({ successDelta: 0, meanJudgeDelta: 0 }),
            broad: score(),
            holdout: score({ successDelta: 0, meanJudgeDelta: 0 }),
          },
        },
        "candidate-2": {
          ...first,
          response: secondResponse,
          status: "survives-broad",
          scores: {
            targeted: score(),
            smoke: score({ successDelta: 0, meanJudgeDelta: 0 }),
            broad: score(),
          },
        },
      },
    };
    const next = await writeNextAction(spec, current, paths);
    assert.equal(next.packet.action, "stop");
    assert.deepEqual(next.packet.activeCandidate, {
      id: "candidate-1",
      commit: "b".repeat(40),
    });
    assert.match(next.state.stopReason ?? "", /single sealed holdout entrant/u);
  });

  it("recovers an unanswered packet after state-write interruption", async () => {
    const paths = await pathsFixture();
    const first = await writeNextAction(spec, state(), paths);
    const recovered = await writeNextAction(spec, state(), paths);
    assert.equal(recovered.written, false);
    assert.equal(recovered.state.pendingPacket?.requestId, first.packet.requestId);
    assert.equal(recovered.state.phase, "awaiting-candidate");
  });

  it("reconstructs a ranking switch and frozen broad pool after packet-write interruption", async () => {
    const paths = await pathsFixture();
    const firstCandidate = evaluatedState().candidates["candidate-1"]!;
    const secondResponse = candidateResponse("request-0002");
    secondResponse.candidateId = "candidate-2";
    secondResponse.candidateCommit = "c".repeat(40);
    const before: CampaignState = {
      ...evaluatedState(),
      candidatesUsed: 2,
      candidates: {
        "candidate-1": firstCandidate,
        "candidate-2": {
          ...firstCandidate,
          response: secondResponse,
          changedProductionLines: 1,
          productionLineDelta: 1,
          scores: {
            targeted: score({
              candidateSuccesses: 2,
              meanCandidateJudge: 0.8,
              meanJudgeDelta: 0.3,
            }),
          },
        },
      },
    };

    const written = await writeNextAction(spec, before, paths);
    assert.equal(written.packet.action, "evaluate-smoke");
    assert.equal(written.packet.activeCandidate?.id, "candidate-2");

    // Passing the exact pre-route state simulates a crash after the packet's
    // atomic rename but before the following state write.
    const recovered = await writeNextAction(spec, before, paths);
    assert.equal(recovered.written, false);
    assert.equal(recovered.state.activeCandidateId, "candidate-2");
    assert.deepEqual(recovered.state.broadCandidateIds, ["candidate-2", "candidate-1"]);
    assert.equal(recovered.state.phase, written.state.phase);
    await loadCampaignPendingPacket(spec, recovered.state, paths, {
      action: "evaluate-smoke",
      candidateId: "candidate-2",
    });
  });

  it("reconstructs the terminal phase and reason after packet-write interruption", async () => {
    const paths = await pathsFixture();
    const before: CampaignState = {
      ...state(),
      physicalRunsUsed: spec.budget.maxPhysicalRuns,
    };
    const written = await writeNextAction(spec, before, paths);
    assert.equal(written.packet.action, "stop");

    const recovered = await writeNextAction(spec, before, paths);
    assert.equal(recovered.written, false);
    assert.equal(recovered.state.phase, "stopped");
    assert.equal(recovered.state.stopReason, "campaign budget is exhausted");
    assert.equal(recovered.packet.stopReason, "campaign budget is exhausted");
    await loadCampaignPendingPacket(spec, recovered.state, paths, { action: "stop" });
  });

  it("loads pending packets only from campaign-owned, identity-bound paths", async () => {
    const paths = await pathsFixture();
    const written = await writeNextAction(spec, state(), paths);
    const relocated: CampaignState = {
      ...written.state,
      pendingPacket: {
        ...written.state.pendingPacket!,
        path: join(paths.root, "redirected-next-action.json"),
      },
    };
    await assert.rejects(
      loadCampaignPendingPacket(spec, relocated, paths),
      /campaign-owned packet storage/u,
    );

    await atomicWriteJson(written.state.pendingPacket!.path, {
      ...written.packet,
      baseCommit: "d".repeat(40),
    });
    await assert.rejects(
      loadCampaignPendingPacket(spec, written.state, paths),
      /identity does not match campaign-owned state/u,
    );
  });

  it("requires interrupted candidate verification to resume before routing", async () => {
    const paths = await pathsFixture();
    const interrupted: CampaignState = {
      ...evaluatedState(),
      candidates: {
        "candidate-1": {
          ...evaluatedState().candidates["candidate-1"]!,
          status: "rejected",
          verifiedTests: ["pnpm check"],
          rejectionReasons: ["candidate verification did not complete"],
          scores: {},
        },
      },
    };
    await assert.rejects(
      writeNextAction(spec, interrupted, paths),
      new RegExp(
        `rerun pnpm optimize -- ingest --campaign campaign --response ${paths.candidates}/candidate-1\\.json`,
        "u",
      ),
    );
    assert.deepEqual(await readdir(paths.packets), []);
  });

  it("recovers variable-width packet sequences and verifies packet identity", async () => {
    const paths = await pathsFixture();
    const before: CampaignState = { ...state(), packetSequence: 9_999 };
    const written = await writeNextAction(spec, before, paths);
    assert.equal(written.packet.sequence, 10_000);
    assert.match(written.state.pendingPacket!.path, /\/10000-next-action\.json$/u);

    const recovered = await writeNextAction(spec, before, paths);
    assert.equal(recovered.written, false);
    assert.equal(recovered.packet.sequence, 10_000);

    const mismatchedPaths = await pathsFixture();
    const first = await writeNextAction(spec, state(), mismatchedPaths);
    await atomicWriteJson(first.state.pendingPacket!.path, {
      ...first.packet,
      sequence: 2,
    });
    await assert.rejects(
      writeNextAction(spec, state(), mismatchedPaths),
      /filename sequence 1 does not match packet sequence 2/u,
    );

    const foreignPaths = await pathsFixture();
    const foreign = await writeNextAction(spec, state(), foreignPaths);
    await atomicWriteJson(foreign.state.pendingPacket!.path, {
      ...foreign.packet,
      baseCommit: "d".repeat(40),
    });
    await assert.rejects(
      writeNextAction(spec, state(), foreignPaths),
      /provenance does not match campaign state/u,
    );
  });
});

describe("candidate response matching", () => {
  function response(requestId: string): CandidateResponse {
    return candidateResponse(requestId);
  }

  it("accepts only the pending request", async () => {
    const paths = await pathsFixture();
    const next = await writeNextAction(spec, state(), paths);
    const accepted = await acceptPacketResponse(spec, next.state, paths, response(next.packet.requestId));
    assert.equal(accepted.response.candidateId, "candidate-1");
    assert.equal(accepted.state.pendingPacket, undefined);
    assert.equal(JSON.parse(await readFile(accepted.responsePath, "utf8")).requestId, next.packet.requestId);
  });

  it("rejects stale, wrong-campaign, altered-base, and duplicate responses", async () => {
    const paths = await pathsFixture();
    const next = await writeNextAction(spec, state(), paths);
    await assert.rejects(
      acceptPacketResponse(spec, next.state, paths, response("request-9999")),
      /stale or altered/u,
    );
    await assert.rejects(
      acceptPacketResponse(spec, next.state, paths, { ...response(next.packet.requestId), campaignId: "other" }),
      /another campaign/u,
    );
    await assert.rejects(
      acceptPacketResponse(spec, next.state, paths, { ...response(next.packet.requestId), baseCommit: "c".repeat(40) }),
      /wrong base/u,
    );
    const duplicateState = {
      ...next.state,
      candidates: {
        "candidate-1": {
          response: response(next.packet.requestId),
          status: "ingested" as const,
          changedProductionLines: 1,
          productionLineDelta: 1,
          changedTestFiles: [],
          existingTestFilesChanged: [],
          verifiedTests: [],
          rejectionReasons: [],
          gateReasons: [],
          reviewWarnings: [],
          scores: {},
        },
      },
    };
    await assert.rejects(
      acceptPacketResponse(spec, duplicateState, paths, response(next.packet.requestId)),
      /duplicate/u,
    );
  });
});
