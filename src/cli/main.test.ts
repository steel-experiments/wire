import { strict as assert } from "node:assert";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import { saveTask } from "../storage/tasks.js";
import { saveRun } from "../storage/runs.js";
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
