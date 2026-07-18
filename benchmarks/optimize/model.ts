import { isAbsolute } from "node:path";
import { z } from "zod";

const idPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;
const commitPattern = /^[a-f0-9]{40}$/u;
const runIdPattern = /^run_[a-z0-9-]+$/u;
const relativeFilePattern = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*[\\\0\r\n]).+$/u;

const nonEmpty = z.string().trim().min(1);
const boundedDiagnostic = nonEmpty.max(2_000);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();
const sha256 = z.string().regex(sha256Pattern, "expected a lowercase SHA-256 digest");
const commit = z.string().regex(commitPattern, "expected a full lowercase Git commit SHA");
const runId = z.string().regex(runIdPattern, "expected a run_* id");
const safeId = z.string().regex(idPattern, "expected a safe lowercase identifier");
const relativeFile = z.string().max(500).regex(relativeFilePattern, "expected a repository-relative path");

const cohortSchema = z.strictObject({
  taskIds: z.array(nonEmpty.max(128)).min(1).max(10_000),
  pairedSlots: positiveInteger,
}).superRefine((cohort, context) => {
  const seen = new Set<string>();
  for (const taskId of cohort.taskIds) {
    if (seen.has(taskId)) {
      context.addIssue({
        code: "custom",
        message: `duplicate task id: ${taskId}`,
        path: ["taskIds"],
      });
    }
    seen.add(taskId);
  }
});

export const promotionGatesSchema = z.strictObject({
  minimumTargetedSuccessDelta: z.number().int().nonnegative(),
  minimumMeanJudgeDelta: z.number().min(0).max(1),
  maxSimplificationJudgeRegression: z.number().min(0).max(1),
  maxSmokeSuccessRegression: z.literal(0),
  maxBroadSuccessRegression: z.literal(0),
});

export const safeIdentifierSchema = safeId;

const campaignShape = {
  version: z.literal(1),
  id: safeId,
  baseCommit: commit,
  suite: z.strictObject({ path: nonEmpty.max(4_096), sha256 }),
  judge: z.strictObject({ model: nonEmpty.max(200), threshold: z.number().min(0).max(1) }),
  wire: z.strictObject({
    provider: z.enum(["openai", "anthropic", "zai"]),
    model: nonEmpty.max(200),
    timeoutMs: positiveInteger,
  }),
  cohorts: z.strictObject({
    smoke: cohortSchema,
    targeted: cohortSchema,
    broad: cohortSchema,
    holdout: z.strictObject({
      externalSuitePath: nonEmpty.max(4_096),
      sha256,
      slots: positiveInteger,
    }).optional(),
  }),
  budget: z.strictObject({
    maxPhysicalRuns: positiveInteger,
    maxCandidates: positiveInteger,
    maxWallClockMs: positiveInteger,
    maxConcurrency: z.literal(1),
  }),
  skillSnapshot: z.strictObject({ path: nonEmpty.max(4_096), sha256 }),
  seed: nonEmpty.max(500),
  gates: promotionGatesSchema,
};

export const campaignRecipeSchema = z.strictObject(campaignShape);

export const campaignSpecSchema = z.strictObject(campaignShape).superRefine((campaign, context) => {
  const paths: Array<[string, string]> = [
    ["suite.path", campaign.suite.path],
    ["skillSnapshot.path", campaign.skillSnapshot.path],
  ];
  if (campaign.cohorts.holdout !== undefined) {
    paths.push(["cohorts.holdout.externalSuitePath", campaign.cohorts.holdout.externalSuitePath]);
  }
  for (const [label, path] of paths) {
    if (!isAbsolute(path)) {
      context.addIssue({ code: "custom", message: `${label} must be absolute` });
    }
  }
});

export type CampaignRecipe = z.infer<typeof campaignRecipeSchema>;
export type CampaignSpec = z.infer<typeof campaignSpecSchema>;
export type CohortName = "smoke" | "targeted" | "broad" | "holdout";
export const candidateStatusSchema = z.enum([
  "ingested",
  "rejected",
  "inconclusive",
  "survives-targeted",
  "survives-broad",
  "recommend-promote",
]);
export type CandidateStatus = z.infer<typeof candidateStatusSchema>;

