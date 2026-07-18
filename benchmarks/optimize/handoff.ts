import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWriteJson, readJsonFile } from "../../src/storage/atomic.js";
import { containsSecrets, redactSecrets } from "../../src/shared/redact.js";
import {
  autopsySchema,
  candidateResponseJsonSchemaFor,
  candidateResponseSchema,
  hasRequiredCandidateChecks,
  nextActionPacketSchema,
  optimizerCliArgv,
  type CampaignSpec,
  type CampaignState,
  type CandidateResponse,
  type CohortName,
  type NextActionPacket,
  type ScoreSummary,
  type StructuralSignatureKind,
} from "./model.js";
import { listAttempts, saveCampaignState, type CampaignPaths } from "./state.js";
import { compareCandidates, type RankedCandidate } from "./tournament.js";

const MAX_BROAD_SURVIVORS = 2;
const MAX_PACKET_BYTES = 96 * 1_024;

const PROHIBITED_FILES = [
  "benchmarks/compare/**",
  "benchmarks/optimize/**",
  "benchmarks/benchmark_tasks.json",
  "benchmarks/benchmark_tasks.schema.json",
  "package.json",
  "pnpm-lock.yaml",
  "the campaign's frozen suite",
];

const ALLOWED_SCOPE = [
  "skills/** for site/task-specific durable knowledge",
  "thin cross-site helpers under src/browser/**",
  "site-independent core behavior under src/**",
  "focused tests and directly related documentation",
];

function sequenceName(sequence: number, suffix: string): string {
  return `${String(sequence).padStart(4, "0")}-${suffix}`;
}

function packetPathFor(paths: CampaignPaths, sequence: number): string {
  return join(paths.packets, sequenceName(sequence, "next-action.json"));
}

function responsePathFor(paths: CampaignPaths, sequence: number): string {
  return join(paths.packets, sequenceName(sequence, "response.json"));
}

export interface PendingPacketExpectation {
  action?: NextActionPacket["action"];
  candidateId?: string;
}

function assertSafePacket(packet: NextActionPacket): void {
  const serialized = JSON.stringify(packet);
  if (Buffer.byteLength(serialized) > MAX_PACKET_BYTES) {
    throw new Error("Next-action packet exceeds the bounded handoff size");
  }
  if (containsSecrets(serialized)) {
    throw new Error("Next-action packet contains a secret-looking value");
  }
}

function remaining(spec: CampaignSpec, state: CampaignState): NextActionPacket["remainingBudget"] {
  return {
    physicalRuns: Math.max(0, spec.budget.maxPhysicalRuns - state.physicalRunsUsed),
    wallClockMs: Math.max(0, spec.budget.maxWallClockMs - state.wallClockMsUsed),
    candidates: Math.max(0, spec.budget.maxCandidates - state.candidatesUsed),
  };
}

function usage(state: CampaignState): NonNullable<NextActionPacket["budgetUsage"]> {
  return {
    physicalRuns: state.physicalRunsUsed,
    wallClockMs: state.wallClockMsUsed,
    candidates: state.candidatesUsed,
  };
}

function activeRecord(state: CampaignState) {
  return state.activeCandidateId === undefined ? undefined : state.candidates[state.activeCandidateId];
}

function outcomeEntry(state: CampaignState) {
  const active = state.activeCandidateId === undefined
    ? undefined
    : state.candidates[state.activeCandidateId];
  if (active !== undefined) return [state.activeCandidateId!, active] as const;
  return Object.entries(state.candidates).at(-1);
}

function latestScore(record: NonNullable<ReturnType<typeof activeRecord>> | undefined): ScoreSummary | undefined {
  const scores = record?.scores;
  if (scores === undefined) return undefined;
  for (const cohort of ["holdout", "broad", "smoke", "targeted"] as const) {
    if (scores[cohort] !== undefined) return scores[cohort];
  }
  return undefined;
}

function ranked(record: NonNullable<ReturnType<typeof activeRecord>>): RankedCandidate | undefined {
  if (record.scores.targeted === undefined) return undefined;
  return {
    hardValid: record.rejectionReasons.length === 0 && hasRequiredCandidateChecks(record.verifiedTests),
    targeted: record.scores.targeted,
    ...(record.scores.broad === undefined ? {} : { broad: record.scores.broad }),
    ...(record.scores.holdout === undefined ? {} : { holdout: record.scores.holdout }),
    productionLineDelta: record.productionLineDelta,
    changedProductionLines: record.changedProductionLines,
  };
}

