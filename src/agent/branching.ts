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
  /** Concrete instruction for the branch run so it explores a different path
   *  instead of replaying the parent. Worded to avoid domains, digits, and
   *  format words so it can never alter the inferred completion contract. */
  directive?: string;
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
      directive:
        "The prior attempt ended ambiguously. Pursue a decisive, verifiable outcome this time: reach a concrete final answer rather than stopping at an exploratory state.",
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
      directive:
        "The prior attempt failed partway through. Take a different path to the same goal: prefer a direct link or an alternate route over repeating the same navigation and interaction sequence.",
    };
  }

  // Partial success: explore alternative approaches to complete remaining work
  if (classification.kind === "partial-success" && budgetRemaining > 1) {
    return {
      shouldBranch: true,
      reason: "Partial success; branching to explore alternative approaches for remaining work",
      branchLabel: "alternative-approach",
      directive:
        "The prior attempt only partly succeeded. Complete the remaining work with a different approach than before; do not repeat the steps that stalled.",
    };
  }

  // High ambiguity cost: counterexamples deserve a separate branch to investigate
  if (classification.kind === "counterexample" && budgetRemaining > 1) {
    return {
      shouldBranch: true,
      reason: "Counterexample found; branching to investigate boundary conditions",
      branchLabel: "counterexample-probe",
      directive:
        "A counterexample appeared. Probe the boundary condition that produced it rather than re-running the main path.",
    };
  }

  // Low confidence on any classification: might benefit from branching
  if (classification.confidence < 0.5 && budgetRemaining > 1) {
    return {
      shouldBranch: true,
      reason: "Low classification confidence; branching to reduce ambiguity",
      branchLabel: "reduce-ambiguity",
      directive:
        "Confidence in the prior outcome was low. Gather stronger, more direct evidence for the objective this run, taking a different route than before.",
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
