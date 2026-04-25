import type { ProposedAction, TraceEvent } from "../shared/types.js";
import type { LoopState } from "./loop.js";

// ---------------------------------------------------------------------------
// State query helpers — pure functions over LoopState
// ---------------------------------------------------------------------------

function latestEventByKind(state: LoopState, kind: TraceEvent["kind"]): TraceEvent | undefined {
  return [...state.events].reverse().find((event) => event.kind === kind);
}

export function latestObservation(state: LoopState): TraceEvent | undefined {
  return latestEventByKind(state, "observation");
}

export function latestError(state: LoopState): TraceEvent | undefined {
  return latestEventByKind(state, "error");
}

export function latestCodeResult(state: LoopState): TraceEvent | undefined {
  return latestEventByKind(state, "code-result");
}

export function hasRecordedTaskArtifact(state: LoopState): boolean {
  return state.events.some((event) =>
    event.kind === "artifact" &&
    typeof event.payload.kind === "string" &&
    typeof event.payload.content === "string" &&
    event.payload.content.trim().length > 0
  );
}

export function hasExtractedTaskResult(state: LoopState): boolean {
  const result = latestCodeResult(state);
  if (!result || result.payload.ok !== true) {
    return false;
  }

  return (
    (typeof result.payload.stdout === "string" && result.payload.stdout.trim().length > 0) ||
    result.payload.returnValue !== undefined
  );
}

export function hasAttemptedExtraction(state: LoopState): boolean {
  return state.events.some((event) =>
    event.kind === "code-exec" &&
    typeof event.payload.code === "string" &&
    event.payload.code.includes("wire:extract")
  );
}

export function hasMeaningfulProgress(state: LoopState): boolean {
  const observations = state.events.filter((event) => event.kind === "observation");
  const codeExecs = state.events.filter((event) => event.kind === "code-exec");
  return observations.length > 1 || codeExecs.length > 0;
}

export function buildFailureSummary(state: LoopState): string | undefined {
  if (!hasMeaningfulProgress(state)) {
    return undefined;
  }

  const observation = latestObservation(state);
  const error = latestError(state);
  const parts: string[] = [];

  if (observation) {
    const title = typeof observation.payload.title === "string" ? observation.payload.title : undefined;
    const url = typeof observation.payload.url === "string" ? observation.payload.url : undefined;
    if (title && url) {
      parts.push(`Reached ${title} at ${url}`);
    } else if (url) {
      parts.push(`Reached ${url}`);
    }
  }

  if (error && typeof error.payload.message === "string") {
    parts.push(`Run stopped with error: ${error.payload.message}`);
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function isRecoverableStepError(message: string): boolean {
  return /Target not found|timeout|network|ECONN|ETIMEDOUT|ENOTFOUND|fetch|Execution context was destroyed|Cannot find context|wasn't found|Not supported|CDP error|Session closed/iu
    .test(message);
}

// ---------------------------------------------------------------------------
// Observation diffing — detect stalled progress
// ---------------------------------------------------------------------------

export interface ObservationDiff {
  urlChanged: boolean;
  titleChanged: boolean;
  visibleTextChanged: boolean;
  unchanged: boolean;
  summary: string;
}

export function computeObservationDiff(
  oldObs: TraceEvent | undefined,
  newObs: TraceEvent,
): ObservationDiff {
  if (!oldObs) {
    return { urlChanged: false, titleChanged: false, visibleTextChanged: false, unchanged: false, summary: "First observation" };
  }

  const urlChanged = String(oldObs.payload.url ?? "") !== String(newObs.payload.url ?? "");
  const titleChanged = String(oldObs.payload.title ?? "") !== String(newObs.payload.title ?? "");

  const oldTexts = ((oldObs.payload.pageSummary as Record<string, unknown>)?.visibleTexts) as string[] | undefined;
  const newTexts = ((newObs.payload.pageSummary as Record<string, unknown>)?.visibleTexts) as string[] | undefined;
  const visibleTextChanged = (oldTexts?.join("") ?? "") !== (newTexts?.join("") ?? "");

  const unchanged = !urlChanged && !titleChanged && !visibleTextChanged;

  const parts: string[] = [];
  if (urlChanged) parts.push(`URL changed to ${newObs.payload.url}`);
  if (titleChanged) parts.push(`Title changed to ${newObs.payload.title}`);

  // Detect numeric changes (e.g. scores) in visible text
  if (visibleTextChanged && oldTexts && newTexts) {
    const oldNums = (oldTexts.join(" ").match(/\d+/g) ?? []).join(",");
    const newNums = (newTexts.join(" ").match(/\d+/g) ?? []).join(",");
    if (oldNums !== newNums) {
      parts.push(`Numeric values changed`);
    }
  }

  const summary = parts.length > 0 ? parts.join("; ") : "Page unchanged";

  return { urlChanged, titleChanged, visibleTextChanged, unchanged, summary };
}

export function countConsecutiveUnchanged(events: TraceEvent[]): number {
  const observations = events.filter((e) => e.kind === "observation");
  if (observations.length < 2) return 0;

  let count = 0;
  for (let i = observations.length - 1; i >= 1; i--) {
    const prev = observations[i - 1]!;
    const curr = observations[i]!;
    const diff = computeObservationDiff(prev, curr);
    if (diff.unchanged) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

export function buildGenericExtractionAction(): ProposedAction {
  return {
    kind: "exec",
    summary: "Extract current page content",
    payload: {
      code: "/* wire:extract */ return { title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 5000) ?? '' }",
    },
  };
}