type CandidateEntry = readonly [string, NonNullable<ReturnType<typeof activeRecord>>];

function sortCandidates(
  candidates: CandidateEntry[],
): CandidateEntry[] {
  return [...candidates].sort((left, right) => {
    const lhs = ranked(left[1]);
    const rhs = ranked(right[1]);
    if (lhs === undefined || rhs === undefined) return left[0].localeCompare(right[0]);
    return compareCandidates(rhs, lhs) || left[0].localeCompare(right[0]);
  });
}

function requiredPhysicalRuns(spec: CampaignSpec, action: NextActionPacket["action"]): number {
  if (action === "evaluate-targeted") return spec.cohorts.targeted.pairedSlots * 2;
  if (action === "evaluate-smoke") return spec.cohorts.smoke.pairedSlots * 2;
  if (action === "evaluate-broad") return spec.cohorts.broad.pairedSlots * 2;
  if (action === "run-holdout") return (spec.cohorts.holdout?.slots ?? 0) * 2;
  return 0;
}

function routedAction(
  spec: CampaignSpec,
  state: CampaignState,
  paths: CampaignPaths,
): { state: CampaignState; action: NextActionPacket["action"] } {
  if (state.phase === "stopped") return { state, action: "stop" };
  if (state.inFlight !== undefined) {
    throw new Error(`Campaign has interrupted ${state.inFlight.kind} work; resume that exact command before requesting another action`);
  }
  const interruptedVerification = Object.entries(state.candidates).find(([, record]) => (
    record.rejectionReasons.length === 1
    && record.rejectionReasons[0] === "candidate verification did not complete"
  ));
  if (interruptedVerification !== undefined) {
    const [candidateId] = interruptedVerification;
    const responsePath = join(paths.candidates, `${candidateId}.json`);
    throw new Error(
      `Candidate ${candidateId} verification is incomplete; rerun pnpm optimize -- ingest --campaign ${spec.id} --response ${responsePath} before requesting another action`,
    );
  }
  const budget = remaining(spec, state);
  if (budget.physicalRuns === 0 || budget.wallClockMs === 0) {
    return {
      state: {
        ...state,
        phase: "stopped",
        stopReason: "campaign budget is exhausted",
      },
      action: "stop",
    };
  }
  const candidate = activeRecord(state);
  if (candidate?.status === "ingested" && candidate.scores.targeted === undefined) {
    return { state, action: "evaluate-targeted" };
  }
  if (budget.candidates > 0) {
    return {
      state: { ...state, activeCandidateId: undefined },
      action: "propose-candidate",
    };
  }

  const completedHoldout = Object.entries(state.candidates)
    .find(([, record]) => record.scores.holdout !== undefined);
  if (completedHoldout !== undefined) {
    const [candidateId, record] = completedHoldout;
    return {
      state: {
        ...state,
        phase: "stopped",
        activeCandidateId: candidateId,
        stopReason: record.status === "recommend-promote"
          ? "winner is ready for human promotion review"
          : "the single sealed holdout entrant did not earn a promotion recommendation",
      },
      action: "stop",
    };
  }

  const targeted = sortCandidates(Object.entries(state.candidates).filter(([, record]) => (
    record.status !== "rejected"
    && record.status !== "inconclusive"
    && record.scores.targeted !== undefined
  )));
  const broadCandidateIds = state.broadCandidateIds
    ?? targeted.slice(0, MAX_BROAD_SURVIVORS).map(([candidateId]) => candidateId);
  const routingState: CampaignState = state.broadCandidateIds === undefined
    ? { ...state, broadCandidateIds }
    : state;
  const broadPool = broadCandidateIds.flatMap((candidateId) => {
    const record = routingState.candidates[candidateId];
    return record === undefined ? [] : [[candidateId, record] as const];
  });
  for (const [candidateId, record] of broadPool) {
    if (record.scores.smoke === undefined) {
      return { state: { ...routingState, activeCandidateId: candidateId }, action: "evaluate-smoke" };
    }
    if (record.status === "rejected" || record.status === "inconclusive") continue;
    if (record.scores.broad === undefined) {
      return { state: { ...routingState, activeCandidateId: candidateId }, action: "evaluate-broad" };
    }
  }

  const broadSurvivors = sortCandidates(broadPool.filter(([, record]) => (
    (record.status === "survives-broad" || record.status === "recommend-promote")
    && record.scores.broad !== undefined
  )));
  const winner = broadSurvivors[0];
  if (winner === undefined) {
    return {
      state: {
        ...routingState,
        phase: "stopped",
        activeCandidateId: undefined,
        stopReason: "candidate budget is exhausted with no broad survivor",
      },
      action: "stop",
    };
  }
  const [winnerId, winnerRecord] = winner;
  if (winnerRecord.status === "recommend-promote") {
    return {
      state: {
        ...routingState,
        phase: "stopped",
        activeCandidateId: winnerId,
        stopReason: "winner is ready for human promotion review",
      },
      action: "stop",
    };
  }
  if (winnerRecord.scores.holdout === undefined && spec.cohorts.holdout !== undefined) {
    return { state: { ...routingState, activeCandidateId: winnerId }, action: "run-holdout" };
  }
  return {
    state: {
      ...routingState,
      phase: "stopped",
      activeCandidateId: winnerId,
      stopReason: "winner did not earn a holdout promotion recommendation",
    },
    action: "stop",
  };
}

