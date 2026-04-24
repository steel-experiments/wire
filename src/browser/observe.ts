import type { BrowserObservation, SessionId } from "../shared/types.js";

import type { BrowserProvider, BrowserObserveInput } from "./bridge.js";

// ---------------------------------------------------------------------------
// Browser observation adapter
// ---------------------------------------------------------------------------

export interface ObserveOptions {
  provider: BrowserProvider;
  sessionId: SessionId;
  targetId?: string;
  artifactDir?: string;
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

  return options.provider.observe(input);
}
