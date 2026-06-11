import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Artifact, Run, Task, TraceEvent } from "../shared/types.js";
import { formatArtifacts, formatReview, formatTimeline } from "./review.js";

test("formatArtifacts includes content hash, size, and preview when present", () => {
  const artifact: Artifact = {
    id: createId("artifact"),
    runId: createId("run"),
    kind: "markdown",
    path: "/tmp/report.md",
    mimeType: "text/markdown",
    createdAt: nowIsoUtc(),
    metadata: {
      contentHash: "a".repeat(64),
      contentSize: 42,
      contentPreview: "# Report\n\nFirst row",
    },
  };

  const output = formatArtifacts([artifact]);

  assert.match(output, /hash=aaaaaaaa/u);
  assert.match(output, /size=42/u);
  assert.match(output, /Preview: # Report First row/u);
});

function event(payload: TraceEvent["payload"]): TraceEvent {
  return {
    id: createId("event"),
    runId: createId("run"),
    ts: nowIsoUtc(),
    kind: "contract-check",
    payload,
  };
}

test("formatTimeline summarizes contract checks", () => {
  const output = formatTimeline([
    event({ phase: "created", summary: "visit: vercel.com · markdown table" }),
    event({ phase: "validated", passed: false, missing: ["Missing markdown table", "Final result contains placeholder text: see open"] }),
  ]);

  assert.match(output, /contract-check  visit: vercel\.com/u);
  assert.match(output, /contract-check  failed: Missing markdown table/u);
  assert.match(output, /see open/u);
});

test("formatTimeline summarizes artifact reviews", () => {
  const output = formatTimeline([
    {
      id: createId("event"),
      runId: createId("run"),
      ts: nowIsoUtc(),
      kind: "artifact-review",
      payload: {
        passed: false,
        problems: ["Enterprise price appears to be navigation text."],
        artifactCount: 1,
      },
    },
  ]);

  assert.match(output, /artifact-review  failed:/u);
  assert.match(output, /navigation text/u);
});

test("formatReview labels classification confidence as a rule prior, not a percentage", () => {
  // Classifier confidences are fixed constants per rule (e.g. task-complete is
  // always 0.7 or 0.85), not calibrated probabilities. Rendering them as
  // "Confidence: 85%" is fake precision; the honest label is the raw prior.
  const task: Task = {
    id: createId("task"),
    title: "Prior label task",
    mode: "task",
    objective: "Open example.com",
    constraints: [],
    successCriteria: ["Opened"],
    createdAt: nowIsoUtc(),
  };
  const run: Run = {
    id: createId("run"),
    taskId: task.id,
    status: "succeeded",
    classification: { kind: "task-complete", confidence: 0.85 },
  };

  const output = formatReview({ task, run, events: [], artifacts: [] });

  assert.match(output, /Rule prior:   0\.85/u);
  assert.doesNotMatch(output, /Confidence:/u);
});

test("formatReview includes score when task is available", () => {
  const task: Task = {
    id: createId("task"),
    title: "Review score task",
    mode: "task",
    objective: "Open example.com and save markdown",
    constraints: [],
    successCriteria: ["Saved markdown"],
    createdAt: nowIsoUtc(),
  };
  const run: Run = {
    id: createId("run"),
    taskId: task.id,
    status: "succeeded",
    result: "Example markdown",
    classification: { kind: "task-complete", confidence: 1 },
  };

  const output = formatReview({
    task,
    run,
    events: [
      {
        id: createId("event"),
        runId: run.id,
        ts: nowIsoUtc(),
        kind: "observation",
        payload: { url: "https://example.com", title: "Example Domain" },
      },
      {
        id: createId("event"),
        runId: run.id,
        ts: nowIsoUtc(),
        kind: "artifact",
        payload: { kind: "markdown", path: "example.md", content: "Example markdown" },
      },
    ],
    artifacts: [],
  });

  assert.match(output, /--- Score ---/u);
  assert.match(output, /Total:\s+\d+\.\d%/u);
  assert.match(output, /Classification\s+\d+%/u);
  assert.match(output, /Contract\s+\d+%/u);
});
