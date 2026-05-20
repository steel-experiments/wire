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
  type TraceTrajectory,
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

test("format converters preserve fixture output shapes", () => {
  const score = {
    total: 0.92,
    components: {
      classification: 1,
      contract: 1,
      evidence: 0.85,
      efficiency: 0.9,
      policy: 1,
    },
    notes: [],
    contract: {
      passed: true,
      missing: [],
      satisfied: ["Visited example.com"],
      totalChecks: 1,
    },
  };
  const trajectory: TraceTrajectory = {
    version: 1,
    task: {
      id: "task_export" as Task["id"],
      mode: "task",
      objective: "Open example.com and extract title",
      constraints: ["Use the active tab"],
      successCriteria: ["Return the page title"],
    },
    run: {
      id: "run_good" as Run["id"],
      status: "succeeded",
      classification: "task-complete",
      score,
    },
    trajectory: [
      {
        kind: "observation",
        ts: "2026-05-20T10:00:00.000Z",
        payload: { url: "https://example.com", title: "Example Domain" },
      },
      {
        kind: "code-exec",
        ts: "2026-05-20T10:00:01.000Z",
        payload: { code: "return document.title;" },
      },
      {
        kind: "code-result",
        ts: "2026-05-20T10:00:02.000Z",
        payload: { ok: true, stdout: "Example Domain", durationMs: 4 },
      },
    ],
    artifacts: [],
  };
  const prompt = [
    "Objective: Open example.com and extract title",
    "Constraints: Use the active tab",
    "Success criteria: Return the page title",
    "Recent trace:",
    "observation: https://example.com title=Example Domain",
  ].join("\n");

  assert.deepEqual(toSftExamples(trajectory), [{
    messages: [
      {
        role: "system",
        content: "You are Wire, a zero-weight browser agent. Act through concise, inspectable browser code. Preserve evidence and respect explicit policy boundaries.",
      },
      { role: "user", content: prompt },
      { role: "assistant", content: "return document.title;" },
    ],
    metadata: {
      taskId: "task_export",
      runId: "run_good",
      score: 0.92,
      classification: "task-complete",
      eventIndex: 1,
    },
  }]);

  assert.deepEqual(toRewardExamples(trajectory), [{
    prompt,
    completion: "return document.title;",
    reward: 0.92,
    components: score.components,
    metadata: {
      taskId: "task_export",
      runId: "run_good",
      classification: "task-complete",
      eventIndex: 1,
    },
  }]);

  const rejected: TraceTrajectory = {
    ...trajectory,
    run: {
      ...trajectory.run,
      id: "run_bad" as Run["id"],
      classification: "ambiguous",
      score: { ...score, total: 0.3 },
    },
    trajectory: [
      {
        kind: "thought-summary",
        ts: "2026-05-20T10:00:01.000Z",
        payload: { text: "Could not finish" },
      },
    ],
  };

  assert.deepEqual(toPreferencePair(trajectory, rejected, 0.2), {
    prompt: [
      "Objective: Open example.com and extract title",
      "Constraints: Use the active tab",
      "Success criteria: Return the page title",
    ].join("\n"),
    chosen: "return document.title;",
    rejected: "{\"text\":\"Could not finish\"}",
    chosenScore: 0.92,
    rejectedScore: 0.3,
    metadata: {
      taskId: "task_export",
      chosenRunId: "run_good",
      rejectedRunId: "run_bad",
    },
  });
});
