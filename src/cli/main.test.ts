import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import { saveTask } from "../storage/tasks.js";
import { saveRun } from "../storage/runs.js";
import { saveTraceEvent } from "../storage/events.js";
import { main } from "./main.js";
import { parseArgs } from "./args.js";

test("main list prints stored tasks and runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  const previousExitCode = process.exitCode;
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
    process.exitCode = previousExitCode;
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
  const previousExitCode = process.exitCode;
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
    await saveTask(root, {
      id: run.taskId,
      title: "Pricing task",
      mode: "task",
      objective: "Find pricing",
      constraints: [],
      successCriteria: ["Extract pricing"],
      createdAt: nowIsoUtc(),
    });
    await saveRun(root, run);
    await main(["node", "wire", "result", "--run-id", run.id]);
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
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
  const previousExitCode = process.exitCode;
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
    await saveTask(root, {
      id: run.taskId,
      title: "Legacy task",
      mode: "task",
      objective: "Find pricing",
      constraints: [],
      successCriteria: ["Extract pricing"],
      createdAt: nowIsoUtc(),
    });
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
    process.exitCode = previousExitCode;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  assert.deepEqual(lines, ["Recovered legacy result"]);
});

test("main result falls back to finish summary when task output is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  const previousExitCode = process.exitCode;
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
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value?: unknown) => {
    lines.push(String(value ?? ""));
  };
  console.error = (value?: unknown) => {
    errors.push(String(value ?? ""));
  };

  try {
    await saveTask(root, {
      id: run.taskId,
      title: "Search task",
      mode: "task",
      objective: "Search Booking.com",
      constraints: [],
      successCriteria: ["Extract hotel options"],
      createdAt: nowIsoUtc(),
    });
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
    console.error = originalError;
    process.exitCode = previousExitCode;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  assert.deepEqual(lines, ["Completed search for San Francisco and New York"]);
  assert.deepEqual(errors, []);
});

test("main result falls back to persisted note artifacts for task runs", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  const previousExitCode = process.exitCode;
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
    await saveTask(root, {
      id: run.taskId,
      title: "Search task",
      mode: "task",
      objective: "Search Booking.com",
      constraints: [],
      successCriteria: ["Complete search"],
      createdAt: nowIsoUtc(),
    });
    await saveRun(root, run);
    await saveTraceEvent(root, {
      id: createId("event"),
      runId: run.id,
      ts: nowIsoUtc(),
      kind: "artifact",
      payload: {
        artifactId: createId("artifact"),
        kind: "note",
        path: "artifacts/example.txt",
        content: "Completed search for San Francisco May 15-17 and New York May 20-22",
      },
    });
    await main(["node", "wire", "result", "--run-id", run.id]);
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  assert.deepEqual(lines, ["Completed search for San Francisco May 15-17 and New York May 20-22"]);
});

test("main run reports invalid task-file JSON as structured JSON failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  const previousExitCode = process.exitCode;
  process.env.WIRE_ROOT = root;

  const taskFile = join(root, "bad-task.json");
  await writeFile(taskFile, "{invalid", "utf-8");

  const lines: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value?: unknown) => {
    lines.push(String(value ?? ""));
  };
  console.error = (value?: unknown) => {
    errors.push(String(value ?? ""));
  };

  try {
    await main(["node", "wire", "run", "--task-file", taskFile, "--json"]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = previousExitCode;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  assert.equal(errors.length, 0);
  assert.equal(lines.length, 1);
  const output = JSON.parse(lines[0]!) as {
    status: string;
    error?: { error_class?: string; error_code?: string };
  };
  assert.equal(output.status, "failed");
  assert.equal(output.error?.error_class, "input");
  assert.equal(output.error?.error_code, "INVALID_TASK_FILE");
});

// ---------------------------------------------------------------------------
// parseArgs — --json flag
// ---------------------------------------------------------------------------

test("parseArgs parses --json flag as true", () => {
  const args = parseArgs(["node", "wire", "review", "--run-id", "run_test123", "--json"]);

  assert.equal(args.json, true);
});

test("parseArgs defaults json to undefined when --json is absent", () => {
  const args = parseArgs(["node", "wire", "list"]);

  assert.equal(args.json, undefined);
});

test("parseArgs parses --json flag for result command", () => {
  const args = parseArgs(["node", "wire", "result", "--run-id", "run_test123", "--json"]);

  assert.equal(args.json, true);
  assert.equal(args.command, "result");
  assert.equal(args.runId, "run_test123");
});
