import type {
  Run,
  RunClassification,
  RunClassificationKind,
  TraceEvent,
} from "../shared/types.js";
import { isRecoverableStepError } from "../agent/state-helpers.js";

// Evaluation metrics

export interface TaskMetrics {
  taskId: string;
  runId: string;
  success: boolean;
  classification: RunClassificationKind;
  confidence: number;
  stepCount: number;
  codeExecutions: number;
  observations: number;
  errors: number;
  artifacts: number;
  durationMs: number;
  policyChecks: number;
  approvalRequests: number;
  skillsLoaded: number;
  autoRecoveryRate: number;
}

export function computeTaskMetrics(
  run: Run,
  events: TraceEvent[],
  artifactCount: number,
): TaskMetrics {
  const classification = run.classification ?? { kind: "ambiguous" as const, confidence: 0 };

  return {
    taskId: run.taskId,
    runId: run.id,
    success: classification.kind === "task-complete",
    classification: classification.kind,
    confidence: classification.confidence,
    stepCount: events.length,
    codeExecutions: events.filter((e) => e.kind === "code-exec").length,
    observations: events.filter((e) => e.kind === "observation").length,
    errors: events.filter((e) => e.kind === "error").length,
    artifacts: artifactCount,
    durationMs: computeDuration(events),
    policyChecks: events.filter((e) => e.kind === "policy-check").length,
    approvalRequests: events.filter((e) => e.kind === "approval-request").length,
    skillsLoaded: events.filter((e) => e.kind === "skill-load").length,
    autoRecoveryRate: computeAutoRecoveryRate(events),
  };
}

// Aggregate metrics across runs

export interface AggregateMetrics {
  totalRuns: number;
  successRate: number;
  avgConfidence: number;
  avgSteps: number;
  avgDurationMs: number;
  totalErrors: number;
  classificationBreakdown: Record<RunClassificationKind, number>;
}

export function aggregateMetrics(metrics: TaskMetrics[]): AggregateMetrics {
  const breakdown: Record<string, number> = {};

  for (const m of metrics) {
    breakdown[m.classification] = (breakdown[m.classification] ?? 0) + 1;
  }

  const successes = metrics.filter((m) => m.success).length;

  return {
    totalRuns: metrics.length,
    successRate: metrics.length > 0 ? successes / metrics.length : 0,
    avgConfidence:
      metrics.length > 0
        ? metrics.reduce((sum, m) => sum + m.confidence, 0) / metrics.length
        : 0,
    avgSteps:
      metrics.length > 0
        ? metrics.reduce((sum, m) => sum + m.stepCount, 0) / metrics.length
        : 0,
    avgDurationMs:
      metrics.length > 0
        ? metrics.reduce((sum, m) => sum + m.durationMs, 0) / metrics.length
        : 0,
    totalErrors: metrics.reduce((sum, m) => sum + m.errors, 0),
    classificationBreakdown: breakdown as Record<RunClassificationKind, number>,
  };
}

// Format evaluation report

export function formatEvaluationReport(
  taskMetrics: TaskMetrics[],
  aggregate: AggregateMetrics,
): string {
  const lines: string[] = [];

  lines.push("=== Wire Evaluation Report ===");
  lines.push("");
  lines.push(`Total runs:     ${aggregate.totalRuns}`);
  lines.push(`Success rate:   ${(aggregate.successRate * 100).toFixed(1)}%`);
  lines.push(`Avg confidence: ${(aggregate.avgConfidence * 100).toFixed(1)}%`);
  lines.push(`Avg steps:      ${aggregate.avgSteps.toFixed(1)}`);
  lines.push(`Avg duration:   ${aggregate.avgDurationMs.toFixed(0)}ms`);
  lines.push(`Total errors:   ${aggregate.totalErrors}`);
  lines.push("");

  lines.push("Classification breakdown:");
  for (const [kind, count] of Object.entries(aggregate.classificationBreakdown)) {
    lines.push(`  ${kind}: ${count}`);
  }
  lines.push("");

  lines.push("Per-run details:");
  for (const m of taskMetrics) {
    const status = m.success ? "PASS" : "FAIL";
    lines.push(`  [${status}] ${m.runId} - ${m.classification} (${(m.confidence * 100).toFixed(0)}%)`);
    lines.push(`    Steps: ${m.stepCount}, Errors: ${m.errors}, Artifacts: ${m.artifacts}`);
  }

  return lines.join("\n");
}

// Helpers

function computeDuration(events: TraceEvent[]): number {
  if (events.length < 2) return 0;
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  return Date.parse(sorted[sorted.length - 1]!.ts) - Date.parse(sorted[0]!.ts);
}

function computeAutoRecoveryRate(events: TraceEvent[]): number {
  const recoverableErrors: number[] = [];
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));

  for (let i = 0; i < sorted.length; i++) {
    const event = sorted[i]!;
    if (event.kind === "error" && typeof event.payload.message === "string") {
      if (isRecoverableStepError(event.payload.message)) {
        recoverableErrors.push(i);
      }
    }
  }

  if (recoverableErrors.length === 0) return 1;

  let recovered = 0;
  for (const errorIdx of recoverableErrors) {
    const next = sorted.slice(errorIdx + 1).find((e) => e.kind !== "error");
    if (next !== undefined) {
      recovered++;
    }
  }

  return recovered / recoverableErrors.length;
}