function routedTransition(
  spec: CampaignSpec,
  state: CampaignState,
  paths: CampaignPaths,
): { state: CampaignState; action: NextActionPacket["action"] } {
  const routed = routedAction(spec, state, paths);
  const actionRuns = requiredPhysicalRuns(spec, routed.action);
  const routedState = actionRuns > remaining(spec, routed.state).physicalRuns
    ? {
        ...routed.state,
        phase: "stopped" as const,
        stopReason: `insufficient physical-run budget for ${routed.action}`,
      }
    : routed.state;
  return {
    state: routedState,
    action: routedState.phase === "stopped" ? "stop" : routed.action,
  };
}

function activeCandidateFor(state: CampaignState): NextActionPacket["activeCandidate"] {
  const candidate = activeRecord(state)?.response;
  return candidate === undefined
    ? undefined
    : { id: candidate.candidateId, commit: candidate.candidateCommit };
}

function outcomeCandidateFor(
  entry: ReturnType<typeof outcomeEntry>,
): NextActionPacket["outcomeCandidate"] {
  const response = entry?.[1].response;
  return response === undefined
    ? undefined
    : { id: response.candidateId, commit: response.candidateCommit };
}

function executionFor(
  action: NextActionPacket["action"],
  campaignId: string,
  candidate: NextActionPacket["activeCandidate"],
): NextActionPacket["execution"] {
  if (action === "stop") return { kind: "terminal", argv: [] };
  if (candidate === undefined) return undefined;
  const argv = optimizerCliArgv(action, campaignId, candidate.id);
  return argv === undefined ? undefined : { kind: "command", argv };
}

function instructionsFor(
  action: NextActionPacket["action"],
  execution: NextActionPacket["execution"],
): string[] {
  const immutableEvaluator = "Leave the comparison harness, campaign controller, suites, judge, package scripts, and lockfile unchanged.";
  const bounded = "Do not merge, push, retry live failures, inspect holdout details, or exceed the remaining budget.";
  if (action === "propose-candidate" || action === "inspect-cluster") {
    return [
      "Inspect the bounded structural evidence, then make one minimal hypothesis-driven patch in an isolated clean worktree and commit it.",
      "Treat structural signatures as hypotheses to inspect, not causal truth.",
      "Choose skill, helper, or core using Wire's ownership rule and record recommendedHome.",
      immutableEvaluator,
      "Run pnpm check and pnpm optimize:test; the controller will independently verify them.",
      bounded,
    ];
  }
  if (action === "stop") {
    return [
      "Stop the campaign. Do not create or modify a candidate and do not run another live evaluation.",
      "Preserve the campaign state and review the recorded decision and warnings before any human-controlled promotion.",
      bounded,
    ];
  }
  if (execution?.kind !== "command") throw new Error(`${action} has no executable controller command`);
  if (action === "run-holdout") {
    return [
      "Run execution.argv exactly as recorded; do not modify the frozen candidate.",
      "Do not inspect or disclose the sealed suite, prompts, task IDs, answers, traces, or autopsies; report aggregate outcome only.",
      immutableEvaluator,
      bounded,
    ];
  }
  return [
    "Run execution.argv exactly as recorded; do not modify the frozen candidate.",
    "After the controller records the result, request the next bounded action.",
    immutableEvaluator,
    bounded,
  ];
}

