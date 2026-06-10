import type { RunClassification, RunClassificationKind, TaskMode, TraceEvent } from "../shared/types.js";
import { isNavigationOnlyResult } from "./state-helpers.js";

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

// Detects "JSON-shaped extraction with mostly empty fields" — the classic
// false-positive shape where the agent built a result schema but couldn't
// fill it (e.g. grants.gov run_48b5ae4d returned {agency:"",cfda:"",...}).
// Returns true when ≥50% of the named scalar fields are empty/null/undefined.
function hasMostlyEmptyFields(resultText: string): boolean {
  let parsed: unknown;
  try { parsed = JSON.parse(resultText); } catch { return false; }
  const records: Array<Record<string, unknown>> = [];
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    records.push(parsed as Record<string, unknown>);
  } else if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && typeof parsed[0] === "object") {
    records.push(...(parsed as Array<Record<string, unknown>>));
  } else { return false; }
  let total = 0;
  let empty = 0;
  for (const record of records) {
    for (const value of Object.values(record)) {
      if (value === null || value === undefined) { total++; empty++; continue; }
      if (typeof value === "string") { total++; if (value.trim().length === 0) empty++; continue; }
      if (typeof value === "number" || typeof value === "boolean") { total++; continue; }
    }
  }
  return total >= 3 && empty / total >= 0.5;
}

// Markers that the result is a search/results page echoing the query rather
// than an answer source. A reflected %22 (encoded quote) is a strong tell: the
// agent read back its own percent-encoded query instead of extracted content.
const QUERY_ECHO_MARKERS: RegExp[] = [
  /%22/,
  /(?:found|returned) \d+ answers? to/i,
  /showing results for\b/i,
];

function looksLikeQueryEcho(resultText: string): boolean {
  return QUERY_ECHO_MARKERS.some((m) => m.test(resultText));
}

// Page-chrome markers — nav, ads, and boilerplate that ride along when the agent
// dumps a whole page's innerText instead of extracting from it.
const PAGE_CHROME_MARKERS = [
  "advertisement",
  "skip to main content",
  "sign in",
  "subscribe",
  "cookie policy",
  "privacy policy",
  "terms of service",
  "all rights reserved",
];

// Detects a large blob of page innerText passed off as the answer. Per the
// MANIFESTO, a page dump doesn't prove an answer — the agent pasted the page
// instead of extracting from it. Gated on ≥2 chrome markers so a legitimately
// large structured result isn't penalized for length alone.
function looksLikeRawPageDump(resultText: string): boolean {
  if (resultText.length < 1200) return false;
  const lower = resultText.toLowerCase();
  const chromeHits = PAGE_CHROME_MARKERS.filter((m) => lower.includes(m)).length;
  return chromeHits >= 2;
}

// A result that is still page material — a reflected query or a wholesale
// innerText dump — rather than content extracted from it. Shared with the
// completion contract so question tasks can demand an actual answer.
export function looksLikeUnextractedPage(resultText: string): boolean {
  return looksLikeQueryEcho(resultText) || looksLikeRawPageDump(resultText);
}

function hasGenericExtractionFailure(resultText: string | undefined): boolean {
  if (!resultText) return false;
  if (hasMostlyEmptyFields(resultText)) return true;
  return looksLikeUnextractedPage(resultText);
}

function latestFailedContractCheck(events: TraceEvent[]): string[] {
  const failed = [...events].reverse().find((event) =>
    event.kind === "contract-check" &&
    event.payload.passed === false
  );
  if (!failed) return [];
  const missing = failed.payload.missing;
  return Array.isArray(missing) ? missing.map(String).filter((item) => item.length > 0) : ["Completion contract failed"];
}

function latestFailedArtifactReview(events: TraceEvent[]): string[] {
  const latest = [...events].reverse().find((event) => event.kind === "artifact-review");
  if (!latest || latest.payload.passed !== false) return [];
  const problems = latest.payload.problems;
  return Array.isArray(problems) ? problems.map(String).filter((item) => item.length > 0) : ["Artifact review failed"];
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

  const finalResultText = extractFinalResultText(events);
  const genericExtractionFailure = mode === "task" && hasGenericExtractionFailure(finalResultText);
  const contractFailures = latestFailedContractCheck(events);
  const contractPassed = contractFailures.length === 0;
  const artifactReviewFailures = latestFailedArtifactReview(events);
  const artifactReviewPassed = artifactReviewFailures.length === 0;

  if (codeSuccessCount > 0 && codeFailCount === 0) {
    const hasAnswerArtifact = answerArtifactCount > 0 || (terminalEventHasExtractedAnswer && !terminalIsNavOnly);
    const taskModeHasCompletionEvidence = mode === "task"
      ? hasAnswerArtifact && codeSuccessWithOutputCount > 0
      : hasEvidence && (terminalEventIsEvidence || terminalEventHasExtractedAnswer);

    if (taskModeHasCompletionEvidence) {
      if (!contractPassed) {
        return {
          kind: "partial-success",
          confidence: 0.55,
          notes: ["Completion contract failed", ...contractFailures.slice(0, 3)],
        };
      }
      if (!artifactReviewPassed) {
        return {
          kind: "partial-success",
          confidence: 0.55,
          notes: ["Artifact review failed", ...artifactReviewFailures.slice(0, 3)],
        };
      }
      if (!genericExtractionFailure) {
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
      // Has output, but its shape matches a generic extraction failure.
      return {
        kind: "partial-success",
        confidence: 0.55,
        notes: ["Extracted output has a generic failure shape"],
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
    if (mode === "task" && hasAnswerArtifact && !contractPassed) {
      return {
        kind: "partial-success",
        confidence: 0.55,
        notes: [
          `Recovered after ${codeFailCount} failed code execution${codeFailCount === 1 ? "" : "s"}`,
          "Completion contract failed",
          ...contractFailures.slice(0, 3),
        ],
      };
    }
    if (mode === "task" && hasAnswerArtifact && !artifactReviewPassed) {
      return {
        kind: "partial-success",
        confidence: 0.55,
        notes: [
          `Recovered after ${codeFailCount} failed code execution${codeFailCount === 1 ? "" : "s"}`,
          "Artifact review failed",
          ...artifactReviewFailures.slice(0, 3),
        ],
      };
    }
    if (mode === "task" && hasAnswerArtifact && !genericExtractionFailure) {
      return {
        kind: "task-complete",
        confidence: 0.7,
        notes: [`Recovered after ${codeFailCount} failed code execution${codeFailCount === 1 ? "" : "s"}`],
      };
    }
    if (mode === "task" && hasAnswerArtifact && genericExtractionFailure) {
      return {
        kind: "partial-success",
        confidence: 0.55,
        notes: [
          `Recovered after ${codeFailCount} failed code execution${codeFailCount === 1 ? "" : "s"}`,
          "Extracted output has a generic failure shape",
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

// Outcome summary from trace

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
