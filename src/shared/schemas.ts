import { z } from "zod";

import { isIsoUtcTimestamp } from "./ids.js";
import type {
  ActionId,
  ApprovalId,
  ArtifactId,
  ArtifactKind,
  BrowserExecTarget,
  ComparisonId,
  EntityId,
  ExperimentId,
  HypothesisId,
  IdPrefix,
  PolicyDecisionId,
  ProfileId,
  RunId,
  SessionId,
  SkillId,
  TaskId,
  TraceEventId,
  TraceBlob,
  TraceBlobKind,
} from "./types.js";

const isoUtcTimestampSchema = z.string().refine(isIsoUtcTimestamp, {
  message: "Expected an ISO 8601 UTC timestamp with millisecond precision.",
});

const jsonValueSchema: z.ZodTypeAny = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

const sessionConfigSchema = z
  .object({
    useProxy: z.union([
      z.boolean(),
      z.object({
        geolocation: z.object({ country: z.string().length(2).optional() }).optional(),
        server: z.string().min(1).optional(),
      }).strict(),
    ]).optional(),
    solveCaptcha: z.boolean().optional(),
    stealth: z.boolean().optional(),
    userAgent: z.string().min(1).optional(),
    region: z.string().min(1).optional(),
    locale: z.string().min(1).optional(),
    timezone: z.string().min(1).optional(),
    viewport: z.object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    }).strict().optional(),
    providerOptions: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict();

