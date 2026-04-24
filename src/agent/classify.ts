import type { RunClassification, RunClassificationKind, TaskMode, TraceEvent } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Run classification from trace evidence
// ---------------------------------------------------------------------------

export interface ClassificationInput {
  mode: TaskMode;
  events: TraceEvent[];
  successCriteria: string[];
  errorCount: number;
  authWallHit: boolean;
  policyDenied: boolean;
  budgetExhausted: boolean;
  awaitingApproval?: boolean;
}

export function classifyRun(input: ClassificationInput): RunClassification {
  const {
    mode,
    events,
    errorCount,
    authWallHit,
    policyDenied,
    budgetExhausted,
    awaitingApproval,
  } = input;

  if (awaitingApproval) {
    return { kind: "ambiguous", confidence: 0.85, notes: ["Awaiting human approval"] };
  }

  // Policy denial or auth wall → specific classifications
  if (policyDenied) {
    return { kind: "agent-error", confidence: 0.95, notes: ["Policy denied further progress"] };
  }

  if (authWallHit) {
    return { kind: "blocked-auth", confidence: 0.9, notes: ["Auth wall requires user assistance"] };
  }

  if (budgetExhausted) {
    return { kind: "ambiguous", confidence: 0.6, notes: ["Budget exhausted before completion"] };
  }

  // High error count → site or agent error
  if (errorCount > 5) {
    // If there were successful code execs, it's more likely a site issue
    const codeExecs = events.filter((e) => e.kind === "code-exec");
    const codeSuccesses = events.filter(
      (e) => e.kind === "code-result" && e.payload.ok === true,
    );

    if (codeExecs.length > 0 && codeSuccesses.length / codeExecs.length > 0.5) {
      return { kind: "site-error", confidence: 0.7, notes: ["High error count despite successful code execution"] };
    }

    return { kind: "agent-error", confidence: 0.7, notes: ["High error count during execution"] };
  }

  const artifactCount = events.filter((e) => e.kind === "artifact").length;
  const observationCount = events.filter((e) => e.kind === "observation").length;

  const codeSuccessCount = events.filter(
    (e) => e.kind === "code-result" && e.payload.ok === true,
  ).length;

  const codeSuccessWithOutputCount = events.filter(
    (e) =>
      e.kind === "code-result" &&
      e.payload.ok === true &&
      (
        (typeof e.payload.stdout === "string" && e.payload.stdout.trim().length > 0) ||
        e.payload.returnValue !== undefined
      ),
  ).length;

  const codeFailCount = events.filter(
    (e) => e.kind === "code-result" && e.payload.ok === false,
  ).length;
  const infraErrors = events.filter(
    (e) => e.kind === "error" && typeof e.payload.code === "string" && String(e.payload.code).startsWith("E"),
  );

  // MANIFESTO: "A run is not complete because the agent says so.
  // It is complete when the artifacts prove what happened."
  const hasEvidence = artifactCount > 0 || observationCount >= 2;
  const terminalEvent = [...events].reverse().find((event) =>
    event.kind !== "thought-summary" &&
    event.kind !== "skill-load" &&
    event.kind !== "policy-check" &&
    event.kind !== "skill-proposal"
  );
  const terminalEventIsEvidence = terminalEvent?.kind === "observation" || terminalEvent?.kind === "artifact";
  const terminalEventHasExtractedAnswer = terminalEvent?.kind === "code-result" &&
    terminalEvent.payload.ok === true &&
    (
      typeof terminalEvent.payload.stdout === "string" ||
      terminalEvent.payload.returnValue !== undefined
    );

  if (codeSuccessCount > 0 && codeFailCount === 0) {
    const hasAnswerArtifact = artifactCount > 0 || terminalEventHasExtractedAnswer;
    const taskModeHasCompletionEvidence = mode === "task"
      ? hasAnswerArtifact && codeSuccessWithOutputCount > 0
      : hasEvidence && (terminalEventIsEvidence || terminalEventHasExtractedAnswer);

    if (taskModeHasCompletionEvidence) {
      if (errorCount > 0) {
        return {
          kind: "task-complete",
          confidence: 0.7,
          notes: [`Recovered after ${errorCount} error${errorCount === 1 ? "" : "s"}`],
        };
      }
      return { kind: "task-complete", confidence: 0.85 };
    }

    const missingEvidenceNote = mode === "task"
      ? "Code executed without errors but did not record a final answer or artifact for the objective"
      : "Code executed without errors but did not end with evidence of the objective";

    return {
      kind: "partial-success",
      confidence: 0.6,
      notes: [missingEvidenceNote],
    };
  }

  // Partial success
  if (codeSuccessCount > 0 && codeFailCount > 0) {
    return {
      kind: "partial-success",
      confidence: 0.6,
      notes: [`${codeSuccessCount} successful, ${codeFailCount} failed code executions`],
    };
  }

  // No successes at all
  if (codeSuccessCount === 0 && codeFailCount > 0) {
    return { kind: "site-error", confidence: 0.5, notes: ["All code executions failed"] };
  }

  if (infraErrors.length > 0) {
    return { kind: "infra-error", confidence: 0.8, notes: ["Infrastructure error detected"] };
  }

  // Default to ambiguous
  return { kind: "ambiguous", confidence: 0.3, notes: ["Insufficient evidence for classification"] };
}

// ---------------------------------------------------------------------------
// Outcome summary from trace
// ---------------------------------------------------------------------------

export function generateOutcomeSummary(
  classification: RunClassification,
  events: TraceEvent[],
): string {
  const parts: string[] = [];

  parts.push(`Classification: ${classification.kind} (confidence: ${classification.confidence})`);

  if (classification.notes && classification.notes.length > 0) {
    parts.push(`Notes: ${classification.notes.join("; ")}`);
  }

  const codeExecs = events.filter((e) => e.kind === "code-exec");
  const observations = events.filter((e) => e.kind === "observation");
  const artifacts = events.filter((e) => e.kind === "artifact");
  const errors = events.filter((e) => e.kind === "error");

  parts.push(`Steps: ${codeExecs.length} code executions, ${observations.length} observations`);
  parts.push(`Artifacts: ${artifacts.length}`);

  if (errors.length > 0) {
    parts.push(`Errors: ${errors.length}`);
  }

  return parts.join("\n");
}
