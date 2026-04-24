import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import { saveTask } from "../storage/tasks.js";
import { saveRun } from "../storage/runs.js";
import { saveTraceEvent } from "../storage/events.js";
import { main } from "./main.js";

test("main list prints stored tasks and runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  process.env.WIRE_ROOT = root;

  const task = {
    id: createId("task"),
    title: "List test task",
    mode: "task" as const,
    objective: "List test objective",
    constraints: [],
    successCriteria: ["done"],
    createdAt: nowIsoUtc(),
  };

  const run = {
    id: createId("run"),
    taskId: task.id,
    status: "succeeded" as const,
    startedAt: nowIsoUtc(),
    finishedAt: nowIsoUtc(),
    outcomeSummary: "ok",
    classification: { kind: "task-complete" as const, confidence: 1 },
  };

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value ?? ""));
  };

  try {
    await saveTask(root, task);
    await saveRun(root, run);
    await main(["node", "wire", "list"]);
  } finally {
    console.log = originalLog;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  assert.ok(lines.some((line) => line.includes(task.id)));
  assert.ok(lines.some((line) => line.includes(run.id)));
});

test("main result prints recorded run result", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  process.env.WIRE_ROOT = root;

  const run = {
    id: createId("run"),
    taskId: createId("task"),
    status: "succeeded" as const,
    startedAt: nowIsoUtc(),
    finishedAt: nowIsoUtc(),
    result: "Steel pricing starts at $29/month",
    outcomeSummary: "ok",
    classification: { kind: "task-complete" as const, confidence: 1 },
  };

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value ?? ""));
  };

  try {
    await saveRun(root, run);
    await main(["node", "wire", "result", "--run-id", run.id]);
  } finally {
    console.log = originalLog;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  assert.deepEqual(lines, ["Steel pricing starts at $29/month"]);
});

test("main result falls back to legacy trace events when run.result is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  process.env.WIRE_ROOT = root;

  const run = {
    id: createId("run"),
    taskId: createId("task"),
    status: "succeeded" as const,
    startedAt: nowIsoUtc(),
    finishedAt: nowIsoUtc(),
    outcomeSummary: "ok",
    classification: { kind: "task-complete" as const, confidence: 1 },
  };

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value ?? ""));
  };

  try {
    await saveRun(root, run);
    await saveTraceEvent(root, {
      id: createId("event"),
      runId: run.id,
      ts: nowIsoUtc(),
      kind: "code-result",
      payload: { ok: true, stdout: "Recovered legacy result" },
    });
    await main(["node", "wire", "result", "--run-id", run.id]);
  } finally {
    console.log = originalLog;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  assert.deepEqual(lines, ["Recovered legacy result"]);
});

test("main result falls back to legacy finish summary when no extracted payload exists", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  process.env.WIRE_ROOT = root;

  const run = {
    id: createId("run"),
    taskId: createId("task"),
    status: "succeeded" as const,
    startedAt: nowIsoUtc(),
    finishedAt: nowIsoUtc(),
    outcomeSummary: "ok",
    classification: { kind: "task-complete" as const, confidence: 1 },
  };

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value ?? ""));
  };

  try {
    await saveRun(root, run);
    await saveTraceEvent(root, {
      id: createId("event"),
      runId: run.id,
      ts: nowIsoUtc(),
      kind: "thought-summary",
      payload: { summary: "Completed search for San Francisco and New York", kind: "finish" },
    });
    await main(["node", "wire", "result", "--run-id", run.id]);
  } finally {
    console.log = originalLog;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  assert.deepEqual(lines, ["Completed search for San Francisco and New York"]);
});
