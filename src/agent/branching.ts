import { createId, nowIsoUtc } from "../shared/ids.js";
import type {
  HypothesisId,
  Run,
  RunClassification,
  RunClassificationKind,
} from "../shared/types.js";

export interface BranchDecision {
  shouldBranch: boolean;
  reason?: string;
  branchLabel?: string;
  hypothesisId?: HypothesisId;
}

export function shouldBranch(
  classification: RunClassification,
  runCount: number,
  maxRuns: number,
): BranchDecision {
  const budgetRemaining = maxRuns - runCount;

  // Underspecified success criteria: ambiguous outcome with budget remaining
  if (classification.kind === "ambiguous" && budgetRemaining > 1) {
    return {
      shouldBranch: true,
      reason: "Ambiguous outcome suggests underspecified success criteria",
      branchLabel: "clarify-criteria",
    };
  }

  // Multi-cause failures: agent errors or site errors with room to explore alternatives
  if (
    (classification.kind === "agent-error" || classification.kind === "site-error") &&
    budgetRemaining > 1
  ) {
    return {
      shouldBranch: true,
      reason: `${classification.kind} may indicate multiple failure causes; branching to isolate`,
      branchLabel: `isolate-${classification.kind}`,
    };
  }

  // Partial success: explore alternative approaches to complete remaining work
  if (classification.kind === "partial-success" && budgetRemaining > 1) {
    return {
      shouldBranch: true,
      reason: "Partial success; branching to explore alternative approaches for remaining work",
      branchLabel: "alternative-approach",
    };
  }

  // High ambiguity cost: counterexamples deserve a separate branch to investigate
  if (classification.kind === "counterexample" && budgetRemaining > 1) {
    return {
      shouldBranch: true,
      reason: "Counterexample found; branching to investigate boundary conditions",
      branchLabel: "counterexample-probe",
    };
  }

  // Low confidence on any classification: might benefit from branching
  if (classification.confidence < 0.5 && budgetRemaining > 1) {
    return {
      shouldBranch: true,
      reason: "Low classification confidence; branching to reduce ambiguity",
      branchLabel: "reduce-ambiguity",
    };
  }

  // No reason to branch
  return { shouldBranch: false };
}

export function createBranchRun(
  parentRun: Run,
  label: string,
  hypothesisId?: HypothesisId,
): Run {
  const branchRun: Run = {
    id: createId("run"),
    taskId: parentRun.taskId,
    parentRunId: parentRun.id,
    branchLabel: label,
    status: "queued",
  };

  if (hypothesisId) {
    branchRun.hypothesisId = hypothesisId;
  }

  return branchRun;
}
