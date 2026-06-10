import type {
  ExperimentBundle,
  ExperimentSummary,
  Hypothesis,
  HypothesisId,
  Run,
  RunClassification,
} from "../shared/types.js";

export function buildExperimentSummary(
  bundle: ExperimentBundle,
  runs: Run[],
): ExperimentSummary {
  const supportedHypotheses: HypothesisId[] = [];
  const rejectedHypotheses: HypothesisId[] = [];
  const ambiguousHypotheses: HypothesisId[] = [];
  const keyEvidence: string[] = [];

  const hypothesisMap = new Map<HypothesisId, Hypothesis>();
  for (const h of bundle.hypotheses) {
    hypothesisMap.set(h.id, h);
  }

  const runsByHypothesis = new Map<HypothesisId, Run[]>();
  const unassociatedRuns: Run[] = [];

  for (const run of runs) {
    if (run.hypothesisId) {
      const list = runsByHypothesis.get(run.hypothesisId);
      if (list) {
        list.push(run);
      } else {
        runsByHypothesis.set(run.hypothesisId, [run]);
      }
    } else {
      unassociatedRuns.push(run);
    }
  }

  for (const hypothesis of bundle.hypotheses) {
    const hypothesisRuns = runsByHypothesis.get(hypothesis.id) ?? [];
    const { status, evidence } = classifyHypothesisOutcome(hypothesis, hypothesisRuns);
    keyEvidence.push(...evidence);

    switch (status) {
      case "supported":
        supportedHypotheses.push(hypothesis.id);
        break;
      case "rejected":
        rejectedHypotheses.push(hypothesis.id);
        break;
      case "ambiguous":
        ambiguousHypotheses.push(hypothesis.id);
        break;
      // "active" hypotheses with no conclusive data stay uncategorized
    }
  }

  for (const run of unassociatedRuns) {
    const note = run.outcomeSummary ?? `Run ${run.id} completed with status ${run.status}`;
    keyEvidence.push(note);
  }

  const nextBestExperiments = suggestNextExperiments(
    bundle,
    supportedHypotheses,
    rejectedHypotheses,
    ambiguousHypotheses,
  );

  return {
    supportedHypotheses,
    rejectedHypotheses,
    ambiguousHypotheses,
    keyEvidence,
    nextBestExperiments,
  };
}

function classifyHypothesisOutcome(
  hypothesis: Hypothesis,
  runs: Run[],
): { status: "supported" | "rejected" | "ambiguous" | "active"; evidence: string[] } {
  const evidence: string[] = [];

  if (runs.length === 0) {
    return { status: hypothesis.status === "active" ? "active" : hypothesis.status, evidence };
  }

  let successes = 0;
  let failures = 0;
  let ambiguous = 0;

  for (const run of runs) {
    const classification = run.classification;
    const summary = run.outcomeSummary ?? `Run ${run.id}: ${run.status}`;

    // A run only corroborates when its status AND classification agree it
    // completed; a succeeded run classified partial/ambiguous is inconclusive
    // evidence, not support.
    const classificationAgrees = !classification || classification.kind === "task-complete";

    if (run.status === "succeeded" && classificationAgrees) {
      successes += 1;
      evidence.push(`[support] ${summary}`);
    } else if (run.status === "failed") {
      failures += 1;
      evidence.push(`[contradict] ${summary}`);
    } else {
      ambiguous += 1;
      evidence.push(`[inconclusive] ${summary}`);
    }

    if (classification) {
      const notes = classification.notes;
      if (notes) {
        for (const note of notes) {
          evidence.push(`[classification:${classification.kind}] ${note}`);
        }
      }
    }
  }

  // MANIFESTO: "a lucky success that teaches nothing is weak" — one clean
  // success is not confirmation. Supported requires at least two corroborating
  // runs with no contradiction; a single success stays ambiguous.
  if (successes >= 2 && failures === 0) {
    return { status: "supported", evidence };
  }
  if (successes === 1 && failures === 0 && ambiguous === 0) {
    evidence.push("[inconclusive] single corroborating run — needs replication before the hypothesis counts as supported");
    return { status: "ambiguous", evidence };
  }
  if (failures > 0 && successes === 0) {
    return { status: "rejected", evidence };
  }
  return { status: "ambiguous", evidence };
}

function suggestNextExperiments(
  bundle: ExperimentBundle,
  supported: HypothesisId[],
  rejected: HypothesisId[],
  ambiguous: HypothesisId[],
): string[] {
  const suggestions: string[] = [];

  if (ambiguous.length > 0) {
    suggestions.push(
      "Run additional trials to resolve ambiguous hypotheses before drawing conclusions",
    );
  }

  if (supported.length > 0 && ambiguous.length === 0 && rejected.length === 0) {
    suggestions.push(
      "All tested hypotheses are supported; consider testing on a broader task set",
    );
  }

  if (rejected.length > 0) {
    suggestions.push(
      "Review rejected hypotheses for insights and formulate alternative hypotheses",
    );
  }

  if (bundle.runIds.length < 3) {
    suggestions.push("Increase sample size with more runs to improve statistical confidence");
  }

  return suggestions;
}

export function formatExperimentSummary(summary: ExperimentSummary): string {
  const lines: string[] = [];

  lines.push("=== Experiment Summary ===");
  lines.push("");
  lines.push(`Supported hypotheses: ${summary.supportedHypotheses.length}`);
  lines.push(`Rejected hypotheses:  ${summary.rejectedHypotheses.length}`);
  lines.push(`Ambiguous hypotheses: ${summary.ambiguousHypotheses.length}`);
  lines.push("");

  if (summary.supportedHypotheses.length > 0) {
    lines.push("Supported:");
    for (const id of summary.supportedHypotheses) {
      lines.push(`  - ${id}`);
    }
    lines.push("");
  }

  if (summary.rejectedHypotheses.length > 0) {
    lines.push("Rejected:");
    for (const id of summary.rejectedHypotheses) {
      lines.push(`  - ${id}`);
    }
    lines.push("");
  }

  if (summary.ambiguousHypotheses.length > 0) {
    lines.push("Ambiguous:");
    for (const id of summary.ambiguousHypotheses) {
      lines.push(`  - ${id}`);
    }
    lines.push("");
  }

  if (summary.keyEvidence.length > 0) {
    lines.push("Key evidence:");
    for (const entry of summary.keyEvidence) {
      lines.push(`  - ${entry}`);
    }
    lines.push("");
  }

  if (summary.nextBestExperiments.length > 0) {
    lines.push("Suggested next experiments:");
    for (const suggestion of summary.nextBestExperiments) {
      lines.push(`  - ${suggestion}`);
    }
  }

  return lines.join("\n");
}