interface ClusterEvidence {
  runId: string;
  autopsyPath: string;
  url?: string;
  title?: string;
  action?: string;
}

async function buildClusters(paths: CampaignPaths): Promise<NextActionPacket["clusters"]> {
  const entries = await readdir(paths.autopsies, { withFileTypes: true });
  const grouped = new Map<StructuralSignatureKind, ClusterEvidence[]>();
  for (const entry of entries.sort((lhs, rhs) => lhs.name.localeCompare(rhs.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(paths.autopsies, entry.name);
    const raw = await readJsonFile(path);
    if (raw === undefined) continue;
    const autopsy = autopsySchema.parse(raw);
    if (autopsy.attemptSlotId.startsWith("holdout-")) continue;
    for (const signature of autopsy.signatures) {
      const evidence = autopsy.evidence
        .filter((item) => signature.evidenceEventIds.includes(item.eventId))
        .at(-1);
      const items = grouped.get(signature.kind) ?? [];
      items.push({
        runId: redactSecrets(autopsy.runId),
        autopsyPath: redactSecrets(path),
        ...(evidence?.url === undefined ? {} : { url: redactSecrets(evidence.url) }),
        ...(evidence?.title === undefined ? {} : { title: redactSecrets(evidence.title) }),
        ...(evidence?.action === undefined ? {} : { action: redactSecrets(evidence.action) }),
      });
      grouped.set(signature.kind, items);
    }
  }
  return [...grouped.entries()]
    .sort((lhs, rhs) => rhs[1].length - lhs[1].length || lhs[0].localeCompare(rhs[0]))
    .slice(0, 3)
    .map(([signature, evidence]) => ({
      signature,
      count: evidence.length,
      warning: "Structural signatures are hypotheses to investigate, not causal truth.",
      evidence: evidence.slice(0, 5),
    }));
}

function packetStateFor(
  transition: ReturnType<typeof routedTransition>,
): CampaignState {
  return transition.action === "propose-candidate"
    ? { ...transition.state, phase: "awaiting-candidate" }
    : transition.state;
}

async function derivePacket(input: {
  spec: CampaignSpec;
  transition: ReturnType<typeof routedTransition>;
  paths: CampaignPaths;
  sequence: number;
  createdAt: string;
}): Promise<{ packet: NextActionPacket; state: CampaignState }> {
  const { spec, paths, sequence, createdAt } = input;
  const state = packetStateFor(input.transition);
  const action = input.transition.action;
  const requestId = `request-${String(sequence).padStart(4, "0")}`;
  const responsePath = responsePathFor(paths, sequence);
  const candidate = activeCandidateFor(state);
  const outcome = outcomeEntry(state);
  const outcomeCandidate = outcomeCandidateFor(outcome);
  const outcomeRecord = outcome?.[1];
  const execution = executionFor(action, spec.id, candidate);
  const packet = nextActionPacketSchema.parse({
    version: 1,
    campaignId: spec.id,
    requestId,
    sequence,
    phase: state.phase,
    baseCommit: spec.baseCommit,
    action,
    ...(candidate === undefined ? {} : { activeCandidate: candidate }),
    ...(outcomeCandidate === undefined ? {} : { outcomeCandidate }),
    ...(execution === undefined ? {} : { execution }),
    ...(action === "stop" ? {
      stopReason: redactSecrets(state.stopReason ?? "campaign stopped").slice(0, 1_000),
    } : {}),
    remainingBudget: remaining(spec, state),
    budgetUsage: usage(state),
    ...(latestScore(outcomeRecord) === undefined ? {} : { score: latestScore(outcomeRecord) }),
    ...(outcomeRecord === undefined ? {} : {
      decision: {
        status: outcomeRecord.status,
        reasons: [...new Set([...outcomeRecord.rejectionReasons, ...outcomeRecord.gateReasons])]
          .slice(0, 20)
          .map((reason) => redactSecrets(reason).slice(0, 1_000)),
      },
    }),
    reviewWarnings: (outcomeRecord?.reviewWarnings ?? [])
      .map((warning) => redactSecrets(warning).slice(0, 1_000)),
    clusters: await buildClusters(paths),
    allowedScope: ALLOWED_SCOPE,
    prohibitedFiles: PROHIBITED_FILES,
    instructions: instructionsFor(action, execution),
    candidateContract: {
      version: 1,
      appliesTo: "propose-candidate",
      responsePath,
      schema: candidateResponseJsonSchemaFor({ campaignId: spec.id, requestId, baseCommit: spec.baseCommit }),
    },
    createdAt,
  });
  assertSafePacket(packet);
  return { packet, state };
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalValue(item)]),
    );
  }
  return value;
}

