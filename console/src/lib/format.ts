// ABOUTME: Helpers to derive the agent's answer and pretty-render raw output.
// ABOUTME: The console favors the finish summary over the raw extraction blob.

import type { WireTraceEvent } from "./protocol";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** The agent's natural-language finish summary, or null if the run emitted none. */
export function finishSummary(events: WireTraceEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!;
    if (event.kind !== "thought-summary") continue;
    if (event.payload["kind"] === "finish") {
      return asString(event.payload["summary"] ?? event.payload["reason"]);
    }
  }
  return null;
}

/** Whether a string parses as JSON (object/array) worth pretty-printing. */
export function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trimStart();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}

/** Pretty-print a JSON result string; falls back to the original if it isn't JSON. */
export function prettyResult(raw: string): string {
  if (!looksLikeJson(raw)) return raw;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}
