import type { RunClassification, RunClassificationKind, TaskMode, TraceEvent } from "../shared/types.js";
import { isNavigationOnlyResult } from "./state-helpers.js";

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "from", "this", "that", "then", "than",
  "are", "was", "has", "have", "been", "will", "would", "could", "should",
  "into", "about", "after", "their", "them", "they", "when", "what", "which",
  "extract", "return", "using", "page",
]);

const ACTION_VERBS = new Set([
  "win", "find", "get", "solve", "complete", "extract", "navigate", "open",
  "click", "fill", "submit", "download", "upload", "create", "delete",
  "update", "read", "verify", "check", "confirm", "score", "reach",
  "achieve", "beat", "finish", "play",
]);

function objectiveKeywords(text: string): Set<string> {
  const matches = text.match(/[a-z0-9]{3,}/giu) ?? [];
  return new Set(matches.map((m) => m.toLowerCase()).filter((w) => !STOP_WORDS.has(w)));
}

function objectiveVerbPhrases(text: string): Set<string> {
  const matches = text.match(/[a-z0-9]{3,}/giu) ?? [];
  return new Set(
    matches.map((m) => m.toLowerCase())
      .filter((w) => !STOP_WORDS.has(w))
      .filter((w) => ACTION_VERBS.has(w) || w.length >= 4),
  );
}

function extractFinalResultText(events: TraceEvent[]): string | undefined {
  const lastResult = [...events].reverse().find((e) =>
    e.kind === "code-result" &&
    e.payload.ok === true &&
    (
      (typeof e.payload.stdout === "string" && e.payload.stdout.trim().length > 0) ||
      e.payload.returnValue !== undefined
    ),
  );

  if (lastResult) {
    const stdout = lastResult.payload.stdout;
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      return stdout;
    }
    const rv = lastResult.payload.returnValue;
    if (rv !== undefined) {
      return typeof rv === "string" ? rv : JSON.stringify(rv);
    }
  }

  const lastNote = [...events].reverse().find((e) =>
    e.kind === "artifact" &&
    e.payload.kind === "note" &&
    typeof e.payload.content === "string" &&
    (e.payload.content as string).trim().length > 0,
  );

  if (lastNote && typeof lastNote.payload.content === "string") {
    return lastNote.payload.content;
  }

  return undefined;
}

function objectiveIterationSatisfied(resultText: string | undefined, objective: string): boolean {
  const needed = objective.match(/\b(\d+)\s+(?:times|runs?|plays?|games?)\b/iu);
  if (!needed || !resultText) return false;
  const target = Number(needed[1]);
  const repeatedItems = resultText.match(/"(?:run|game|play)"\s*:/giu)?.length ?? 0;
  if (repeatedItems >= target) return true;
  const count = resultText.match(/"(?:runsCount|playsCompleted|playsDone|gamesCompleted|completed)"\s*:\s*(\d+)/iu);
  return count ? Number(count[1]) >= target : false;
}

function resultAddressesObjective(resultText: string | undefined, objective: string): boolean {
  if (!resultText || !objective) return true;
  if (objectiveIterationSatisfied(resultText, objective)) return true;

  const verbPhrases = objectiveVerbPhrases(objective);
  if (verbPhrases.size === 0) return true;

  const resultLower = resultText.toLowerCase();
  for (const word of verbPhrases) {
    if (resultLower.includes(word)) {
      return true;
    }
  }

  const objWords = objectiveKeywords(objective);
  for (const word of objWords) {
    if (resultLower.includes(word)) {
      return true;
    }
  }

  return false;
}

export interface ClassificationInput {
  mode: TaskMode;
  events: TraceEvent[];
  successCriteria: string[];
  objective?: string;
  errorCount: number;
  authWallHit: boolean;
  policyDenied: boolean;
  budgetExhausted: boolean;
  awaitingApproval?: boolean;
  consecutiveUnchanged?: number;
}