function packetMaterial(packet: NextActionPacket): unknown {
  return Object.fromEntries(
    Object.entries(packet).filter(([key]) => key !== "createdAt"),
  );
}

function assertPacketMaterial(
  actual: NextActionPacket,
  expected: NextActionPacket,
  label: "Pending" | "Interrupted",
): void {
  const actualMaterial = JSON.stringify(canonicalValue(packetMaterial(actual)));
  const expectedMaterial = JSON.stringify(canonicalValue(packetMaterial(expected)));
  if (actualMaterial !== expectedMaterial) {
    throw new Error(`${label} packet content does not match deterministic campaign state`);
  }
}

function assertPacketIdentity(input: {
  spec: CampaignSpec;
  state: CampaignState;
  paths: CampaignPaths;
  packet: NextActionPacket;
  sequence: number;
}): void {
  const { spec, state, paths, packet, sequence } = input;
  const expectedRequestId = `request-${String(sequence).padStart(4, "0")}`;
  const expectedResponsePath = responsePathFor(paths, sequence);
  if (
    packet.campaignId !== spec.id
    || packet.campaignId !== state.campaignId
    || packet.baseCommit !== spec.baseCommit
    || packet.baseCommit !== state.baseCommit
    || packet.sequence !== sequence
    || packet.requestId !== expectedRequestId
    || resolve(packet.candidateContract.responsePath) !== resolve(expectedResponsePath)
    || packet.candidateContract.schema.properties.campaignId.const !== spec.id
    || packet.candidateContract.schema.properties.requestId.const !== expectedRequestId
    || packet.candidateContract.schema.properties.baseCommit.const !== spec.baseCommit
  ) {
    throw new Error("Pending packet identity does not match campaign-owned state");
  }
}

async function readPendingPacket(
  spec: CampaignSpec,
  state: CampaignState,
  paths: CampaignPaths,
): Promise<NextActionPacket> {
  const pending = state.pendingPacket;
  if (pending === undefined) throw new Error("There is no unanswered packet");
  const expectedPath = packetPathFor(paths, pending.sequence);
  if (resolve(pending.path) !== resolve(expectedPath)) {
    throw new Error("Pending packet path does not match campaign-owned packet storage");
  }
  if (pending.sequence !== state.packetSequence) {
    throw new Error("Pending packet sequence does not match campaign state");
  }
  const raw = await readJsonFile(expectedPath);
  if (raw === undefined) throw new Error(`Pending packet is missing: ${expectedPath}`);
  const packet = nextActionPacketSchema.parse(raw);
  assertSafePacket(packet);
  if (packet.requestId !== pending.requestId) {
    throw new Error("Pending packet request identity does not match campaign state");
  }
  assertPacketIdentity({ spec, state, paths, packet, sequence: pending.sequence });
  return packet;
}

async function assertPendingPacketMaterial(
  spec: CampaignSpec,
  state: CampaignState,
  paths: CampaignPaths,
  packet: NextActionPacket,
): Promise<void> {
  const expected = await derivePacket({
    spec,
    transition: routedTransition(spec, state, paths),
    paths,
    sequence: packet.sequence,
    // Creation time is intentionally not state-derived. All other packet
    // fields are compared to a fresh deterministic projection.
    createdAt: packet.createdAt,
  });
  assertPacketMaterial(packet, expected.packet, "Pending");
}

/**
 * Load the exact campaign-owned pending packet and bind it to persisted state.
 * Callers may additionally require the controller action and candidate target.
 */