export const candidateResponseSchema = z.strictObject({
  version: z.literal(1),
  campaignId: safeId,
  requestId: safeId,
  candidateId: safeId,
  baseCommit: commit,
  worktreePath: nonEmpty.max(4_096).refine(isAbsolute, "worktreePath must be absolute"),
  candidateCommit: commit,
  hypothesis: nonEmpty.max(2_000),
  recommendedHome: z.enum(["skill", "helper", "core"]),
  changedFiles: z.array(relativeFile).min(1).max(200).superRefine((files, context) => {
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file)) {
        context.addIssue({ code: "custom", message: `duplicate changed file: ${file}` });
      }
      seen.add(file);
    }
  }),
  testsRun: z.array(nonEmpty.max(500)).max(50),
});

export type CandidateResponse = z.infer<typeof candidateResponseSchema>;

const candidateResponseRequiredFields = z.tuple([
  z.literal("version"),
  z.literal("campaignId"),
  z.literal("requestId"),
  z.literal("candidateId"),
  z.literal("baseCommit"),
  z.literal("worktreePath"),
  z.literal("candidateCommit"),
  z.literal("hypothesis"),
  z.literal("recommendedHome"),
  z.literal("changedFiles"),
  z.literal("testsRun"),
]);

/** Inspectable JSON-Schema-shaped description embedded in every handoff packet. */
export const candidateResponseJsonSchemaSchema = z.strictObject({
  type: z.literal("object"),
  additionalProperties: z.literal(false),
  required: candidateResponseRequiredFields,
  properties: z.strictObject({
    version: z.strictObject({ const: z.literal(1) }),
    campaignId: z.strictObject({ const: safeId }),
    requestId: z.strictObject({ const: safeId }),
    candidateId: z.strictObject({
      type: z.literal("string"),
      pattern: z.literal(idPattern.source),
    }),
    baseCommit: z.strictObject({ const: commit }),
    worktreePath: z.strictObject({
      type: z.literal("string"),
      format: z.literal("absolute-path"),
      maxLength: z.literal(4_096),
    }),
    candidateCommit: z.strictObject({
      type: z.literal("string"),
      pattern: z.literal(commitPattern.source),
    }),
    hypothesis: z.strictObject({
      type: z.literal("string"),
      minLength: z.literal(1),
      maxLength: z.literal(2_000),
    }),
    recommendedHome: z.strictObject({
      type: z.literal("string"),
      enum: z.tuple([z.literal("skill"), z.literal("helper"), z.literal("core")]),
    }),
    changedFiles: z.strictObject({
      type: z.literal("array"),
      minItems: z.literal(1),
      maxItems: z.literal(200),
      uniqueItems: z.literal(true),
      items: z.strictObject({
        type: z.literal("string"),
        format: z.literal("repository-relative-path"),
        maxLength: z.literal(500),
      }),
    }),
    testsRun: z.strictObject({
      type: z.literal("array"),
      maxItems: z.literal(50),
      items: z.strictObject({
        type: z.literal("string"),
        minLength: z.literal(1),
        maxLength: z.literal(500),
      }),
    }),
  }),
});

export type CandidateResponseJsonSchema = z.infer<typeof candidateResponseJsonSchemaSchema>;

