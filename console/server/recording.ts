// ABOUTME: Fetches a Steel session's HLS recording playlist (needs the API key).
// ABOUTME: Segment URLs inside are public signed CDN URLs — the browser streams them directly.

import { runSessionId } from "./state";

export const STEEL_API = "https://api.steel.dev/v1";

/** Steel's HLS endpoint wants the raw UUID; Wire stores ids as `session_<uuid>`. */
export function hlsPlaylistUrl(sessionId: string): string {
  const uuid = sessionId.replace(/^session_/u, "");
  return `${STEEL_API}/sessions/${uuid}/hls`;
}

/** Fetch the HLS playlist text for a run's session, or null if unavailable.
 *  The Steel API key is required; without it (e.g. local dev without .env), returns null. */
export async function runRecordingPlaylist(
  runId: string,
  fetcher: (url: string, headers: Record<string, string>) => Promise<{ ok: boolean; text: () => Promise<string> }> = defaultFetcher,
): Promise<string | null> {
  const key = process.env.STEEL_API_KEY;
  if (!key) return null;
  const sessionId = await runSessionId(runId);
  if (!sessionId) return null;
  try {
    const res = await fetcher(hlsPlaylistUrl(sessionId), { "steel-api-key": key });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

async function defaultFetcher(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: boolean; text: () => Promise<string> }> {
  const res = await fetch(url, { headers });
  return { ok: res.ok, text: () => res.text() };
}
