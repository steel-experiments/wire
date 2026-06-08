import type {
  Artifact,
  Run,
  RunClassificationKind,
  Task,
  TraceEvent,
} from "../shared/types.js";
import {
  createTaskContract,
  validateTaskContract,
  type ContractValidation,
} from "../agent/contract.js";

export interface RunScoreComponents {
  classification: number;
  contract: number;
  evidence: number;
  efficiency: number;
  policy: number;
}

export interface RunScore {
  total: number;
  components: RunScoreComponents;
  notes: string[];
  contract: ContractValidation;
}

export interface ScoreRunOptions {
  maxSteps?: number;
}

const WEIGHTS: RunScoreComponents = {
  classification: 0.25,
  contract: 0.30,
  evidence: 0.20,
  efficiency: 0.15,
  policy: 0.10,
};

const CLASSIFICATION_SCORE: Record<RunClassificationKind, number> = {
  "task-complete": 1,
  "partial-success": 0.65,
  "blocked-auth": 0.55,
  "blocked-policy": 0.55,
  "counterexample": 0.75,
  "site-error": 0.35,
  "agent-error": 0.2,
  "infra-error": 0.15,
  "ambiguous": 0.25,
};

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function roundScore(value: number): number {
  return Math.round(clamp01(value) * 1000) / 1000;
}

function classificationScore(run: Run): number {
  const kind = run.classification?.kind ?? "ambiguous";
  const base = CLASSIFICATION_SCORE[kind];
  const confidence = run.classification?.confidence ?? (kind === "ambiguous" ? 0 : 0.5);
  return clamp01(base * (0.7 + 0.3 * clamp01(confidence)));
}

function contractScore(validation: ContractValidation): number {
  if (validation.totalChecks === 0) return 1;
  return validation.satisfied.length / validation.totalChecks;
}

function evidenceScore(events: TraceEvent[], artifacts: Artifact[]): number {
  let score = 0;
  if (events.some((event) => event.kind === "observation")) score += 0.2;
  if (events.some((event) => event.kind === "code-exec")) score += 0.15;
  if (events.some((event) =>
    event.kind === "code-result" &&
    event.payload.ok === true &&
    (
      typeof event.payload.stdout === "string" ||
      event.payload.returnValue !== undefined ||
      Array.isArray(event.payload.artifactIds)
    )
  )) {
    score += 0.2;
  }
  if (artifacts.length > 0 || events.some((event) => event.kind === "artifact")) score += 0.25;
  if (artifacts.some((artifact) => artifact.kind === "screenshot") ||
    events.some((event) => event.kind === "artifact" && event.payload.kind === "screenshot")) {
    score += 0.1;
  }
  if (artifacts.some((artifact) => artifact.kind === "download" || artifact.kind === "json-output" || artifact.kind === "markdown" || artifact.kind === "table") ||
    events.some((event) =>
      event.kind === "artifact" &&
      ["download", "json-output", "markdown", "table"].includes(String(event.payload.kind ?? ""))
    )) {
    score += 0.1;
  }
  return clamp01(score);
}

function actionSignature(event: TraceEvent): string {
  if (event.kind === "code-exec") return String(event.payload.code ?? "");
  if (event.kind === "error") return String(event.payload.message ?? "");
  return event.kind;
}

function efficiencyScore(events: TraceEvent[], maxSteps?: number): number {
  let score = 1;
  if (maxSteps !== undefined && maxSteps > 0 && events.length > maxSteps) {
    score -= Math.min(0.5, (events.length - maxSteps) / maxSteps);
  }

  const executable = events.filter((event) => event.kind === "code-exec" || event.kind === "error");
  let repeatPenalty = 0;
  for (let i = 1; i < executable.length; i++) {
    if (actionSignature(executable[i]!) === actionSignature(executable[i - 1]!)) {
      repeatPenalty += 0.08;
    }
  }

  const errorCount = events.filter((event) => event.kind === "error").length;
  score -= Math.min(0.25, errorCount * 0.04);
  score -= Math.min(0.25, repeatPenalty);
  return clamp01(score);
}

function policyScore(events: TraceEvent[]): number {
  const policyChecks = events.filter((event) => event.kind === "policy-check");
  const approvals = events.filter((event) => event.kind === "approval-request" || event.kind === "approval-result");
  let score = 1;

  for (const event of policyChecks) {
    const result = String(event.payload.result ?? "");
    if (result === "deny") score -= 0.35;
    if (result === "require-approval") score -= 0.05;
  }

  for (const event of approvals) {
    const status = String(event.payload.status ?? "");
    if (status === "rejected" || status === "expired") score -= 0.15;
  }

  return policyChecks.length === 0 && approvals.length === 0 ? 1 : clamp01(score);
}

export function scoreRun(
  task: Task,
  run: Run,
  events: TraceEvent[],
  artifacts: Artifact[],
  options: ScoreRunOptions = {},
): RunScore {
  const notes: string[] = [];
  const contract = validateTaskContract(createTaskContract(task), events, run.result);
  const components: RunScoreComponents = {
    classification: roundScore(classificationScore(run)),
    contract: roundScore(contractScore(contract)),
    evidence: roundScore(evidenceScore(events, artifacts)),
    efficiency: roundScore(efficiencyScore(events, options.maxSteps)),
    policy: roundScore(policyScore(events)),
  };

  if (!contract.passed) notes.push(...contract.missing);
  if (components.evidence < 0.5) notes.push("Run has weak durable evidence");
  if (components.efficiency < 0.7) notes.push("Run appears inefficient or repetitive");
  if (components.policy < 1) notes.push("Run encountered policy friction");

  const total = Object.entries(components).reduce((sum, [key, value]) => {
    return sum + value * WEIGHTS[key as keyof RunScoreComponents];
  }, 0);

  return {
    total: roundScore(total),
    components,
    notes,
    contract,
  };
}
