export type ProviderKind = "steel" | "custom";

export type TaskMode = "task" | "investigate" | "experiment";
export type SessionStatus = "starting" | "ready" | "busy" | "stopped" | "failed";
export type RunStatus =
  | "queued"
  | "running"
  | "awaiting-approval"
  | "succeeded"
  | "failed"
  | "aborted";
export type RunClassificationKind =
  | "task-complete"
  | "partial-success"
  | "blocked-auth"
  | "site-error"
  | "agent-error"
  | "infra-error"
  | "counterexample"
  | "ambiguous";
export type HypothesisStatus = "active" | "supported" | "rejected" | "ambiguous";
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
  | "skill-proposal"
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
  | "note";
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
  | "finish";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export type JsonObject = { [key: string]: JsonValue };

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
}

export interface RunClassification {
  kind: RunClassificationKind;
  confidence: number;
  notes?: string[];
}

export interface Run {
  id: RunId;
  taskId: TaskId;
  parentRunId?: RunId;
  branchLabel?: string;
  hypothesisId?: HypothesisId;
  status: RunStatus;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
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
  hostnamePatterns?: string[];
  tags: string[];
  updatedAt: string;
  source: SkillSource;
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
  visibleTexts?: string[];
  forms?: number;
  buttons?: number;
  dialogs?: number;
  tables?: number;
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
  artifactIds?: ArtifactId[];
  durationMs: number;
}

export interface BrowserRawRequest {
  sessionId: SessionId;
  method: string;
  params?: JsonObject;
}

export interface CreateSessionInput {
  profileId?: ProfileId;
  region?: string;
  proxyCountryCode?: string | null;
  timeoutMinutes?: number;
  metadata?: JsonObject;
}

export interface PolicyDecision {
  id: PolicyDecisionId;
  actionId: ActionId;
  result: PolicyDecisionResult;
  reason?: string;
}

export interface ApprovalRequest {
  id: ApprovalId;
  runId: RunId;
  actionId: ActionId;
  summary: string;
  consequences: string[];
  expiresAt?: string;
  status?: ApprovalStatus;
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
  pendingAction: ProposedAction;
  approvalRequestId: ApprovalId;
  savedAt: string;
}
