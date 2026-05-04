import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { TraceEvent } from "../shared/types.js";
import { createArtifactRegistry } from "../storage/artifact-registry.js";
import { buildTimeline, filterByKind, summarizeTimeline } from "./replay.js";

// ---------------------------------------------------------------------------
// Artifact registry
// ---------------------------------------------------------------------------

test("ArtifactRegistry registers and retrieves artifacts", () => {
  const registry = createArtifactRegistry();
  const runId = createId("run");

  const artifact = registry.register(runId, "screenshot", "/tmp/shot.png", "image/png");

  assert.equal(artifact.kind, "screenshot");
  assert.equal(artifact.runId, runId);
  assert.equal(artifact.mimeType, "image/png");

  const retrieved = registry.get(artifact.id);
  assert.equal(retrieved?.id, artifact.id);
});

test("ArtifactRegistry lists artifacts by runId", () => {
  const registry = createArtifactRegistry();
  const run1 = createId("run");
  const run2 = createId("run");

  registry.register(run1, "screenshot", "/tmp/a.png");
  registry.register(run1, "html", "/tmp/a.html");
  registry.register(run2, "screenshot", "/tmp/b.png");

  assert.equal(registry.list(run1).length, 2);
  assert.equal(registry.list(run2).length, 1);
  assert.equal(registry.list().length, 3);
});

test("ArtifactRegistry returns undefined for missing id", () => {
  const registry = createArtifactRegistry();
  assert.equal(registry.get(createId("artifact")), undefined);
});

test("ArtifactRegistry register without mimeType", () => {
  const registry = createArtifactRegistry();
  const runId = createId("run");

  const artifact = registry.register(runId, "note", "/tmp/note.txt");
  assert.equal(artifact.mimeType, undefined);
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test("buildTimeline creates replay timeline from events", () => {
  const runId = createId("run");
  const events: TraceEvent[] = [
    makeEvent(runId, "observation", { url: "https://a.com", title: "A" }, "2026-01-01T00:00:00.000Z"),
    makeEvent(runId, "code-exec", { code: "1+1" }, "2026-01-01T00:00:01.000Z"),
    makeEvent(runId, "observation", { url: "https://b.com", title: "B" }, "2026-01-01T00:00:02.000Z"),
  ];

  const timeline = buildTimeline(events, runId);

  assert.equal(timeline.runId, runId);
  assert.equal(timeline.events.length, 3);
  assert.equal(timeline.events[0]?.kind, "observation");
  assert.ok(timeline.durationMs >= 0);
});

test("buildTimeline filters to specific runId", () => {
  const run1 = createId("run");
  const run2 = createId("run");
  const events: TraceEvent[] = [
    makeEvent(run1, "observation", { url: "https://a.com", title: "A" }, "2026-01-01T00:00:00.000Z"),
    makeEvent(run2, "code-exec", { code: "1+1" }, "2026-01-01T00:00:01.000Z"),
  ];

  const timeline = buildTimeline(events, run1);
  assert.equal(timeline.events.length, 1);
});

test("filterByKind returns events of specific type", () => {
  const runId = createId("run");
  const events: TraceEvent[] = [
    makeEvent(runId, "observation", { url: "https://a.com", title: "A" }, "2026-01-01T00:00:00.000Z"),
    makeEvent(runId, "code-exec", { code: "1+1" }, "2026-01-01T00:00:01.000Z"),
    makeEvent(runId, "observation", { url: "https://b.com", title: "B" }, "2026-01-01T00:00:02.000Z"),
  ];

  const filtered = filterByKind(events, "observation");
  assert.equal(filtered.length, 2);
});

test("summarizeTimeline produces readable summary", () => {
  const runId = createId("run");
  const events: TraceEvent[] = [
    makeEvent(runId, "observation", { url: "https://a.com", title: "A" }, "2026-01-01T00:00:00.000Z"),
    makeEvent(runId, "code-exec", { code: "1+1" }, "2026-01-01T00:00:01.000Z"),
  ];

  const timeline = buildTimeline(events, runId);
  const summary = summarizeTimeline(timeline);

  assert.ok(summary.includes("observation: 1"));
  assert.ok(summary.includes("code-exec: 1"));
  assert.ok(summary.includes("Events: 2"));
});

function makeEvent(
  runId: TraceEvent["runId"],
  kind: TraceEvent["kind"],
  payload: TraceEvent["payload"],
  ts = nowIsoUtc(),
): TraceEvent {
  return {
    id: createId("event"),
    runId,
    ts,
    kind,
    payload,
  };
}