export function classifyRun(input: ClassificationInput): RunClassification {
  const {
    mode,
    events,
    objective,
    errorCount,
    authWallHit,
    policyDenied,
    budgetExhausted,
    awaitingApproval,
    consecutiveUnchanged,
  } = input;

  if (awaitingApproval) {
    return { kind: "ambiguous", confidence: 0.85, notes: ["Awaiting human approval"] };
  }

  // Check for specific failure patterns in error events
  const errorEvents = events.filter((e) => e.kind === "error");

  // Browser crash: session errors with crash/disconnect indicators, no subsequent observations
  const hasBrowserCrash = errorEvents.some((e) => {
    const msg = String(e.payload.message ?? "").toLowerCase();
    const code = String(e.payload.code ?? "").toLowerCase();
    return (
      (msg.includes("session") && (msg.includes("crashed") || msg.includes("disconnected") || msg.includes("target closed"))) ||
      code.includes("session") && code.includes("crash")
    );
  });
  if (hasBrowserCrash) {
    const hasSubsequentObservation = events.some((e, i) => {
      const crashIdx = errorEvents.findIndex((crash) => events.indexOf(crash) < i);
      return e.kind === "observation" && crashIdx !== -1;
    });
    if (!hasSubsequentObservation) {
      return { kind: "infra-error", confidence: 0.85, notes: ["Browser session crashed or disconnected"] };
    }
  }

  // Captcha: observation content containing captcha indicators
  const captchaObservation = events.find((e) => {
    if (e.kind !== "observation") return false;
    const text = [
      String(e.payload.url ?? ""),
      String(e.payload.title ?? ""),
    ].join(" ").toLowerCase();
    return text.includes("captcha") || text.includes("recaptcha") || text.includes("cloudflare");
  });
  if (captchaObservation) {
    return { kind: "blocked-auth", confidence: 0.8, notes: ["Captcha or anti-bot challenge detected"] };
  }

  // Rate-limited: error events with 429/rate limit indicators
  const rateLimitedError = errorEvents.find((e) => {
    const msg = String(e.payload.message ?? "").toLowerCase();
    const code = String(e.payload.code ?? "");
    return msg.includes("429") || msg.includes("rate limit") || msg.includes("too many requests") || code === "429";
  });
  if (rateLimitedError) {
    return { kind: "site-error", confidence: 0.85, notes: ["Rate limit or 429 response detected"] };
  }

  // Network timeout: error events with ETIMEDOUT/network timeout
  const networkTimeoutError = errorEvents.find((e) => {
    const msg = String(e.payload.message ?? "").toLowerCase();
    const code = String(e.payload.code ?? "");
    return msg.includes("etimedout") || msg.includes("network timeout") || code === "ETIMEDOUT";
  });
  if (networkTimeoutError) {
    return { kind: "infra-error", confidence: 0.85, notes: ["Network timeout detected"] };
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
  // Only count substantive artifacts (extracted data), not synthetic task summaries
  const answerArtifactCount = events.filter(
    (e) => e.kind === "artifact" && e.payload.source !== "task-summary",
  ).length;
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
  const terminalIsNavOnly = terminalEvent?.kind === "code-result" && isNavigationOnlyResult(terminalEvent);

  // In task mode, check whether the extracted result addresses the objective.
  // This prevents classifying runs as "task-complete" when the agent extracted
  // unrelated content (e.g. homepage text instead of search results).
  // In investigate/experiment mode, skip this check — the objective is exploratory.
  const objectiveRelevant = mode === "task" && objective;
  const finalResultText = extractFinalResultText(events);
  const addressesObjective = !objectiveRelevant || resultAddressesObjective(finalResultText, objective!);

  if (codeSuccessCount > 0 && codeFailCount === 0) {
    const hasAnswerArtifact = answerArtifactCount > 0 || (terminalEventHasExtractedAnswer && !terminalIsNavOnly);
    const taskModeHasCompletionEvidence = mode === "task"
      ? hasAnswerArtifact && codeSuccessWithOutputCount > 0
      : hasEvidence && (terminalEventIsEvidence || terminalEventHasExtractedAnswer);

    if (taskModeHasCompletionEvidence) {
      if (addressesObjective) {
        if (errorCount > 0) {
          const recovered: RunClassification = {
            kind: "task-complete",
            confidence: 0.7,
            notes: [`Recovered after ${errorCount} error${errorCount === 1 ? "" : "s"}`],
          };
          return mode === "task" && hasAnswerArtifact
            ? recovered
            : applyStagnationDowngrade(recovered, consecutiveUnchanged);
        }
        const complete: RunClassification = { kind: "task-complete", confidence: 0.85 };
        return mode === "task" && hasAnswerArtifact
          ? complete
          : applyStagnationDowngrade(complete, consecutiveUnchanged);
      }
      // Has output but it doesn't address the objective
      return {
        kind: "partial-success",
        confidence: 0.55,
        notes: ["Extracted output does not appear to address the task objective"],
      };
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

  // Partial success — but if the run recovered and has a real answer artifact, count it complete
  if (codeSuccessCount > 0 && codeFailCount > 0) {
    const hasAnswerArtifact = answerArtifactCount > 0 && codeSuccessWithOutputCount > 0;
    if (mode === "task" && hasAnswerArtifact && addressesObjective) {
      return {
        kind: "task-complete",
        confidence: 0.7,
        notes: [`Recovered after ${codeFailCount} failed code execution${codeFailCount === 1 ? "" : "s"}`],
      };
    }
    if (mode === "task" && hasAnswerArtifact && !addressesObjective) {
      return {
        kind: "partial-success",
        confidence: 0.55,
        notes: [
          `Recovered after ${codeFailCount} failed code execution${codeFailCount === 1 ? "" : "s"}`,
          "Extracted output does not appear to address the task objective",
        ],
      };
    }

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

function applyStagnationDowngrade(
  classification: RunClassification,
  consecutiveUnchanged?: number,
): RunClassification {
  if (classification.kind !== "task-complete") return classification;
  if (!consecutiveUnchanged || consecutiveUnchanged < 2) return classification;

  return {
    kind: "partial-success",
    confidence: Math.min(classification.confidence, 0.5),
    notes: [
      ...(classification.notes ?? []),
      `Stagnation: ${consecutiveUnchanged} consecutive unchanged observations before completion`,
    ],
  };
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
