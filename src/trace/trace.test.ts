import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { ArtifactKind, ComparisonSpec, Run, TraceEvent } from "../shared/types.js";

import {
  artifactEvent,
  checkMinimumTraceCoverage,
  codeExecEvent,
  codeResultEvent,
  errorEvent,
  observationEvent,
  policyCheckEvent,
  skillLoadEvent,
  thoughtSummaryEvent,
} from "./events.js";
import { createArtifactRegistry } from "../storage/artifact-registry.js";
import { compareRuns } from "./compare.js";
import { buildTimeline, filterByKind, summarizeTimeline } from "./replay.js";

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

test("thoughtSummaryEvent creates a thought-summary trace event", () => {
  const runId = createId("run");
  const event = thoughtSummaryEvent(runId, "Planning next step");

  assert.equal(event.kind, "thought-summary");
  assert.equal(event.runId, runId);
  assert.equal(event.payload.summary, "Planning next step");
});

test("observationEvent creates observation with URL and title", () => {
  const runId = createId("run");
  const event = observationEvent(runId, "https://example.com", "Example");

  assert.equal(event.kind, "observation");
  assert.equal(event.payload.url, "https://example.com");
  assert.equal(event.payload.title, "Example");
});

test("observationEvent includes artifact IDs when provided", () => {
  const runId = createId("run");
  const aId = createId("artifact");
  const event = observationEvent(runId, "https://example.com", "Page", [aId]);

  assert.deepEqual(event.payload.artifactIds, [aId]);
});

test("codeExecEvent captures code and language", () => {
  const runId = createId("run");
  const event = codeExecEvent(runId, "return document.title;");

  assert.equal(event.kind, "code-exec");
  assert.equal(event.payload.code, "return document.title;");
  assert.equal(event.payload.language, "typescript");
});

test("codeResultEvent captures success and output", () => {
  const runId = createId("run");
  const event = codeResultEvent(runId, true, "Invoice page", undefined, 250);

  assert.equal(event.kind, "code-result");
  assert.equal(event.payload.ok, true);
  assert.equal(event.payload.stdout, "Invoice page");
  assert.equal(event.payload.durationMs, 250);
});

test("errorEvent captures message and optional code", () => {
  const runId = createId("run");
  const event = errorEvent(runId, "Network timeout", "ETIMEDOUT");

  assert.equal(event.kind, "error");
  assert.equal(event.payload.message, "Network timeout");
  assert.equal(event.payload.code, "ETIMEDOUT");
});

test("skillLoadEvent captures skill metadata", () => {
  const runId = createId("run");
  const skillId = createId("skill");
  const event = skillLoadEvent(runId, skillId, "domain", "hostname match");

  assert.equal(event.kind, "skill-load");
  assert.equal(event.payload.skillId, skillId);
  assert.equal(event.payload.scope, "domain");
  assert.equal(event.payload.matchReason, "hostname match");
});

test("policyCheckEvent captures action and result", () => {
  const runId = createId("run");
  const event = policyCheckEvent(runId, "submit-form", "require-approval", "Form submission");

  assert.equal(event.kind, "policy-check");
  assert.equal(event.payload.actionKind, "submit-form");
  assert.equal(event.payload.result, "require-approval");
  assert.equal(event.payload.reason, "Form submission");
});

// ---------------------------------------------------------------------------
// Minimum trace coverage
// ---------------------------------------------------------------------------

test("checkMinimumTraceCoverage passes with required events", () => {
  const runId = createId("run");
  const events: TraceEvent[] = [
    codeExecEvent(runId, "1+1"),
    observationEvent(runId, "https://example.com", "Example"),
    policyCheckEvent(runId, "observe", "allow"),
  ];

  const result = checkMinimumTraceCoverage(events, runId);
  assert.equal(result.valid, true);
  assert.deepEqual(result.missing, []);
});

test("checkMinimumTraceCoverage reports missing event kinds", () => {
  const runId = createId("run");
  const events: TraceEvent[] = [
    thoughtSummaryEvent(runId, "No code or policy"),
  ];

  const result = checkMinimumTraceCoverage(events, runId);
  assert.equal(result.valid, false);
  assert.ok(result.missing.includes("code-exec"));
  assert.ok(result.missing.includes("observation"));
  assert.ok(result.missing.includes("policy-check"));
});

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
// Compare
// ---------------------------------------------------------------------------

test("compareRuns produces comparison between two runs", () => {
  const runId1 = createId("run");
  const runId2 = createId("run");

  const spec: ComparisonSpec = {
    id: createId("comparison"),
    lhsRunId: runId1,
    rhsRunId: runId2,
    dimensions: ["latency", "outcome"],
  };

  const run1: Run = {
    id: runId1,
    taskId: createId("task"),
    status: "succeeded",
    classification: { kind: "task-complete", confidence: 0.9 },
  };

  const run2: Run = {
    id: runId2,
    taskId: createId("task"),
    status: "failed",
    classification: { kind: "site-error", confidence: 0.8 },
  };

  const events1 = [codeExecEvent(runId1, "1")];
  const events2 = [codeExecEvent(runId2, "2"), codeExecEvent(runId2, "3")];

  const comparison = compareRuns(
    spec,
    run1, run2,
    events1, events2,
    [], [],
  );

  assert.equal(comparison.lhs.status, "succeeded");
  assert.equal(comparison.rhs.status, "failed");
  assert.equal(comparison.lhs.stepCount, 1);
  assert.equal(comparison.rhs.stepCount, 2);
  assert.deepEqual(comparison.dimensions, ["latency", "outcome"]);
});

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

test("buildTimeline creates replay timeline from events", () => {
  const runId = createId("run");
  const events: TraceEvent[] = [
    observationEvent(runId, "https://a.com", "A"),
    codeExecEvent(runId, "1+1"),
    observationEvent(runId, "https://b.com", "B"),
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
    observationEvent(run1, "https://a.com", "A"),
    codeExecEvent(run2, "1+1"),
  ];

  const timeline = buildTimeline(events, run1);
  assert.equal(timeline.events.length, 1);
});

test("filterByKind returns events of specific type", () => {
  const runId = createId("run");
  const events: TraceEvent[] = [
    observationEvent(runId, "https://a.com", "A"),
    codeExecEvent(runId, "1+1"),
    observationEvent(runId, "https://b.com", "B"),
  ];

  const filtered = filterByKind(events, "observation");
  assert.equal(filtered.length, 2);
});

test("summarizeTimeline produces readable summary", () => {
  const runId = createId("run");
  const events: TraceEvent[] = [
    observationEvent(runId, "https://a.com", "A"),
    codeExecEvent(runId, "1+1"),
  ];

  const timeline = buildTimeline(events, runId);
  const summary = summarizeTimeline(timeline);

  assert.ok(summary.includes("observation: 1"));
  assert.ok(summary.includes("code-exec: 1"));
  assert.ok(summary.includes("Events: 2"));
});