export function candidateResponseJsonSchemaFor(input: {
  campaignId: string;
  requestId: string;
  baseCommit: string;
}): CandidateResponseJsonSchema {
  return candidateResponseJsonSchemaSchema.parse({
    type: "object",
    additionalProperties: false,
    required: [
      "version",
      "campaignId",
      "requestId",
      "candidateId",
      "baseCommit",
      "worktreePath",
      "candidateCommit",
      "hypothesis",
      "recommendedHome",
      "changedFiles",
      "testsRun",
    ],
    properties: {
      version: { const: 1 },
      campaignId: { const: input.campaignId },
      requestId: { const: input.requestId },
      candidateId: { type: "string", pattern: idPattern.source },
      baseCommit: { const: input.baseCommit },
      worktreePath: { type: "string", format: "absolute-path", maxLength: 4_096 },
      candidateCommit: { type: "string", pattern: commitPattern.source },
      hypothesis: { type: "string", minLength: 1, maxLength: 2_000 },
      recommendedHome: { type: "string", enum: ["skill", "helper", "core"] },
      changedFiles: {
        type: "array",
        minItems: 1,
        maxItems: 200,
        uniqueItems: true,
        items: { type: "string", format: "repository-relative-path", maxLength: 500 },
      },
      testsRun: {
        type: "array",
        maxItems: 50,
        items: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
  });
}

export const physicalResultSchema = z.strictObject({
  arm: z.enum(["base", "candidate"]),
  status: z.enum(["completed", "infrastructure-failure"]),
  runId: runId.nullable(),
  judgeScore: z.number().min(0).max(1).nullable(),
  success: z.boolean().nullable(),
  wallMs: z.number().nonnegative(),
  nativeStatus: z.string().nullable(),
  nativeClassification: z.string().nullable(),
  harnessOutputPath: z.string().max(4_096),
  harnessOutputSha256: sha256.nullable(),
  subprocess: z.strictObject({
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    wallMs: z.number().nonnegative(),
  }),
  commit,
  wireRoot: z.string().refine(isAbsolute),
  skillRoot: z.string().refine(isAbsolute),
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime(),
  stderr: z.string().max(2_000),
  failureReason: boundedDiagnostic.optional(),
}).superRefine((result, context) => {
  if (result.status === "completed") {
    if (result.runId === null || result.judgeScore === null || result.success === null) {
      context.addIssue({ code: "custom", message: "completed result requires runId, judgeScore, and success" });
    }
    if (result.harnessOutputSha256 === null) {
      context.addIssue({ code: "custom", message: "completed result requires an immutable output hash" });
    }
  } else if (result.failureReason === undefined || result.failureReason.trim() === "") {
    context.addIssue({ code: "custom", message: "infrastructure failure requires a reason" });
  }
});

export type PhysicalResult = z.infer<typeof physicalResultSchema>;

export const attemptSchema = z.strictObject({
  version: z.literal(1),
  campaignId: safeId,
  candidateId: safeId,
  cohort: z.enum(["smoke", "targeted", "broad", "holdout"]),
  slotId: safeId,
  slotIndex: nonNegativeInteger,
  taskId: nonEmpty,
  repetition: positiveInteger,
  order: z.tuple([z.enum(["base", "candidate"]), z.enum(["base", "candidate"])]),
  results: z.array(physicalResultSchema).max(2),
  complete: z.boolean(),
}).superRefine((attempt, context) => {
  if (attempt.order[0] === attempt.order[1]) {
    context.addIssue({ code: "custom", message: "paired order must contain both arms", path: ["order"] });
  }
  const resultArms = attempt.results.map((result) => result.arm);
  if (new Set(resultArms).size !== resultArms.length) {
    context.addIssue({ code: "custom", message: "attempt has duplicate arm results", path: ["results"] });
  }
  if (resultArms.some((arm, index) => arm !== attempt.order[index])) {
    context.addIssue({ code: "custom", message: "attempt results must be an order prefix", path: ["results"] });
  }
  const derivedComplete = attempt.results.length === 2
    && attempt.results.every((result) => result.status === "completed");
  if (attempt.complete !== derivedComplete) {
    context.addIssue({ code: "custom", message: "attempt completion flag is inconsistent", path: ["complete"] });
  }
});

export type Attempt = z.infer<typeof attemptSchema>;

export const structuralSignatureKindSchema = z.enum([
  "nav-404",
  "navigation-only-stall",
  "empty-extraction",
  "repeated-action-stall",
  "auth-or-antibot",
  "reconfigured-without-content",
  "runtime-or-network-error",
  "judge-rejected",
  "trace-unavailable",
]);

export const autopsySchema = z.strictObject({
  version: z.literal(1),
  campaignId: safeId,
  runId,
  attemptSlotId: safeId,
  arm: z.enum(["base", "candidate"]),
  signatures: z.array(z.strictObject({
    kind: structuralSignatureKindSchema,
    explanation: nonEmpty,
    evidenceEventIds: z.array(nonEmpty).max(10),
  })),
  evidence: z.array(z.strictObject({
    eventId: nonEmpty,
    url: z.string().max(300).optional(),
    title: z.string().max(200).optional(),
    action: z.string().max(300).optional(),
  })).max(20),
  artifactIds: z.array(nonEmpty).max(20),
  artifacts: z.array(z.strictObject({
    id: nonEmpty,
    path: z.string().max(500),
  })).max(20),
  generatedAt: z.iso.datetime(),
});

export type Autopsy = z.infer<typeof autopsySchema>;
export type StructuralSignatureKind = z.infer<typeof structuralSignatureKindSchema>;

export const scoreSummarySchema = z.strictObject({
  pairedSlots: nonNegativeInteger,
  baseSuccesses: nonNegativeInteger,
  candidateSuccesses: nonNegativeInteger,
  successDelta: z.number().int(),
  meanBaseJudge: z.number().finite().min(0).max(1).nullable(),
  meanCandidateJudge: z.number().finite().min(0).max(1).nullable(),
  meanJudgeDelta: z.number().finite().min(-1).max(1).nullable(),
  taskVarianceBase: z.number().finite().min(0).max(0.25).nullable(),
  taskVarianceCandidate: z.number().finite().min(0).max(0.25).nullable(),
  baseMedianWallMs: z.number().finite().nonnegative().nullable(),
  candidateMedianWallMs: z.number().finite().nonnegative().nullable(),
  baseP90WallMs: z.number().finite().nonnegative().nullable(),
  candidateP90WallMs: z.number().finite().nonnegative().nullable(),
  baseFailures: nonNegativeInteger,
  candidateFailures: nonNegativeInteger,
  scorable: z.boolean(),
}).superRefine((score, context) => {
  if (score.baseSuccesses > score.pairedSlots || score.candidateSuccesses > score.pairedSlots) {
    context.addIssue({ code: "custom", message: "score successes exceed paired evidence" });
  }
  if (score.successDelta !== score.candidateSuccesses - score.baseSuccesses) {
    context.addIssue({ code: "custom", message: "score success delta is inconsistent" });
  }
  if (
    score.meanBaseJudge !== null
    && score.meanCandidateJudge !== null
    && score.meanJudgeDelta !== null
    && Math.abs(score.meanJudgeDelta - (score.meanCandidateJudge - score.meanBaseJudge)) > Number.EPSILON * 8
  ) {
    context.addIssue({ code: "custom", message: "score judge delta is inconsistent" });
  }
  for (const [median, p90] of [
    [score.baseMedianWallMs, score.baseP90WallMs],
    [score.candidateMedianWallMs, score.candidateP90WallMs],
  ] as const) {
    if ((median === null) !== (p90 === null) || (median !== null && p90 !== null && p90 < median)) {
      context.addIssue({ code: "custom", message: "score wall percentiles are inconsistent" });
    }
  }
  if (score.scorable && (
    score.pairedSlots === 0
    || score.meanBaseJudge === null
    || score.meanCandidateJudge === null
    || score.meanJudgeDelta === null
    || score.taskVarianceBase === null
    || score.taskVarianceCandidate === null
    || score.baseMedianWallMs === null
    || score.candidateMedianWallMs === null
    || score.baseP90WallMs === null
    || score.candidateP90WallMs === null
    || score.baseSuccesses + score.baseFailures !== score.pairedSlots
    || score.candidateSuccesses + score.candidateFailures !== score.pairedSlots
  )) {
    context.addIssue({ code: "custom", message: "scorable score is missing or contradicts paired evidence" });
  }
});

export type ScoreSummary = z.infer<typeof scoreSummarySchema>;

export const REQUIRED_CANDIDATE_CHECKS = ["pnpm check", "pnpm optimize:test"] as const;

const verifiedCandidateChecksSchema = z.array(z.enum(REQUIRED_CANDIDATE_CHECKS))
  .max(REQUIRED_CANDIDATE_CHECKS.length)
  .superRefine((checks, context) => {
    for (const [index, check] of checks.entries()) {
      if (check !== REQUIRED_CANDIDATE_CHECKS[index]) {
        context.addIssue({
          code: "custom",
          message: "verified checks must be the ordered unique prefix of the required candidate checks",
          path: [index],
        });
      }
    }
  });

export function hasRequiredCandidateChecks(checks: readonly string[]): boolean {
  return checks.length === REQUIRED_CANDIDATE_CHECKS.length
    && checks.every((check, index) => check === REQUIRED_CANDIDATE_CHECKS[index]);
}

const candidateRecordSchema = z.strictObject({
  response: candidateResponseSchema,
  status: candidateStatusSchema,
  changedProductionLines: nonNegativeInteger,
  productionLineDelta: z.number().int(),
  changedTestFiles: z.array(relativeFile),
  existingTestFilesChanged: z.array(relativeFile),
  verifiedTests: verifiedCandidateChecksSchema,
  rejectionReasons: z.array(boundedDiagnostic).max(50),
  gateReasons: z.array(boundedDiagnostic).max(50),
  reviewWarnings: z.array(boundedDiagnostic).max(20),
  scores: z.partialRecord(z.enum(["smoke", "targeted", "broad", "holdout"]), scoreSummarySchema),
});

export const campaignStateSchema = z.strictObject({
  version: z.literal(1),
  campaignId: safeId,
  baseCommit: commit,
  campaignSpecSha256: sha256,
  phase: z.enum([
    "initialized",
    "awaiting-candidate",
    "candidate-ingested",
    "evaluating",
    "stopped",
  ]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  physicalRunsUsed: nonNegativeInteger,
  wallClockMsUsed: z.number().nonnegative(),
  buildWallClockMsUsed: z.number().nonnegative(),
  verificationWallClockMsUsed: z.number().nonnegative(),
  candidatesUsed: nonNegativeInteger,
  completedSlots: z.array(safeId),
  builtRevisions: z.array(z.strictObject({
    commit,
    worktreePath: z.string().refine(isAbsolute),
    distSha256: sha256,
  })),
  inFlight: z.strictObject({
    kind: z.enum(["install", "build", "compare", "verification"]),
    commit,
    startedAt: z.iso.datetime(),
    slotId: safeId.optional(),
    arm: z.enum(["base", "candidate"]).optional(),
    candidateId: safeId.optional(),
    verificationScript: z.enum(["install", "check", "optimize:test"]).optional(),
  }).superRefine((operation, context) => {
    const pairedFields = operation.slotId !== undefined && operation.arm !== undefined;
    const verificationFields = operation.candidateId !== undefined && operation.verificationScript !== undefined;
    const hasPartialPair = operation.slotId !== undefined || operation.arm !== undefined;
    const hasPartialVerification = operation.candidateId !== undefined || operation.verificationScript !== undefined;
    const valid = operation.kind === "compare"
      ? pairedFields && !hasPartialVerification
      : operation.kind === "verification"
        ? verificationFields && !hasPartialPair
        : !hasPartialPair && !hasPartialVerification;
    if (!valid) {
      context.addIssue({
        code: "custom",
        message: "in-flight provenance fields do not match the operation kind",
      });
    }
  }).optional(),
  packetSequence: nonNegativeInteger,
  pendingPacket: z.strictObject({
    sequence: positiveInteger,
    requestId: safeId,
    path: nonEmpty,
  }).optional(),
  activeCandidateId: safeId.optional(),
  broadCandidateIds: z.array(safeId).max(2).optional(),
  candidates: z.record(safeId, candidateRecordSchema),
  stopReason: z.string().trim().min(1).max(2_000).optional(),
}).superRefine((state, context) => {
  const candidateEntries = Object.entries(state.candidates);
  if (state.candidatesUsed !== candidateEntries.length) {
    context.addIssue({ code: "custom", message: "candidate count does not match persisted records", path: ["candidatesUsed"] });
  }
  for (const [candidateId, record] of candidateEntries) {
    if (record.response.candidateId !== candidateId) {
      context.addIssue({ code: "custom", message: "candidate record key does not match its response", path: ["candidates", candidateId] });
    }
    if (record.response.campaignId !== state.campaignId || record.response.baseCommit !== state.baseCommit) {
      context.addIssue({ code: "custom", message: "candidate record provenance does not match campaign state", path: ["candidates", candidateId] });
    }
  }
  if (state.activeCandidateId !== undefined && state.candidates[state.activeCandidateId] === undefined) {
    context.addIssue({ code: "custom", message: "active candidate is absent from campaign records", path: ["activeCandidateId"] });
  }
  if (new Set(state.completedSlots).size !== state.completedSlots.length) {
    context.addIssue({ code: "custom", message: "completed slots must be unique", path: ["completedSlots"] });
  }
  const builtKeys = state.builtRevisions.map((entry) => `${entry.commit}\0${entry.worktreePath}`);
  if (new Set(builtKeys).size !== builtKeys.length) {
    context.addIssue({ code: "custom", message: "built revisions must be unique", path: ["builtRevisions"] });
  }
  if (state.pendingPacket !== undefined && state.pendingPacket.sequence !== state.packetSequence) {
    context.addIssue({ code: "custom", message: "pending packet sequence does not match campaign sequence", path: ["pendingPacket"] });
  }
  if (state.broadCandidateIds !== undefined) {
    if (new Set(state.broadCandidateIds).size !== state.broadCandidateIds.length) {
      context.addIssue({ code: "custom", message: "broad candidate ids must be unique", path: ["broadCandidateIds"] });
    }
    for (const candidateId of state.broadCandidateIds) {
      if (state.candidates[candidateId] === undefined) {
        context.addIssue({ code: "custom", message: "broad candidate is absent from campaign records", path: ["broadCandidateIds"] });
      }
    }
  }
  if (state.phase === "stopped" && (state.stopReason === undefined || state.stopReason.trim() === "")) {
    context.addIssue({ code: "custom", message: "stopped campaign requires a reason", path: ["stopReason"] });
  }
});

export type CampaignState = z.infer<typeof campaignStateSchema>;
export type CandidateRecord = z.infer<typeof candidateRecordSchema>;

export const nextActionSchema = z.enum([
  "inspect-cluster",
  "propose-candidate",
  "evaluate-targeted",
  "evaluate-smoke",
  "evaluate-broad",
  "run-holdout",
  "stop",
]);

export type NextAction = z.infer<typeof nextActionSchema>;

export function optimizerCliArgv(
  action: NextAction,
  campaignId: string,
  candidateId: string,
): string[] | undefined {
  const prefix = ["pnpm", "optimize", "--"];
  if (action === "run-holdout") {
    return [...prefix, "holdout", "--campaign", campaignId, "--candidate", candidateId];
  }
  const cohort = action === "evaluate-targeted"
    ? "targeted"
    : action === "evaluate-smoke"
      ? "smoke"
      : action === "evaluate-broad"
        ? "broad"
        : undefined;
  return cohort === undefined
    ? undefined
    : [...prefix, "evaluate", "--campaign", campaignId, "--candidate", candidateId, "--cohort", cohort];
}

const actionExecutionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("command"),
    argv: z.array(nonEmpty).min(1),
  }),
  z.strictObject({
    kind: z.literal("terminal"),
    argv: z.array(nonEmpty).max(0),
  }),
]);

