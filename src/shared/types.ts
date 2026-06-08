export type ProviderKind = "steel" | "custom";

export type TaskMode = "task" | "investigate" | "experiment";
export type SessionStatus = "starting" | "ready" | "busy" | "stopped" | "failed";
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "succeeded"
  | "partial"
  | "failed"
  | "aborted";
export type RunClassificationKind =
  | "task-complete"
  | "partial-success"
  | "blocked-auth"
  | "blocked-policy"
  | "site-error"
  | "agent-error"
  | "infra-error"
  | "counterexample"
  | "ambiguous";
export type HypothesisStatus = "active" | "supported" | "rejected" | "ambiguous";
export type SkillStatus = "proposed" | "active" | "superseded" | "rejected";
export type SkillScope = "domain" | "workflow" | "interaction";
export type SkillSource = "builtin" | "team" | "generated";
export type TraceEventKind =
  | "thought-summary"
  | "observation"
  | "code-exec"
  | "code-result"
  | "artifact"
  | "policy-check"
  | "approval-request"
  | "approval-result"
  | "skill-load"
  | "skill-empty"
  | "skill-proposal"
  | "contract-check"
  | "critical-points"
  | "artifact-review"
  | "progress-ledger"
  | "llm-call"
  | "llm-usage"
  | "user-message"
  | "error";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";
export type PolicyDecisionResult = "allow" | "deny" | "require-approval";
export type ArtifactKind =
  | "screenshot"
  | "html"
  | "markdown"
  | "pdf"
  | "download"
  | "helper-diff"
  | "skill-proposal"
  | "json-output"
  | "plot"
  | "table"
  | "note"
  | (string & {});
export type TraceBlobKind =
  | "artifact-content"
  | "llm-message"
  | "llm-response"
  | (string & {});
export type ComparisonDimension = "latency" | "path" | "profile" | "artifacts" | "outcome";
export type BrowserExecTarget = "active-tab" | "all-tabs" | { tabId: string };
export type ActionKind =
  | "observe"
  | "exec"
  | "raw"
  | "request-approval"
  | "branch-experiment"
  | "load-skill"
  | "propose-skill"
  | "finish"
  | (string & {});

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };
export type ProgressLedgerEntry = JsonObject;

export interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  extras?: Record<string, number>;
}

export type IdPrefix =
  | "action"
  | "approval"
  | "artifact"
  | "comparison"
  | "event"
  | "experiment"
  | "hypothesis"
  | "policy"
  | "profile"
  | "run"
  | "session"
  | "skill"
  | "task";

export type EntityId<TPrefix extends IdPrefix = IdPrefix> = `${TPrefix}_${string}`;
export type ActionId = EntityId<"action">;
export type ApprovalId = EntityId<"approval">;
export type ArtifactId = EntityId<"artifact">;
export type ComparisonId = EntityId<"comparison">;
export type ExperimentId = EntityId<"experiment">;
export type HypothesisId = EntityId<"hypothesis">;
export type PolicyDecisionId = EntityId<"policy">;
export type ProfileId = EntityId<"profile">;
export type RunId = EntityId<"run">;
export type SessionId = EntityId<"session">;
export type SkillId = EntityId<"skill">;
export type TaskId = EntityId<"task">;
export type TraceEventId = EntityId<"event">;

export interface ProfileRef {
  id: ProfileId;
  name: string;
  provider: ProviderKind;
  metadata?: JsonObject;
}

export interface BrowserSession {
  id: SessionId;
  provider: ProviderKind;
  profileId?: ProfileId;
  liveUrl?: string;
  debugUrl?: string;
  wsUrl?: string;
  createdAt: string;
  status: SessionStatus;
  region?: string;
  proxyCountryCode?: string | null;
}

export interface TaskBudget {
  maxRuns?: number;
  maxTokens?: number;
  maxBrowserMinutes?: number;
  maxUsd?: number;
}

export interface Task {
  id: TaskId;
  title: string;
  mode: TaskMode;
  objective: string;
  constraints: string[];
  successCriteria: string[];
  falsificationCriteria?: string[];
  budget?: TaskBudget;
  createdAt: string;
  /** Exploration guidance for an experiment-mode branch run: nudges this run
   *  onto a different path than its parent. Deliberately excluded from the
   *  completion contract so sibling branches are graded identically. */
  branchDirective?: string;
}

export interface RunClassification {
  kind: RunClassificationKind;
  confidence: number;
  notes?: string[];
}

// Run-level provenance for the final result: where it came from and the
// evidence that backs it. Lets a programmatic caller (e.g. a research agent
// citing Wire's output) trace a returned value back to a page and artifacts
// rather than trusting a bare string.
export interface ResultProvenance {
  // URL of the page in view when the result was produced.
  url?: string;
  // Evidence artifacts (screenshots, extracted JSON/HTML) recorded by the run.
  artifactIds: ArtifactId[];
  // Trace event that produced the result value (a code-result, typically).
  sourceEventId?: TraceEventId;
}

export interface Run {
  id: RunId;
  taskId: TaskId;
  parentRunId?: RunId;
  branchLabel?: string;
  hypothesisId?: HypothesisId;
  sessionId?: SessionId;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  stepCount?: number;
  eventCount?: number;
  artifactCount?: number;
  reviewFailureCount?: number;
  result?: string;
  resultPayload?: JsonValue;
  resultProvenance?: ResultProvenance;
  outcomeSummary?: string;
  classification?: RunClassification;
}

