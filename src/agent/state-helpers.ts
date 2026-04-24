import type { ProposedAction, TraceEvent } from "../shared/types.js";
import type { LoopState } from "./loop.js";

// ---------------------------------------------------------------------------
// State query helpers — pure functions over LoopState
// ---------------------------------------------------------------------------

export function latestObservation(state: LoopState): TraceEvent | undefined {
  return [...state.events].reverse().find((event) => event.kind === "observation");
}

export function latestError(state: LoopState): TraceEvent | undefined {
  return [...state.events].reverse().find((event) => event.kind === "error");
}

export function latestCodeResult(state: LoopState): TraceEvent | undefined {
  return [...state.events].reverse().find((event) => event.kind === "code-result");
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
  return /Target not found|timeout|network|ECONN|ETIMEDOUT|ENOTFOUND|fetch|Execution context was destroyed|Cannot find context/i
    .test(message);
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
