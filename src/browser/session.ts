import type { BrowserSession, CreateSessionInput, SessionId } from "../shared/types.js";
import type { BrowserProvider } from "./bridge.js";

export async function createBrowserSession(
  provider: BrowserProvider,
  input: CreateSessionInput = {},
): Promise<BrowserSession> {
  return provider.createSession(input);
}

export async function stopBrowserSession(
  provider: BrowserProvider,
  sessionId: SessionId,
): Promise<void> {
  return provider.stopSession(sessionId);
}

/** Build a display-safe live URL by stripping query parameters with secrets. */
export function displaySafeUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    for (const key of [...parsed.searchParams.keys()]) {
      if (/(api[-_]?key|token|secret|password|auth|bearer)/iu.test(key)) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