function makeIdSchema<TPrefix extends IdPrefix>(prefix: TPrefix) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_[a-z0-9-]+$`, "u"), `Expected ${prefix}_* id.`)
    .transform((value) => value as EntityId<TPrefix>);
}

export const taskIdSchema = makeIdSchema("task") as z.ZodType<TaskId>;
export const runIdSchema = makeIdSchema("run") as z.ZodType<RunId>;
export const sessionIdSchema = makeIdSchema("session") as z.ZodType<SessionId>;
export const profileIdSchema = makeIdSchema("profile") as z.ZodType<ProfileId>;
export const skillIdSchema = makeIdSchema("skill") as z.ZodType<SkillId>;
export const artifactIdSchema = makeIdSchema("artifact") as z.ZodType<ArtifactId>;
export const hypothesisIdSchema = makeIdSchema("hypothesis") as z.ZodType<HypothesisId>;
export const approvalIdSchema = makeIdSchema("approval") as z.ZodType<ApprovalId>;
export const actionIdSchema = makeIdSchema("action") as z.ZodType<ActionId>;
export const policyDecisionIdSchema = makeIdSchema("policy") as z.ZodType<PolicyDecisionId>;
export const experimentIdSchema = makeIdSchema("experiment") as z.ZodType<ExperimentId>;
export const comparisonIdSchema = makeIdSchema("comparison") as z.ZodType<ComparisonId>;
export const traceEventIdSchema = makeIdSchema("event") as z.ZodType<TraceEventId>;

export const providerKindSchema = z.enum(["steel", "custom"]);
export const taskModeSchema = z.enum(["task", "investigate", "experiment"]);
export const sessionStatusSchema = z.enum(["starting", "ready", "busy", "stopped", "failed"]);
export const runStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting-approval",
  "succeeded",
  "partial",
  "failed",
  "aborted",
]);
export const runClassificationKindSchema = z.enum([
  "task-complete",
  "partial-success",
  "blocked-auth",
  "blocked-policy",
  "site-error",
  "agent-error",
  "infra-error",
  "counterexample",
  "ambiguous",
]);
export const hypothesisStatusSchema = z.enum(["active", "supported", "rejected", "ambiguous"]);
export const skillStatusSchema = z.enum(["proposed", "active", "superseded", "rejected"]);
export const skillScopeSchema = z.enum(["domain", "workflow", "interaction"]);
export const skillSourceSchema = z.enum(["builtin", "team", "generated"]);
export const traceEventKindSchema = z.enum([
  "thought-summary",
  "observation",
  "code-exec",
  "code-result",
  "artifact",
  "policy-check",
  "approval-request",
  "approval-result",
  "skill-load",
  "skill-empty",
  "skill-proposal",
  "contract-check",
  "critical-points",
  "artifact-review",
  "progress-ledger",
  "llm-call",
  "llm-usage",
  "user-message",
  "session",
  "error",
]);
export const approvalStatusSchema = z.enum(["pending", "approved", "rejected", "expired"]);
export const policyDecisionResultSchema = z.enum(["allow", "deny", "require-approval"]);
export const artifactKindSchema = z.string().min(1) as z.ZodType<ArtifactKind>;
export const traceBlobKindSchema = z.string().min(1) as z.ZodType<TraceBlobKind>;
export const comparisonDimensionSchema = z.enum([
  "latency",
  "path",
  "profile",
  "artifacts",
  "outcome",
]);

export const actionKindSchema = z.string().min(1);

export const taskBudgetSchema = z
  .object({
    maxRuns: z.number().int().positive().optional(),
    maxTokens: z.number().int().positive().optional(),
    maxBrowserMinutes: z.number().positive().optional(),
    maxUsd: z.number().nonnegative().optional(),
  })
  .strict();

// Stored-record schemas (tasks, runs, sessions, artifacts, events, blobs,
// approvals, hypotheses, experiments, checkpoints, skill frontmatter) are
// `.loose()`: unknown top-level keys are tolerated and preserved on parse.
// Records on disk are durable assets that outlive any one wire build — a
// record written by a newer wire must load in an older one instead of being
// reported as corrupt, and a re-save must not drop fields it doesn't know.
// Known fields are still fully validated, so corruption detection keeps its
// teeth. Nested value schemas stay `.strict()`: new data belongs in new
// top-level fields, not grafted onto existing shapes.
export const taskSchema = z
  .object({
    id: taskIdSchema,
    title: z.string().min(1),
    mode: taskModeSchema,
    objective: z.string().min(1),
    constraints: z.array(z.string()),
    successCriteria: z.array(z.string()).min(1),
    falsificationCriteria: z.array(z.string()).optional(),
    budget: taskBudgetSchema.optional(),
    createdAt: isoUtcTimestampSchema,
  })
  .loose();

export const runClassificationSchema = z
  .object({
    kind: runClassificationKindSchema,
    confidence: z.number().min(0).max(1),
    notes: z.array(z.string()).optional(),
  })
  .strict();

export const resultProvenanceSchema = z
  .object({
    url: z.string().min(1).optional(),
    artifactIds: z.array(artifactIdSchema),
    sourceEventId: traceEventIdSchema.optional(),
  })
  .strict();

export const runSchema = z
  .object({
    id: runIdSchema,
    taskId: taskIdSchema,
    parentRunId: runIdSchema.optional(),
    branchLabel: z.string().min(1).optional(),
    hypothesisId: hypothesisIdSchema.optional(),
    sessionId: sessionIdSchema.optional(),
    status: runStatusSchema,
    startedAt: isoUtcTimestampSchema.optional(),
    finishedAt: isoUtcTimestampSchema.optional(),
    stepCount: z.number().int().nonnegative().optional(),
    eventCount: z.number().int().nonnegative().optional(),
    artifactCount: z.number().int().nonnegative().optional(),
    reviewFailureCount: z.number().int().nonnegative().optional(),
    result: z.string().min(1).optional(),
    resultPayload: jsonValueSchema.optional(),
    resultProvenance: resultProvenanceSchema.optional(),
    outcomeSummary: z.string().min(1).optional(),
    classification: runClassificationSchema.optional(),
  })
  .loose();

export const profileRefSchema = z
  .object({
    id: profileIdSchema,
    name: z.string().min(1),
    provider: providerKindSchema,
    metadata: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict();

export const browserSessionSchema = z
  .object({
    id: sessionIdSchema,
    provider: providerKindSchema,
    profileId: profileIdSchema.optional(),
    liveUrl: z.url().optional(),
    debugUrl: z.url().optional(),
    wsUrl: z.url().optional(),
    createdAt: isoUtcTimestampSchema,
    status: sessionStatusSchema,
    region: z.string().min(1).optional(),
    proxyCountryCode: z.string().length(2).nullable().optional(),
  })
  .loose();

export const hypothesisSchema = z
  .object({
    id: hypothesisIdSchema,
    taskId: taskIdSchema,
    statement: z.string().min(1),
    rationale: z.string().min(1).optional(),
    status: hypothesisStatusSchema,
    updatedAt: isoUtcTimestampSchema,
  })
  .loose();

export const skillMetadataSchema = z
  .object({
    id: skillIdSchema,
    scope: skillScopeSchema,
    status: skillStatusSchema.optional(),
    hostnamePatterns: z.array(z.string().min(1)).optional(),
    tags: z.array(z.string().min(1)),
    updatedAt: z.iso.date(),
    source: skillSourceSchema,
    confidence: z.number().min(0).max(1).optional(),
    sourceRunIds: z.array(runIdSchema).optional(),
    supersedes: z.array(skillIdSchema).optional(),
  })
  .strict();

export const skillFrontmatterSchema = skillMetadataSchema
  .extend({
    title: z.string().min(1).optional(),
  })
  .loose();

export const traceEventSchema = z
  .object({
    id: traceEventIdSchema,
    runId: runIdSchema,
    ts: isoUtcTimestampSchema,
    kind: traceEventKindSchema,
    payload: z.record(z.string(), jsonValueSchema),
  })
  .loose();

export const browserTabSummarySchema = z
  .object({
    id: z.string().min(1),
    title: z.string(),
    url: z.url(),
    active: z.boolean(),
  })
  .strict();

export const pageSketchBoundsSchema = z
  .object({
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().nonnegative(),
    height: z.number().nonnegative(),
  })
  .strict();

export const pageSketchLimitsSchema = z
  .object({
    maxSections: z.number().int().positive(),
    maxControlsPerSection: z.number().int().positive(),
    maxTextPreviewChars: z.number().int().positive(),
  })
  .strict();

export const pageSketchCountsSchema = z
  .object({
    links: z.number().int().nonnegative(),
    buttons: z.number().int().nonnegative(),
    inputs: z.number().int().nonnegative(),
    tables: z.number().int().nonnegative(),
    lists: z.number().int().nonnegative(),
  })
  .strict();

export const pageSketchControlSchema = z
  .object({
    label: z.string(),
    tag: z.string().min(1),
    role: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    href: z.string().min(1).optional(),
    selectorHint: z.string().min(1),
    selectorAlternates: z.array(z.string().min(1)).optional(),
    disabled: z.boolean().optional(),
    required: z.boolean().optional(),
  })
  .strict();

export const pageSketchSectionSchema = z
  .object({
    id: z.string().min(1),
    kind: z.enum(["nav", "header", "main", "form", "table", "list", "dialog", "footer", "content"]),
    selectorHint: z.string().min(1),
    label: z.string().min(1).optional(),
    heading: z.string().min(1).optional(),
    textPreview: z.string().optional(),
    bbox: pageSketchBoundsSchema.optional(),
    counts: pageSketchCountsSchema,
    controls: z.array(pageSketchControlSchema),
  })
  .strict();

export const pageSketchSchema = z
  .object({
    version: z.literal(1),
    generatedAt: z.string().min(1),
    sections: z.array(pageSketchSectionSchema),
    truncated: z.boolean().optional(),
    limits: pageSketchLimitsSchema,
  })
  .strict();

export const browserObservationSchema = z
  .object({
    sessionId: sessionIdSchema,
    targetId: z.string().min(1).optional(),
    url: z.url(),
    title: z.string(),
    tabs: z.array(browserTabSummarySchema),
    screenshotArtifactId: artifactIdSchema.optional(),
    screenshotBase64: z.string().min(1).optional(),
    htmlArtifactId: artifactIdSchema.optional(),
    markdownArtifactId: artifactIdSchema.optional(),
    focusedElement: z
      .object({
        tag: z.string().min(1).optional(),
        role: z.string().min(1).optional(),
        label: z.string().min(1).optional(),
        selectorHint: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    pageSummary: z
      .object({
        headings: z.array(z.string()).optional(),
        forms: z.number().int().nonnegative().optional(),
        buttons: z.number().int().nonnegative().optional(),
        dialogs: z.number().int().nonnegative().optional(),
        tables: z.number().int().nonnegative().optional(),
        links: z.number().int().nonnegative().optional(),
        inputs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    pageSketch: pageSketchSchema.optional(),
  })
  .strict();

export const browserExecTargetSchema: z.ZodType<BrowserExecTarget> = z.union([
  z.literal("active-tab"),
  z.literal("all-tabs"),
  z.object({ tabId: z.string().min(1) }).strict(),
]);

export const browserScreenshotRequestSchema = z
  .object({
    sessionId: sessionIdSchema,
    targetId: z.string().min(1).optional(),
  })
  .strict();

export const browserScreenshotResultSchema = z
  .object({
    dataBase64: z.string().min(1),
    mimeType: z.string().min(1),
    targetId: z.string().min(1).optional(),
  })
  .strict();

export const browserExecRequestSchema = z
  .object({
    sessionId: sessionIdSchema,
    code: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    target: browserExecTargetSchema.optional(),
  })
  .strict();

export const browserExecResultSchema = z
  .object({
    ok: z.boolean(),
    stdout: z.string().optional(),
    stderr: z.string().optional(),
    returnValue: jsonValueSchema.optional(),
    artifactIds: z.array(artifactIdSchema).optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export const browserRawRequestSchema = z
  .object({
    sessionId: sessionIdSchema,
    method: z.string().min(1),
    params: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict();

export const createSessionInputSchema = z
  .object({
    profileId: profileIdSchema.optional(),
    region: z.string().min(1).optional(),
    proxyCountryCode: z.string().length(2).nullable().optional(),
    timeoutMinutes: z.number().positive().optional(),
    metadata: z.record(z.string(), jsonValueSchema).optional(),
    sessionConfig: sessionConfigSchema.optional(),
  })
  .strict();

export const policyDecisionSchema = z
  .object({
    id: policyDecisionIdSchema,
    actionId: actionIdSchema,
    result: policyDecisionResultSchema,
    reason: z.string().min(1).optional(),
  })
  .strict();

export const proposedActionDetailSchema = z
  .object({
    kind: z.string().min(1),
    riskKind: z.string().min(1).optional(),
    reason: z.string().min(1).optional(),
    codeExcerpt: z.string().optional(),
    truncated: z.boolean().optional(),
    cdpMethods: z.array(z.string()).optional(),
  })
  .strict();

export const approvalRequestSchema = z
  .object({
    id: approvalIdSchema,
    runId: runIdSchema,
    actionId: actionIdSchema,
    summary: z.string().min(1),
    consequences: z.array(z.string()),
    expiresAt: isoUtcTimestampSchema.optional(),
    status: approvalStatusSchema.optional(),
    proposedAction: proposedActionDetailSchema.optional(),
  })
  .loose();

export const artifactSchema = z
  .object({
    id: artifactIdSchema,
    runId: runIdSchema,
    kind: artifactKindSchema,
    path: z.string().min(1),
    mimeType: z.string().min(1).optional(),
    createdAt: isoUtcTimestampSchema,
    metadata: z.record(z.string(), jsonValueSchema).optional(),
  })
  .loose();

export const traceBlobSchema = z
  .object({
    hash: z.string().regex(/^[a-f0-9]{64}$/u),
    runId: runIdSchema,
    kind: traceBlobKindSchema,
    createdAt: isoUtcTimestampSchema,
    size: z.number().int().nonnegative(),
    value: jsonValueSchema,
    contentType: z.string().min(1).optional(),
  })
  .loose() as z.ZodType<TraceBlob>;

export const comparisonSpecSchema = z
  .object({
    id: comparisonIdSchema,
    lhsRunId: runIdSchema,
    rhsRunId: runIdSchema,
    dimensions: z.array(comparisonDimensionSchema).min(1),
  })
  .strict();

export const experimentSummarySchema = z
  .object({
    supportedHypotheses: z.array(hypothesisIdSchema),
    rejectedHypotheses: z.array(hypothesisIdSchema),
    ambiguousHypotheses: z.array(hypothesisIdSchema),
    keyEvidence: z.array(z.string()),
    nextBestExperiments: z.array(z.string()),
  })
  .strict();

export const experimentBundleSchema = z
  .object({
    id: experimentIdSchema,
    taskId: taskIdSchema,
    hypotheses: z.array(hypothesisSchema),
    runIds: z.array(runIdSchema),
    comparisons: z.array(comparisonSpecSchema),
    summary: experimentSummarySchema.optional(),
  })
  .loose();

export const proposedActionSchema = z
  .object({
    kind: z.string().min(1),
    summary: z.string().min(1),
    payload: z.record(z.string(), jsonValueSchema).optional(),
  })
  .strict();

export const runCheckpointSchema = z
  .object({
    runId: runIdSchema,
    task: taskSchema,
    run: runSchema,
    sessionId: sessionIdSchema,
    events: z.array(traceEventSchema),
    stepCount: z.number().int().nonnegative(),
    startedAt: isoUtcTimestampSchema,
    helperSource: z.string().min(1).optional(),
    helperVersion: z.number().int().nonnegative().optional(),
    reviewFailureCount: z.number().int().nonnegative().optional(),
    pendingAction: proposedActionSchema,
    approvalRequestId: approvalIdSchema,
    savedAt: isoUtcTimestampSchema,
  })
  .loose();

export interface BoundaryParseSuccess<T> {
  success: true;
  data: T;
}

export interface BoundaryParseFailure {
  success: false;
  error: Error;
  issues: z.ZodIssue[];
}

export type BoundaryParseResult<T> = BoundaryParseSuccess<T> | BoundaryParseFailure;

export function parseBoundary<T>(schema: z.ZodTypeAny, input: unknown, label: string): T {
  const result = schema.safeParse(input);

  if (!result.success) {
    const detail = result.error.issues.map((issue) => issue.message).join("; ");
    throw new Error(`${label}: ${detail}`);
  }

  return stripUndefined(result.data) as T;
}

/**
 * Recursively remove keys whose values are `undefined` so that objects
 * parsed from JSON boundary data are compatible with TypeScript interfaces
 * compiled under `exactOptionalPropertyTypes`.
 */
function stripUndefined<T>(value: T): T {
  if (value === null || value === undefined) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map(stripUndefined) as T;
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (child !== undefined) {
        out[key] = stripUndefined(child);
      }
    }
    return out as T;
  }

  return value;
}

export function safeParseBoundary<T>(
  schema: z.ZodType<T>,
  input: unknown,
  label: string,
): BoundaryParseResult<T> {
  const result = schema.safeParse(input);

  if (result.success) {
    return result;
  }

  const detail = result.error.issues.map((issue) => issue.message).join("; ");

  return {
    success: false,
    error: new Error(`${label}: ${detail}`),
    issues: result.error.issues,
  };
}