export async function loadCampaignPendingPacket(
  spec: CampaignSpec,
  state: CampaignState,
  paths: CampaignPaths,
  expectation: PendingPacketExpectation = {},
): Promise<NextActionPacket> {
  const packet = await readPendingPacket(spec, state, paths);
  await assertPendingPacketMaterial(spec, state, paths, packet);
  if (expectation.action !== undefined && packet.action !== expectation.action) {
    throw new Error(`Pending packet requests ${packet.action}, not ${expectation.action}`);
  }
  if (
    expectation.candidateId !== undefined
    && packet.activeCandidate?.id !== expectation.candidateId
  ) {
    throw new Error(
      `Pending packet targets ${packet.activeCandidate?.id ?? "no candidate"}, not ${expectation.candidateId}`,
    );
  }
  return packet;
}

async function recoverInterruptedPacket(
  spec: CampaignSpec,
  paths: CampaignPaths,
  state: CampaignState,
): Promise<{ packet: NextActionPacket; state: CampaignState } | undefined> {
  const entries = (await readdir(paths.packets)).flatMap((name) => {
    const match = /^(\d+)-next-action\.json$/u.exec(name);
    if (match === null) return [];
    const sequence = Number(match[1]);
    if (
      !Number.isSafeInteger(sequence)
      || sequence <= 0
      || name !== sequenceName(sequence, "next-action.json")
    ) {
      throw new Error(`Invalid next-action packet filename: ${name}`);
    }
    return [{ name, sequence }];
  }).sort((lhs, rhs) => rhs.sequence - lhs.sequence);
  for (const { name, sequence } of entries) {
    const response = responsePathFor(paths, sequence);
    if (await readJsonFile(response) !== undefined) continue;
    const packetPath = packetPathFor(paths, sequence);
    const raw = await readJsonFile(packetPath);
    if (raw === undefined) continue;
    const packet = nextActionPacketSchema.parse(raw);
    assertSafePacket(packet);
    if (packet.sequence !== sequence) {
      throw new Error(`Packet filename sequence ${String(sequence)} does not match packet sequence ${String(packet.sequence)}`);
    }
    if (
      packet.campaignId !== spec.id
      || packet.campaignId !== state.campaignId
      || packet.baseCommit !== spec.baseCommit
      || packet.baseCommit !== state.baseCommit
    ) {
      throw new Error(`Packet ${name} provenance does not match campaign state`);
    }
    const expectedRequestId = `request-${String(sequence).padStart(4, "0")}`;
    if (packet.requestId !== expectedRequestId) {
      throw new Error(`Packet ${name} request identity does not match its sequence`);
    }
    if (state.phase === "stopped" && packet.action !== "stop") continue;
    if (
      sequence !== state.packetSequence + 1
      || (state.pendingPacket !== undefined && state.phase !== "stopped")
    ) {
      throw new Error(`Packet ${name} does not match interrupted campaign state`);
    }
    const expected = await derivePacket({
      spec,
      transition: routedTransition(spec, state, paths),
      paths,
      sequence,
      createdAt: packet.createdAt,
    });
    assertPacketMaterial(packet, expected.packet, "Interrupted");
    return { packet, state: expected.state };
  }
  return undefined;
}

function metric(value: number | null, signed = false): string {
  if (value === null) return "unavailable";
  const formatted = String(Math.round(value * 1_000_000) / 1_000_000);
  return signed && value > 0 ? `+${formatted}` : formatted;
}

interface ReportRoot {
  slotId: string;
  arm: "base" | "candidate";
  wireRoot: string;
  skillRoot: string;
}