export const nextActionPacketSchema = z.strictObject({
  version: z.literal(1),
  campaignId: safeId,
  requestId: safeId,
  sequence: positiveInteger,
  phase: nonEmpty,
  baseCommit: commit,
  action: nextActionSchema,
  activeCandidate: z.strictObject({
    id: safeId,
    commit,
  }).optional(),
  outcomeCandidate: z.strictObject({
    id: safeId,
    commit,
  }).optional(),
  execution: actionExecutionSchema.optional(),
  stopReason: z.string().trim().min(1).max(1_000).optional(),
  remainingBudget: z.strictObject({
    physicalRuns: nonNegativeInteger,
    wallClockMs: z.number().nonnegative(),
    candidates: nonNegativeInteger,
  }),
  budgetUsage: z.strictObject({
    physicalRuns: nonNegativeInteger,
    wallClockMs: z.number().nonnegative(),
    candidates: nonNegativeInteger,
  }).optional(),
  score: scoreSummarySchema.optional(),
  decision: z.strictObject({
    status: candidateStatusSchema,
    reasons: z.array(nonEmpty),
  }).optional(),
  reviewWarnings: z.array(nonEmpty).max(20),
  clusters: z.array(z.strictObject({
    signature: structuralSignatureKindSchema,
    count: positiveInteger,
    warning: nonEmpty,
    evidence: z.array(z.strictObject({
      runId: nonEmpty,
      autopsyPath: nonEmpty,
      url: z.string().max(300).optional(),
      title: z.string().max(200).optional(),
      action: z.string().max(300).optional(),
    })).max(5),
  })).max(3),
  allowedScope: z.array(nonEmpty),
  prohibitedFiles: z.array(nonEmpty),
  instructions: z.array(nonEmpty),
  candidateContract: z.strictObject({
    version: z.literal(1),
    appliesTo: z.literal("propose-candidate"),
    responsePath: nonEmpty,
    schema: candidateResponseJsonSchemaSchema,
  }),
  createdAt: z.iso.datetime(),
}).superRefine((packet, context) => {
  const candidateId = packet.activeCandidate?.id;
  const expectedArgv = candidateId === undefined
    ? undefined
    : optimizerCliArgv(packet.action, packet.campaignId, candidateId);
  if (expectedArgv !== undefined) {
    if (packet.execution?.kind !== "command") {
      context.addIssue({ code: "custom", message: `${packet.action} requires executable argv`, path: ["execution"] });
    } else if (
      packet.execution.argv.length !== expectedArgv.length
      || packet.execution.argv.some((value, index) => value !== expectedArgv[index])
    ) {
      context.addIssue({ code: "custom", message: `${packet.action} argv does not match packet identity`, path: ["execution", "argv"] });
    }
    return;
  }
  if (packet.action.startsWith("evaluate-") || packet.action === "run-holdout") {
    context.addIssue({ code: "custom", message: `${packet.action} requires an active candidate`, path: ["activeCandidate"] });
    return;
  }
  if (packet.action === "stop") {
    if (packet.execution?.kind !== "terminal") {
      context.addIssue({ code: "custom", message: "stop requires terminal execution metadata", path: ["execution"] });
    }
    if (packet.stopReason === undefined) {
      context.addIssue({ code: "custom", message: "stop requires a bounded reason", path: ["stopReason"] });
    }
  } else if (packet.execution !== undefined) {
    context.addIssue({ code: "custom", message: `${packet.action} may not carry controller argv`, path: ["execution"] });
  } else if (packet.stopReason !== undefined) {
    context.addIssue({ code: "custom", message: "only stop may carry a stop reason", path: ["stopReason"] });
  }
});

export type NextActionPacket = z.infer<typeof nextActionPacketSchema>;

export const controllerResponseSchema = z.strictObject({
  version: z.literal(1),
  campaignId: safeId,
  requestId: safeId,
  completedAction: z.enum([
    "evaluate-targeted",
    "evaluate-smoke",
    "evaluate-broad",
    "run-holdout",
    "stop",
  ]),
  completedAt: z.iso.datetime(),
});

export type ControllerResponse = z.infer<typeof controllerResponseSchema>;

export function parseCampaignRecipe(value: unknown): CampaignRecipe {
  return campaignRecipeSchema.parse(value);
}

export function parseCampaignSpec(value: unknown): CampaignSpec {
  return campaignSpecSchema.parse(value);
}

export function parseCampaignState(value: unknown): CampaignState {
  return campaignStateSchema.parse(value);
}

export function parseCandidateResponse(value: unknown): CandidateResponse {
  return candidateResponseSchema.parse(value);
}

export function parseAttempt(value: unknown): Attempt {
  return attemptSchema.parse(value);
}
