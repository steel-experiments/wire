// ABOUTME: Test fixture standing in for `wire run --stream-json`.
// ABOUTME: Emits canned NDJSON trace events and writes a run record to WIRE_ROOT.

import { join } from "node:path";

const runId = "run_fake_test";
const ts = "2026-06-16T00:00:00.000Z";

const events = [
  { id: "e0", runId, ts, kind: "session", payload: { sessionId: "session_fake", liveUrl: "https://app.steel.dev/sessions/fake", debugUrl: "https://api.steel.dev/v1/sessions/fake/player" } },
  { id: "e1", runId, ts, kind: "observation", payload: { url: "https://example.com", title: "Example Domain" } },
  { id: "e2", runId, ts, kind: "code-exec", payload: { code: "document.title" } },
  { id: "e3", runId, ts, kind: "code-result", payload: { ok: true, durationMs: 5, returnValue: "Example Domain" } },
  { id: "e4", runId, ts, kind: "thought-summary", payload: { kind: "finish", summary: "Returned the title" } },
];

for (const event of events) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

if (process.env.WIRE_ROOT) {
  await Bun.write(
    join(process.env.WIRE_ROOT, "runs", `${runId}.json`),
    JSON.stringify({
      id: runId,
      status: "complete",
      result: "Example Domain",
      outcomeSummary: "Returned the page title",
      classification: { kind: "task-complete" },
    }),
  );
}