function reportMarkdown(
  packet: NextActionPacket,
  roots: readonly ReportRoot[],
  sealedRootCount: number,
): string {
  const usage = packet.budgetUsage;
  const lines = [
    `# Campaign ${packet.campaignId}: action ${packet.sequence}`,
    "",
    `- Phase: \`${packet.phase}\``,
    `- Next action: \`${packet.action}\``,
    `- Physical runs: ${usage?.physicalRuns ?? "unknown"} used; ${packet.remainingBudget.physicalRuns} remaining`,
    `- Wall clock: ${usage?.wallClockMs ?? "unknown"} ms used; ${packet.remainingBudget.wallClockMs} ms remaining`,
    `- Candidates: ${usage?.candidates ?? "unknown"} used; ${packet.remainingBudget.candidates} remaining`,
    "",
  ];
  if (packet.activeCandidate !== undefined) {
    lines.push(
      "## Frozen candidate",
      "",
      `- ID: \`${packet.activeCandidate.id}\``,
      `- Commit: \`${packet.activeCandidate.commit}\``,
      "",
    );
  }
  if (packet.outcomeCandidate !== undefined && (
    packet.activeCandidate === undefined
    || packet.outcomeCandidate.id !== packet.activeCandidate.id
  )) {
    lines.push(
      "## Prior candidate outcome",
      "",
      `- ID: \`${packet.outcomeCandidate.id}\``,
      `- Commit: \`${packet.outcomeCandidate.commit}\``,
      "",
    );
  }
  if (packet.execution?.kind === "command") {
    lines.push("## Controller command", "", `- argv: \`${packet.execution.argv.join(" ")}\``, "");
  }
  if (packet.score !== undefined) {
    const advanced = packet.decision !== undefined && [
      "survives-targeted",
      "survives-broad",
      "recommend-promote",
    ].includes(packet.decision.status);
    const comparisonOutcome = packet.score.scorable
      && packet.score.successDelta === 0
      && packet.score.meanJudgeDelta === 0
      ? "tie"
      : !advanced
        ? "inconclusive"
        : packet.score.scorable
          ? "measured difference"
          : "inconclusive";
    lines.push(
      "## Aggregate score",
      "",
      `- Comparison outcome: ${comparisonOutcome}`,
      `- Paired slots: ${packet.score.pairedSlots}`,
      `- Verified successes: base ${packet.score.baseSuccesses}; candidate ${packet.score.candidateSuccesses}`,
      `- Success delta: ${metric(packet.score.successDelta, true)}`,
      `- Mean judge delta: ${metric(packet.score.meanJudgeDelta, true)}`,
      `- Explicit failures: base ${packet.score.baseFailures}; candidate ${packet.score.candidateFailures}`,
      `- Scorable: ${packet.score.scorable ? "yes" : "no"}`,
      "",
    );
  }
  if (packet.decision !== undefined) {
    lines.push("## Gate decision", "", `- Status: \`${packet.decision.status}\``);
    if (packet.decision.reasons.length === 0) lines.push("- Reasons: none recorded");
    else for (const reason of packet.decision.reasons) lines.push(`- Reason: ${reason}`);
    lines.push("");
  }
  if (packet.stopReason !== undefined) {
    lines.push("## Stop reason", "", `- ${packet.stopReason}`, "");
  }
  if (packet.clusters.length > 0) {
    lines.push("## Structural failure clusters", "");
    for (const cluster of packet.clusters) {
      lines.push(`- \`${cluster.signature}\`: ${cluster.count} (${cluster.warning})`);
    }
    lines.push("");
  }
  if (packet.reviewWarnings.length > 0) {
    lines.push("## Required human review", "");
    for (const warning of packet.reviewWarnings) lines.push(`- ${warning}`);
    lines.push("");
  }
  if (roots.length > 0 || sealedRootCount > 0) {
    lines.push("## Isolated run roots", "");
    for (const root of roots) {
      lines.push(
        `- \`${root.slotId}/${root.arm}\`: WIRE_ROOT \`${root.wireRoot}\`; WIRE_SKILLS \`${root.skillRoot}\``,
      );
    }
    if (sealedRootCount > 0) {
      lines.push(`- ${sealedRootCount} sealed-holdout root${sealedRootCount === 1 ? "" : "s"} withheld from this handoff report.`);
    }
    lines.push("");
  }
  lines.push("The evaluator never merges or pushes a candidate; every promotion is a human-review recommendation.");
  return `${redactSecrets(lines.join("\n"))}\n`;
}

