import type { BrowserSession, CreateSessionInput, SessionId } from "../shared/types.js";
import type { BrowserProvider } from "./bridge.js";

// ---------------------------------------------------------------------------
// Session lifecycle helpers
// ---------------------------------------------------------------------------

export async function createBrowserSession(
  provider: BrowserProvider,
  input: CreateSessionInput = {},
): Promise<BrowserSession> {
  return provider.createSession(input);
}

export async function getBrowserSession(
  provider: BrowserProvider,
  sessionId: SessionId,
): Promise<BrowserSession> {
  return provider.getSession(sessionId);
}

export async function stopBrowserSession(
  provider: BrowserProvider,
  sessionId: SessionId,
): Promise<void> {
  return provider.stopSession(sessionId);
}

// ---------------------------------------------------------------------------
// Session URL helpers
// ---------------------------------------------------------------------------

/** Build a display-safe live URL by stripping query parameters with secrets. */
export function displaySafeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("apiKey");
    return parsed.toString();
  } catch {
    return url;
  }
}
