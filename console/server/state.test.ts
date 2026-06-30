// ABOUTME: Tests for reading historical runs from the Wire state dir.

import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listHistoricalRuns } from "./state";

test("lists historical runs joined with their task objective", async () => {
  const root = mkdtempSync(join(tmpdir(), "wire-hist-"));
  await mkdir(join(root, "runs"), { recursive: true });
  await mkdir(join(root, "tasks"), { recursive: true });
  await writeFile(
    join(root, "tasks", "task_1.json"),
    JSON.stringify({ id: "task_1", objective: "do the thing", mode: "investigate" }),
  );
  await writeFile(
    join(root, "runs", "run_1.json"),
    JSON.stringify({
      id: "run_1",
      taskId: "task_1",
      status: "succeeded",
      startedAt: "2026-06-16T10:00:00.000Z",
      finishedAt: "2026-06-16T10:01:00.000Z",
      stepCount: 3,
      classification: { kind: "task-complete" },
      result: "answer",
    }),
  );
  process.env.WIRE_ROOT = root;

  const runs = await listHistoricalRuns();
  expect(runs).toHaveLength(1);
  expect(runs[0]!.objective).toBe("do the thing");
  expect(runs[0]!.mode).toBe("investigate");
  expect(runs[0]!.classification).toBe("task-complete");
  expect(runs[0]!.stepCount).toBe(3);
  expect(runs[0]!.result).toBe("answer");
});

test("returns empty when the state dir is absent", async () => {
  process.env.WIRE_ROOT = join(tmpdir(), `wire-absent-${process.pid}-${Date.now()}`);
  expect(await listHistoricalRuns()).toEqual([]);
});
