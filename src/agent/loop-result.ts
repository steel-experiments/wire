import type {
  ApprovalRequest,
  JsonValue,
  ProposedAction,
  Run,
  TaskMode,
  TraceEvent,
} from "../shared/types.js";
import { nowIsoUtc, stableJsonStringify } from "../shared/ids.js";
import { scoreRun } from "../eval/scoring.js";
import { classifyRun, generateOutcomeSummary } from "./classify.js";
import { countConsecutiveUnchanged } from "./state-helpers.js";
import type { LoopResult, LoopState } from "./loop.js";
import { progressLedgerFromEvents, progressLedgerText } from "./progress-ledger.js";

export interface FinalizeOptions {
  authWallHit?: boolean;
  policyDenied?: boolean;
  budgetExhausted?: boolean;
  maxStepsReached?: boolean;
  awaitingApproval?: boolean;
  userCancelled?: boolean;
  stopReason?: string;
  pendingApproval?: ApprovalRequest;
  pendingAction?: ProposedAction;
}

function looksLikeErrorReturn(returnValue: unknown): boolean {
  if (!returnValue || typeof returnValue !== "object" || Array.isArray(returnValue)) {
    return false;
  }
  const obj = returnValue as Record<string, unknown>;
  if (typeof obj["error"] === "string" && obj["error"].length > 0) return true;
  if (obj["clicked"] === false) return true;
  if (obj["success"] === false) return true;
  if (typeof obj["status"] === "string" && /error|fail|notfound/iu.test(obj["status"] as string)) return true;
  return false;
}

function hasMeaningfulPayload(payload: TraceEvent["payload"]): boolean {
  const stdout = payload["stdout"];
  if (typeof stdout === "string" && stdout.trim().length > 0) return true;
  const ret = payload["returnValue"];
  return hasMeaningfulValue(ret);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value !== "object") return false;

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.some(([key, entryValue]) => {
    if (key === "results" && Array.isArray(entryValue) && entryValue.length === 0) return false;
    if (key === "answer" && typeof entryValue === "string" && entryValue.trim().length === 0) return false;
    return hasMeaningfulValue(entryValue);
  });
}

function hasMeaningfulDerivedResult(result: string | undefined): boolean {
  if (result === undefined) return false;
  const trimmed = result.trim();
  if (trimmed.length === 0) return false;
  try {
    return hasMeaningfulValue(JSON.parse(trimmed) as unknown);
  } catch {
    return true;
  }
}

function looksLikeWireCommand(returnValue: unknown): boolean {
  if (!returnValue || typeof returnValue !== "object" || Array.isArray(returnValue)) {
    return false;
  }
  return Array.isArray((returnValue as Record<string, unknown>)["wireActions"]);
}

function looksLikeActionAck(returnValue: unknown): boolean {
  if (!returnValue || typeof returnValue !== "object" || Array.isArray(returnValue)) {
    return false;
  }
  const obj = returnValue as Record<string, unknown>;
  return obj["navigated"] === true || obj["clicked"] === true;
}

export function deriveRunResult(events: TraceEvent[], mode: TaskMode): string | undefined {
  const candidates = [...events].reverse().filter((event) =>
    event.kind === "code-result" &&
    event.payload.ok === true &&
    event.payload.source !== "wireActions" &&
    event.payload.source !== "raw" &&
    (
      typeof event.payload.stdout === "string" ||
      event.payload.returnValue !== undefined
    )
  );

  const answerCandidates = candidates.filter(
    (event) =>
      !looksLikeWireCommand(event.payload.returnValue) &&
      !looksLikeActionAck(event.payload.returnValue),
  );
  const latestAnswerEvent =
    answerCandidates.find((event) =>
      hasMeaningfulPayload(event.payload) &&
      !looksLikeErrorReturn(event.payload.returnValue)
    ) ??
    answerCandidates.find((event) => hasMeaningfulPayload(event.payload)) ??
    answerCandidates[0];

  if (latestAnswerEvent) {
    const stdout = latestAnswerEvent.payload.stdout;
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      return stdout;
    }

    const returnValue = latestAnswerEvent.payload.returnValue;
    if (returnValue !== undefined) {
      return typeof returnValue === "string"
        ? returnValue
        : stableJsonStringify(returnValue);
    }
  }

  if (mode === "task") {
    const progressLedger = progressLedgerFromEvents(events);
    if (progressLedger.length > 0) {
      return progressLedgerText(progressLedger);
    }

    const latestNoteArtifact = [...events].reverse().find((event) =>
      event.kind === "artifact" &&
      event.payload.kind === "note" &&
      typeof event.payload.content === "string" &&
      event.payload.content.trim().length > 0
    );

    if (latestNoteArtifact && typeof latestNoteArtifact.payload.content === "string") {
      return latestNoteArtifact.payload.content;
    }

    return undefined;
  }

  const latestFinishSummary = [...events].reverse().find((event) =>
    event.kind === "thought-summary" &&
    event.payload.kind === "finish" &&
    typeof event.payload.summary === "string" &&
    event.payload.summary.trim().length > 0
  );

  if (latestFinishSummary && typeof latestFinishSummary.payload.summary === "string") {
    return latestFinishSummary.payload.summary;
  }

  return undefined;
}

