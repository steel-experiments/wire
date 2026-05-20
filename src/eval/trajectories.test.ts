import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Artifact, Run, Task, TraceEvent } from "../shared/types.js";
import {
  exportRows,
  toPreferencePair,
  toRewardExamples,
  toSftExamples,
  toTraceTrajectory,
} from "./trajectories.js";

function makeTask(): Task {
  return {
    id: createId("task"),
    title: "Trajectory task",
    mode: "task",
    objective: "Open example.com with token_sk-123456789012345678901234 hidden and extract title",
    constraints: [],
    successCriteria: ["Extract title"],
    createdAt: nowIsoUtc(),
  };
}

function makeRun(taskId: Task["id"], id = createId("run"), result = "Example Domain"): Run {
  return {
    id,
    taskId,
    status: "succeeded",
    result,
    classification: { kind: "task-complete", confidence: 1 },
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

test("toTraceTrajectory redacts secrets and derives SFT/reward rows", () => {
  const task = makeTask();
  const run = makeRun(task.id);
  const events = [
    event("observation", { url: "https://example.com?apiKey=secret1234567890123456", title: "Example Domain" }),
    event("code-exec", { code: "return document.title // bearer abc.def" }),
    event("code-result", { ok: true, stdout: "Example Domain", durationMs: 4 }),
  ];
  const artifacts: Artifact[] = [];

  const trajectory = toTraceTrajectory(task, run, events, artifacts);
  const serialized = JSON.stringify(trajectory);

  assert.ok(!serialized.includes("secret1234567890123456"));
  assert.ok(serialized.includes("[REDACTED]"));
  assert.equal(toSftExamples(trajectory).length, 1);
  assert.equal(toRewardExamples(trajectory).length, 1);
});

test("exportRows creates preference pairs across same-task runs", () => {
  const task = makeTask();
  const good = toTraceTrajectory(task, makeRun(task.id, createId("run"), "Example title"), [
    event("observation", { url: "https://example.com", title: "Example Domain" }),
    event("code-exec", { code: "return document.title" }),
    event("code-result", { ok: true, stdout: "Example Domain", durationMs: 4 }),
  ], [{
    id: createId("artifact"),
    runId: createId("run"),
    kind: "markdown",
    path: "title.md",
    createdAt: nowIsoUtc(),
  }]);
  const badRun = makeRun(task.id, createId("run"), "Could not finish");
  badRun.classification = { kind: "ambiguous", confidence: 0.2 };
  const bad = toTraceTrajectory(task, badRun, [
    event("error", { message: "timeout" }),
  ], []);

  const pair = toPreferencePair(good, bad, 0.1);
  assert.ok(pair);
  const rows = exportRows([good, bad], "preferences", { minPreferenceDelta: 0.1 });
  assert.equal(rows.length, 1);
});
