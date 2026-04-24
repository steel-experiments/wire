import type { JsonObject, SessionId } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Raw CDP escape hatch
// ---------------------------------------------------------------------------

export interface RawOptions {
  provider: { raw?(input: { sessionId: SessionId; method: string; params?: JsonObject }): Promise<unknown> };
  sessionId: SessionId;
  method: string;
  params?: JsonObject;
}

/**
 * Send a raw CDP command to the browser session.
 *
 * This is the escape hatch for when the standard bridge affordances
 * (observe, exec) are insufficient. Throws if the provider does not
 * support raw access.
 */
export async function execRaw(options: RawOptions): Promise<unknown> {
  if (!options.provider.raw) {
    throw new Error("Provider does not support raw CDP access");
  }

  const input: { sessionId: SessionId; method: string; params?: JsonObject } = {
    sessionId: options.sessionId,
    method: options.method,
  };

  if (options.params) {
    input.params = options.params;
  }

  return options.provider.raw(input);
}
