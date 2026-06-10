import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Artifact, Run, RunClassificationKind, Task, TraceEvent } from "../shared/types.js";
import { scoreRun } from "./scoring.js";

function task(objective = "Open example.com and save 2 findings as markdown"): Task {
  return {
    id: createId("task"),
    title: "Score task",
    mode: "task",
    objective,
    constraints: [],
    successCriteria: ["Save markdown artifact"],
    createdAt: nowIsoUtc(),
  };
}

function run(taskId: Task["id"], kind: RunClassificationKind = "task-complete"): Run {
  return {
    id: createId("run"),
    taskId,
    status: "succeeded",
    startedAt: nowIsoUtc(),
    finishedAt: nowIsoUtc(),
    result: "Example findings:\n- Example Domain\n- Documentation",
    classification: { kind, confidence: 1 },
  };
}

function event(kind: TraceEvent["kind"], payload: TraceEvent["payload"]): TraceEvent {
  return {
    id: createId("event"),
    runId: createId("run"),
    ts: nowIsoUtc(),
    kind,
    payload,
  };
}

test("scoreRun gives partial credit for missing artifacts", () => {
  const t = task();
  const r = run(t.id);
  const events = [
    event("observation", { url: "https://example.com", title: "Example Domain" }),
    event("code-exec", { code: "return document.title" }),
    event("code-result", { ok: true, stdout: "Example Domain", durationMs: 10 }),
  ];

  const score = scoreRun(t, r, events, [], { maxSteps: 10 });

  assert.equal(score.components.classification, 1);
  assert.ok(score.components.contract < 1);
  assert.ok(score.total > 0.5);
  assert.ok(score.notes.some((note) => note.includes("artifact")));
});

test("scoreRun rewards correct blocked auth evidence without treating it as zero", () => {
  const t = task("Open dashboard.example.com and detect whether login is required");
  const r = run(t.id, "blocked-auth");
  const events = [
    event("observation", { url: "https://dashboard.example.com/login", title: "Login" }),
    event("artifact", { kind: "screenshot", path: "screens/login.png", content: "login wall" }),
  ];
  const artifacts: Artifact[] = [{
    id: createId("artifact"),
    runId: r.id,
    kind: "screenshot",
    path: "screens/login.png",
    mimeType: "image/png",
    createdAt: nowIsoUtc(),
  }];

  const score = scoreRun(t, r, events, artifacts, { maxSteps: 8 });

  assert.ok(score.components.classification > 0.3);
  assert.ok(score.components.evidence > 0.4);
  assert.ok(score.total > 0.4);
});