export function computeFinalClassification(
  state: LoopState,
  options: FinalizeOptions = {},
): ReturnType<typeof classifyRun> {
  const errorCount = state.events.filter((e) => e.kind === "error").length;
  const derivedResult = deriveRunResult(state.events, state.task.mode);
  const classification = classifyRun({
    mode: state.task.mode,
    events: state.events,
    successCriteria: state.task.successCriteria,
    objective: state.task.objective,
    errorCount,
    authWallHit: options.authWallHit ?? false,
    policyDenied: options.policyDenied ?? false,
    budgetExhausted: options.budgetExhausted ?? false,
    awaitingApproval: options.awaitingApproval ?? false,
    consecutiveUnchanged: countConsecutiveUnchanged(state.events),
  });

  if (
    options.maxStepsReached === true &&
    !hasMeaningfulDerivedResult(derivedResult) &&
    (
      classification.kind === "task-complete" ||
      classification.kind === "partial-success" ||
      classification.kind === "ambiguous"
    )
  ) {
    return {
      kind: "agent-error",
      confidence: 0.9,
      notes: ["Maximum steps reached before producing a meaningful answer"],
    };
  }

  const stoppedForReplan = typeof options.stopReason === "string" &&
    /aborting to force re-plan/iu.test(options.stopReason);
  if (stoppedForReplan && classification.kind === "task-complete") {
    const latestValidation = [...state.events].reverse().find((event) =>
      event.kind === "contract-check" && event.payload.phase === "validated"
    );
    if (latestValidation?.payload.passed !== true) {
      return hasMeaningfulDerivedResult(derivedResult)
        ? {
          kind: "partial-success",
          confidence: 0.5,
          notes: [`Stopped for re-plan before completion: ${options.stopReason}`],
        }
        : {
          kind: "agent-error",
          confidence: 0.75,
          notes: [`Stopped for re-plan before producing a meaningful answer: ${options.stopReason}`],
        };
    }
  }

  return classification;
}

export function finalizeRun(state: LoopState, options: FinalizeOptions = {}): LoopResult {
  const derivedResult = deriveRunResult(state.events, state.task.mode);
  const classification = computeFinalClassification(state, options);

  const outcomeSummary = generateOutcomeSummary(classification, state.events);

  let status: Run["status"] = "failed";
  if (options.awaitingApproval) {
    status = "awaiting-approval";
  } else if (classification.kind === "task-complete") {
    status = "succeeded";
  } else if (classification.kind === "partial-success") {
    status = "partial";
  }

  const finishedRun: Run = {
    ...state.run,
    sessionId: state.sessionId,
    stepCount: state.stepCount,
    eventCount: state.events.length,
    artifactCount: state.events.filter((event) => event.kind === "artifact").length,
    reviewFailureCount: state.reviewFailureCount,
    status,
    classification,
    outcomeSummary,
  };

  const resultBlocked =
    (options.maxStepsReached === true && !hasMeaningfulDerivedResult(derivedResult)) ||
    (options.userCancelled === true && !hasMeaningfulDerivedResult(derivedResult));
  if (derivedResult !== undefined && !resultBlocked) {
    finishedRun.result = derivedResult;
    try {
      const resultPayload = JSON.parse(derivedResult) as JsonValue;
      finishedRun.resultPayload = resultPayload;
    } catch {
      // Keep the compatibility string for non-JSON answers.
    }
  }

  if (!options.awaitingApproval) {
    finishedRun.finishedAt = nowIsoUtc();
  }

  const result: LoopResult = {
    run: finishedRun,
    events: state.events,
    classification,
    outcomeSummary,
    sessionId: state.sessionId,
    stepCount: state.stepCount,
    startedAt: state.startedAt,
    helperSource: state.helperSource,
    helperVersion: state.helperVersion,
    reviewFailureCount: state.reviewFailureCount,
    score: scoreRun(state.task, finishedRun, state.events, []),
  };

  if (state.sessionLiveUrl !== undefined) {
    result.sessionLiveUrl = state.sessionLiveUrl;
  }

  if (options.pendingApproval) {
    result.pendingApproval = options.pendingApproval;
  }
  if (options.pendingAction) {
    result.pendingAction = options.pendingAction;
  }

  const usageEvents = state.events.filter((e) => e.kind === "llm-usage");
  if (usageEvents.length > 0) {
    let promptTokens = 0;
    let completionTokens = 0;
    for (const e of usageEvents) {
      const u = e.payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      if (u) {
        promptTokens += u.inputTokens ?? 0;
        completionTokens += u.outputTokens ?? 0;
      }
    }
    result.usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  return result;
}