async function atomicWriteText(path: string, value: string): Promise<void> {
  const directory = dirname(path);
  const temporaryPath = join(directory, `.tmp-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(temporaryPath, value, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      await unlink(temporaryPath);
    } catch {
      // Best-effort cleanup; preserve the original write error.
    }
    throw error;
  }
}

async function writePacketReport(paths: CampaignPaths, packet: NextActionPacket): Promise<void> {
  const attempts = await listAttempts(paths);
  const roots = attempts
    .filter((attempt) => attempt.cohort !== "holdout")
    .flatMap((attempt) => attempt.results.map((result) => ({
      slotId: attempt.slotId,
      arm: result.arm,
      wireRoot: result.wireRoot,
      skillRoot: result.skillRoot,
    })));
  const sealedRootCount = attempts
    .filter((attempt) => attempt.cohort === "holdout")
    .reduce((total, attempt) => total + attempt.results.length, 0);
  await atomicWriteText(
    join(paths.reports, sequenceName(packet.sequence, "action.md")),
    reportMarkdown(packet, roots, sealedRootCount),
  );
}

function stateAfterPacket(
  routedState: CampaignState,
  packet: NextActionPacket,
  paths: CampaignPaths,
  updatedAt: string,
): CampaignState {
  return {
    ...routedState,
    packetSequence: packet.sequence,
    pendingPacket: {
      sequence: packet.sequence,
      requestId: packet.requestId,
      path: packetPathFor(paths, packet.sequence),
    },
    updatedAt,
  };
}

export async function writeNextAction(
  spec: CampaignSpec,
  state: CampaignState,
  paths: CampaignPaths,
  now: () => Date = () => new Date(),
): Promise<{ packet: NextActionPacket; state: CampaignState; written: boolean }> {
  if (state.pendingPacket !== undefined) {
    const pending = await readPendingPacket(spec, state, paths);
    if (state.phase !== "stopped" || pending.action === "stop") {
      await assertPendingPacketMaterial(spec, state, paths, pending);
      await writePacketReport(paths, pending);
      return { packet: pending, state, written: false };
    }
    // A stopped campaign supersedes an older non-terminal command packet. The
    // old packet is identity-checked above but is never accepted, reported, or
    // used to derive the terminal packet below.
  }

  const interrupted = await recoverInterruptedPacket(spec, paths, state);
  if (interrupted !== undefined) {
    const recoveredState = stateAfterPacket(
      interrupted.state,
      interrupted.packet,
      paths,
      now().toISOString(),
    );
    await writePacketReport(paths, interrupted.packet);
    await saveCampaignState(paths, recoveredState);
    return { packet: interrupted.packet, state: recoveredState, written: false };
  }

  const transition = routedTransition(spec, state, paths);
  const sequence = transition.state.packetSequence + 1;
  const packetPath = packetPathFor(paths, sequence);
  const derived = await derivePacket({
    spec,
    transition,
    paths,
    sequence,
    createdAt: now().toISOString(),
  });
  await atomicWriteJson(packetPath, derived.packet);
  await writePacketReport(paths, derived.packet);
  const nextState = stateAfterPacket(derived.state, derived.packet, paths, now().toISOString());
  await saveCampaignState(paths, nextState);
  return { packet: derived.packet, state: nextState, written: true };
}

export async function acceptPacketResponse(
  spec: CampaignSpec,
  state: CampaignState,
  paths: CampaignPaths,
  raw: unknown,
  now: () => Date = () => new Date(),
): Promise<{ response: CandidateResponse; state: CampaignState; responsePath: string }> {
  const pending = state.pendingPacket;
  if (pending === undefined) throw new Error("There is no unanswered packet");
  const response = candidateResponseSchema.parse(raw);
  if (containsSecrets(JSON.stringify(response))) {
    throw new Error("Candidate response contains a secret-looking value");
  }
  if (response.campaignId !== spec.id) throw new Error("Candidate response belongs to another campaign");
  if (response.requestId !== pending.requestId) throw new Error("Candidate response is stale or altered");
  if (response.baseCommit !== spec.baseCommit) throw new Error("Candidate response has the wrong base commit");
  if (state.candidates[response.candidateId] !== undefined) throw new Error("Candidate response is a duplicate");
  if (state.candidatesUsed >= spec.budget.maxCandidates) throw new Error("Candidate budget is exhausted");
  await loadCampaignPendingPacket(spec, state, paths, { action: "propose-candidate" });
  const responsePath = responsePathFor(paths, pending.sequence);
  const existingResponse = await readJsonFile(responsePath);
  if (existingResponse === undefined) {
    await atomicWriteJson(responsePath, response);
  } else {
    const existing = candidateResponseSchema.parse(existingResponse);
    if (JSON.stringify(existing) !== JSON.stringify(response)) {
      throw new Error("Packet already has an altered response");
    }
  }
  const nextState: CampaignState = {
    ...state,
    pendingPacket: undefined,
    updatedAt: now().toISOString(),
  };
  return { response, state: nextState, responsePath };
}

export function packetBasename(packet: NextActionPacket): string {
  return basename(packet.candidateContract.responsePath);
}

export function scoreForCohort(
  state: CampaignState,
  candidateId: string,
  cohort: CohortName,
): ScoreSummary | undefined {
  return state.candidates[candidateId]?.scores[cohort];
}