export interface Hypothesis {
  id: HypothesisId;
  taskId: TaskId;
  statement: string;
  rationale?: string;
  status: HypothesisStatus;
  updatedAt: string;
}

export interface SkillMetadata {
  id: SkillId;
  scope: SkillScope;
  status?: SkillStatus;
  hostnamePatterns?: string[];
  tags: string[];
  updatedAt: string;
  source: SkillSource;
  confidence?: number;
  sourceRunIds?: RunId[];
  supersedes?: SkillId[];
}

export interface SkillFrontmatter extends SkillMetadata {
  title?: string;
}

export interface LoadedSkill extends SkillMetadata {
  path: string;
  body: string;
  sections: Record<string, string>;
}

export interface TraceEvent {
  id: TraceEventId;
  runId: RunId;
  ts: string;
  kind: TraceEventKind;
  payload: JsonObject;
}

export interface BrowserTabSummary {
  id: string;
  title: string;
  url: string;
  active: boolean;
}

export interface BrowserFocusContext {
  tag?: string;
  role?: string;
  label?: string;
  selectorHint?: string;
}

export interface BrowserPageSummary {
  headings?: string[];
  forms?: number;
  buttons?: number;
  dialogs?: number;
  tables?: number;
  links?: number;
  inputs?: number;
}

export interface BrowserObservation {
  sessionId: SessionId;
  targetId?: string;
  url: string;
  title: string;
  tabs: BrowserTabSummary[];
  screenshotArtifactId?: ArtifactId;
  screenshotBase64?: string;
  htmlArtifactId?: ArtifactId;
  markdownArtifactId?: ArtifactId;
  focusedElement?: BrowserFocusContext;
  pageSummary?: BrowserPageSummary;
}

export interface BrowserExecRequest {
  sessionId: SessionId;
  code: string;
  timeoutMs?: number;
  target?: BrowserExecTarget;
  attachments?: string[];
}

export interface BrowserExecResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  returnValue?: JsonValue;
  wireEvents?: JsonObject[];
  artifactIds?: ArtifactId[];
  durationMs: number;
}

export interface BrowserRawRequest {
  sessionId: SessionId;
  method: string;
  params?: JsonObject;
}

export interface ProxyConfig {
  geolocation?: { country?: string };
  server?: string;
}

export interface ViewportConfig {
  width: number;
  height: number;
}

export interface SessionConfig {
  useProxy?: boolean | ProxyConfig;
  solveCaptcha?: boolean;
  stealth?: boolean;
  userAgent?: string;
  region?: string;
  locale?: string;
  timezone?: string;
  viewport?: ViewportConfig;
  providerOptions?: JsonObject;
}

export interface CreateSessionInput {
  profileId?: ProfileId;
  region?: string;
  proxyCountryCode?: string | null;
  timeoutMinutes?: number;
  metadata?: JsonObject;
  sessionConfig?: SessionConfig;
}

export interface PolicyDecision {
  id: PolicyDecisionId;
  actionId: ActionId;
  result: PolicyDecisionResult;
  reason?: string;
}

export interface ProposedActionDetail {
  kind: string;
  riskKind?: string;
  reason?: string;
  codeExcerpt?: string;
  truncated?: boolean;
  cdpMethods?: string[];
}

export interface ApprovalRequest {
  id: ApprovalId;
  runId: RunId;
  actionId: ActionId;
  summary: string;
  consequences: string[];
  expiresAt?: string;
  status?: ApprovalStatus;
  proposedAction?: ProposedActionDetail;
}

export interface Artifact {
  id: ArtifactId;
  runId: RunId;
  kind: ArtifactKind;
  path: string;
  mimeType?: string;
  createdAt: string;
  metadata?: JsonObject;
}

export interface TraceBlob {
  hash: string;
  runId: RunId;
  kind: TraceBlobKind;
  createdAt: string;
  size: number;
  value: JsonValue;
  contentType?: string;
}

export interface TraceBlobRef {
  hash: string;
  size: number;
  kind: TraceBlobKind;
}

export interface ComparisonSpec {
  id: ComparisonId;
  lhsRunId: RunId;
  rhsRunId: RunId;
  dimensions: ComparisonDimension[];
}

export interface ExperimentSummary {
  supportedHypotheses: HypothesisId[];
  rejectedHypotheses: HypothesisId[];
  ambiguousHypotheses: HypothesisId[];
  keyEvidence: string[];
  nextBestExperiments: string[];
}

export interface ExperimentBundle {
  id: ExperimentId;
  taskId: TaskId;
  hypotheses: Hypothesis[];
  runIds: RunId[];
  comparisons: ComparisonSpec[];
  summary?: ExperimentSummary;
}

export interface ProposedAction {
  kind: ActionKind;
  summary: string;
  payload?: JsonObject;
}

export interface RunCheckpoint {
  runId: RunId;
  task: Task;
  run: Run;
  sessionId: SessionId;
  events: TraceEvent[];
  stepCount: number;
  startedAt: string;
  helperSource?: string;
  helperVersion?: number;
  /** Carries the reviewer-retry cap (Change D) across approval/resume so it
   *  can't be silently restarted by repeated resumes. Optional for backward
   *  compatibility with checkpoints written before this field existed. */
  reviewFailureCount?: number;
  pendingAction: ProposedAction;
  approvalRequestId: ApprovalId;
  savedAt: string;
}
