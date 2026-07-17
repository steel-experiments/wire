import type { BrowserObservation, BrowserPageSummary, JsonObject, JsonValue, SessionId } from "../shared/types.js";
import { normalizeBrowserLinkSamples } from "../shared/link-samples.js";

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

function normalizedPageSummary(pageSummary: BrowserPageSummary): BrowserPageSummary {
  if (pageSummary.linkSamples === undefined) return pageSummary;
  return {
    ...pageSummary,
    linkSamples: normalizeBrowserLinkSamples(pageSummary.linkSamples),
  };
}

/**
 * Produce a compact observation bundle for the current browser state.
 *
 * This is a thin adapter: it builds the provider input, delegates to
 * `provider.observe()`, and bounds untrusted link samples before returning.
 * Artifact persistence is handled upstream by the runtime, not here.
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

  const observation = await options.provider.observe(input);
  if (!observation.pageSummary) return observation;
  return {
    ...observation,
    pageSummary: normalizedPageSummary(observation.pageSummary),
  };
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
    payload.pageSummary = normalizedPageSummary(observation.pageSummary) as unknown as JsonObject;
  }
  if (observation.pageSketch) {
    payload.pageSketch = observation.pageSketch as unknown as JsonObject;
  }
  if (options.includeScreenshotArtifactId && observation.screenshotArtifactId) {
    payload.screenshotArtifactId = observation.screenshotArtifactId;
  }

  return payload;
}
