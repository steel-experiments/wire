import type { BrowserObservation, JsonObject, JsonValue, SessionId } from "../shared/types.js";

import type { BrowserProvider, BrowserObserveInput } from "./bridge.js";

// Browser observation adapter

export interface ObserveOptions {
  provider: BrowserProvider;
  sessionId: SessionId;
  targetId?: string;
  includePageSketch?: boolean;
  artifactDir?: string;
}

export interface ObservationPayloadOptions {
  includeScreenshotArtifactId?: boolean;
}

/**
 * Produce a compact observation bundle for the current browser state.
 *
 * This is a thin adapter: it builds the provider input, delegates to
 * `provider.observe()`, and returns the result as-is. Artifact persistence
 * is handled upstream by the runtime (trace/artifact layer), not here.
 */
export async function observeBrowser(options: ObserveOptions): Promise<BrowserObservation> {
  const input: BrowserObserveInput = {
    sessionId: options.sessionId,
  };

  if (options.targetId) {
    input.targetId = options.targetId;
  }
  if (options.includePageSketch !== undefined) {
    input.includePageSketch = options.includePageSketch;
  }

  return options.provider.observe(input);
}

/**
 * Normalize a BrowserObservation into trace-safe JSON payload shape.
 */
export function toObservationPayload(
  observation: BrowserObservation,
  options: ObservationPayloadOptions = {},
): JsonObject {
  const payload: JsonObject = {
    url: observation.url,
    title: observation.title,
  };

  if (observation.targetId) {
    payload.targetId = observation.targetId;
  }
  if (observation.tabs.length > 0) {
    payload.tabs = observation.tabs as unknown as JsonValue;
  }
  if (observation.focusedElement) {
    payload.focusedElement = observation.focusedElement as unknown as JsonObject;
  }
  if (observation.pageSummary) {
    payload.pageSummary = observation.pageSummary as unknown as JsonObject;
  }
  if (observation.pageSketch) {
    payload.pageSketch = observation.pageSketch as unknown as JsonObject;
  }
  if (options.includeScreenshotArtifactId && observation.screenshotArtifactId) {
    payload.screenshotArtifactId = observation.screenshotArtifactId;
  }

  return payload;
}
