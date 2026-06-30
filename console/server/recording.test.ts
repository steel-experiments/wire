// ABOUTME: Tests for the Steel HLS recording URL + playlist resolution.

import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hlsPlaylistUrl, runRecordingPlaylist } from "./recording";

async function seedRun(root: string, runId: string, sessionId?: string): Promise<void> {
  await mkdir(join(root, "runs"), { recursive: true });
  const rec: Record<string, unknown> = { id: runId };
  if (sessionId) rec.sessionId = sessionId;
  await writeFile(join(root, "runs", `${runId}.json`), JSON.stringify(rec));
}

test("hlsPlaylistUrl strips the session_ prefix for the raw UUID Steel wants", () => {
  expect(hlsPlaylistUrl("session_3b6b2a74-e009-475d-8824-6cfeffdf063c")).toBe(
    "https://api.steel.dev/v1/sessions/3b6b2a74-e009-475d-8824-6cfeffdf063c/hls",
  );
  expect(hlsPlaylistUrl("aaaaaaaa-0000-0000-0000-000000000000")).toBe(
    "https://api.steel.dev/v1/sessions/aaaaaaaa-0000-0000-0000-000000000000/hls",
  );
});

test("runRecordingPlaylist returns the playlist text when Steel responds ok", async () => {
  const root = mkdtempSync(join(tmpdir(), "wire-rec-"));
  process.env.WIRE_ROOT = root;
  process.env.STEEL_API_KEY = "test-key";
  await seedRun(root, "run_1", "session_abc");

  const fetched: string[] = [];
  const fetcher = async (url: string, headers: Record<string, string>) => {
    fetched.push(url);
    expect(headers["steel-api-key"]).toBe("test-key");
    return { ok: true, text: async () => "#EXTM3U\n#EXTINF:4,\nhttps://cdn/seg.m4s\n" };
  };

  const playlist = await runRecordingPlaylist("run_1", fetcher);
  expect(playlist).toBe("#EXTM3U\n#EXTINF:4,\nhttps://cdn/seg.m4s\n");
  expect(fetched[0]!).toBe("https://api.steel.dev/v1/sessions/abc/hls");
});

test("runRecordingPlaylist returns null when Steel 404s", async () => {
  const root = mkdtempSync(join(tmpdir(), "wire-rec2-"));
  process.env.WIRE_ROOT = root;
  process.env.STEEL_API_KEY = "test-key";
  await seedRun(root, "run_2", "session_xyz");
  const fetcher = async () => ({ ok: false, text: async () => "not found" });
  expect(await runRecordingPlaylist("run_2", fetcher)).toBeNull();
});

test("runRecordingPlaylist returns null without an API key", async () => {
  delete process.env.STEEL_API_KEY;
  expect(await runRecordingPlaylist("run_1", async () => ({ ok: true, text: async () => "x" }))).toBeNull();
});
