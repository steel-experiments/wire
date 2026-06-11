import { strict as assert } from "node:assert";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type { TraceEvent } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { saveTask } from "../storage/tasks.js";
import { saveRun } from "../storage/runs.js";
import { saveTraceEvent } from "../storage/events.js";
import { saveArtifact } from "../storage/artifacts.js";
import { main } from "./main.js";
import { likelyCommandTypo, parseArgs } from "./args.js";

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

test("likelyCommandTypo flags close single-word objectives and nothing else", () => {
  // A mistyped command must not silently become a task objective and launch a
  // paid browser session.
  assert.equal(likelyCommandTypo("lst"), "list");
  assert.equal(likelyCommandTypo("reviw"), "review");
  assert.equal(likelyCommandTypo("benhc"), "bench");
  assert.equal(likelyCommandTypo("aprove"), "approve");
  // Real objectives pass: sentences, URLs, and words not near any command.
  assert.equal(likelyCommandTypo("open example.com and report the heading"), undefined);
  assert.equal(likelyCommandTypo("https://example.com"), undefined);
  assert.equal(likelyCommandTypo("benchmark"), undefined);
  // Exact command names never reach the objective path; distance 0 is not a typo.
  assert.equal(likelyCommandTypo("list"), undefined);
});

test("main run refuses a likely command typo instead of starting a browser run", async () => {
  const previousExitCode = process.exitCode;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (value?: unknown) => {
    errors.push(String(value ?? ""));
  };

  try {
    await main(["node", "wire", "lst"]);
    assert.equal(process.exitCode, 1);
    assert.ok(
      errors.some((line) => line.includes("list")),
      `error should suggest the intended command; got: ${errors.join(" | ")}`,
    );
  } finally {
    console.error = originalError;
    process.exitCode = previousExitCode;
  }
});

test("main list --mode filters runs to tasks of that mode, not just tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  const previousExitCode = process.exitCode;
  process.env.WIRE_ROOT = root;

  const taskTask = {
    id: createId("task"),
    title: "Plain task",
    mode: "task" as const,
    objective: "Plain objective",
    constraints: [],
    successCriteria: ["done"],
    createdAt: nowIsoUtc(),
  };
  const investigateTask = {
    ...taskTask,
    id: createId("task"),
    title: "Investigate task",
    mode: "investigate" as const,
  };
  const taskRun = {
    id: createId("run"),
    taskId: taskTask.id,
    status: "succeeded" as const,
  };
  const investigateRun = {
    id: createId("run"),
    taskId: investigateTask.id,
    status: "succeeded" as const,
  };

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value ?? ""));
  };

  try {
    await saveTask(root, taskTask);
    await saveTask(root, investigateTask);
    await saveRun(root, taskRun);
    await saveRun(root, investigateRun);
    await main(["node", "wire", "list", "--mode", "investigate"]);
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  assert.ok(lines.some((line) => line.includes(investigateRun.id)));
  assert.ok(
    !lines.some((line) => line.includes(taskRun.id)),
    "runs of other-mode tasks must be filtered out with --mode",
  );
});

test("main list orders tasks and runs by time, oldest first", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  const previousExitCode = process.exitCode;
  process.env.WIRE_ROOT = root;

  const task = {
    id: createId("task"),
    title: "Order test task",
    mode: "task" as const,
    objective: "Order objective",
    constraints: [],
    successCriteria: ["done"],
    createdAt: nowIsoUtc(),
  };
  const newerRun = {
    id: createId("run"),
    taskId: task.id,
    status: "succeeded" as const,
    startedAt: "2026-06-10T12:00:00.000Z",
  };
  const olderRun = {
    id: createId("run"),
    taskId: task.id,
    status: "failed" as const,
    startedAt: "2026-06-01T12:00:00.000Z",
  };

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value ?? ""));
  };

  try {
    await saveTask(root, task);
    // Save the newer run first so file order disagrees with time order.
    await saveRun(root, newerRun);
    await saveRun(root, olderRun);
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

  const olderIndex = lines.findIndex((line) => line.includes(olderRun.id));
  const newerIndex = lines.findIndex((line) => line.includes(newerRun.id));
  assert.ok(olderIndex >= 0 && newerIndex >= 0);
  assert.ok(
    olderIndex < newerIndex,
    `older run must print before newer run; got older@${olderIndex}, newer@${newerIndex}`,
  );
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

test("main export writes scored trajectory JSONL", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const out = join(root, "exports", "traces.jsonl");
  const previousRoot = process.env.WIRE_ROOT;
  const previousExitCode = process.exitCode;
  process.env.WIRE_ROOT = root;

  const task = {
    id: createId("task"),
    title: "Export task",
    mode: "task" as const,
    objective: "Open example.com and save markdown",
    constraints: [],
    successCriteria: ["Saved markdown"],
    createdAt: nowIsoUtc(),
  };

  const run = {
    id: createId("run"),
    taskId: task.id,
    status: "succeeded" as const,
    startedAt: nowIsoUtc(),
    finishedAt: nowIsoUtc(),
    result: "Example markdown",
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
    await saveTraceEvent(root, {
      id: createId("event"),
      runId: run.id,
      ts: nowIsoUtc(),
      kind: "observation",
      payload: { url: "https://example.com", title: "Example Domain" },
    });
    await saveTraceEvent(root, {
      id: createId("event"),
      runId: run.id,
      ts: nowIsoUtc(),
      kind: "code-exec",
      payload: { code: "return document.title" },
    });
    await saveArtifact(root, {
      id: createId("artifact"),
      runId: run.id,
      kind: "markdown",
      path: "example.md",
      mimeType: "text/markdown",
      createdAt: nowIsoUtc(),
    });

    await main(["node", "wire", "export", "--run-id", run.id, "--format", "trajectory", "--out", out]);
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  const exported = await readFile(out, "utf-8");
  const row = JSON.parse(exported.trim()) as { run: { id: string; score: { total: number } } };
  assert.equal(row.run.id, run.id);
  assert.ok(row.run.score.total > 0);
  assert.ok(lines.some((line) => line.includes("Exported 1 trajectory rows")));
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

test("main with no args prints help instead of error", async () => {
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
    await main(["node", "wire"]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(errors.length, 0);
  assert.ok(lines.some((line) => line.includes("wire - zero-weight browser agent")));
  assert.ok(lines.some((line) => line.includes("Commands:")));
  assert.ok(lines.some((line) => line.includes("--objective")));
});

test("main prints version for -V and --version", async () => {
  const lines: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value?: unknown) => { lines.push(String(value ?? "")); };
  console.error = (value?: unknown) => { errors.push(String(value ?? "")); };

  try {
    await main(["node", "wire", "-V"]);
    await main(["node", "wire", "--version"]);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.deepEqual(errors, []);
  assert.deepEqual(lines, ["0.1.0", "0.1.0"]);
});

test("parseArgs parses --min-pass-rate and clamps it to 0..1", () => {
  assert.equal(parseArgs(["node", "wire", "bench", "--min-pass-rate", "0.7"]).minPassRate, 0.7);
  // Clamp out-of-range and ignore non-numeric.
  assert.equal(parseArgs(["node", "wire", "bench", "--min-pass-rate", "1.5"]).minPassRate, 1);
  assert.equal(parseArgs(["node", "wire", "bench", "--min-pass-rate", "-1"]).minPassRate, 0);
  assert.equal(parseArgs(["node", "wire", "bench", "--min-pass-rate", "abc"]).minPassRate, undefined);
  assert.equal(parseArgs(["node", "wire", "bench"]).minPassRate, undefined);
});

test("parseArgs parses --critical-points and --no-critical-points", () => {
  assert.equal(parseArgs(["node", "wire", "get title", "--critical-points"]).criticalPoints, true);
  assert.equal(parseArgs(["node", "wire", "get title", "--no-critical-points"]).criticalPoints, false);
  // Unset stays undefined so the runtime applies its mode-based default.
  assert.equal(parseArgs(["node", "wire", "get title"]).criticalPoints, undefined);
});

test("parseArgs treats positional arg as objective", () => {
  const args = parseArgs(["node", "wire", "get", "the", "title", "of", "steel.dev"]);

  assert.equal(args.command, "run");
  assert.equal(args.objective, "get the title of steel.dev");
});

test("parseArgs preserves quoted positional objective", () => {
  const args = parseArgs(["node", "wire", "get the title of steel.dev"]);

  assert.equal(args.command, "run");
  assert.equal(args.objective, "get the title of steel.dev");
});

test("parseArgs treats words after run command as objective", () => {
  const args = parseArgs(["node", "wire", "run", "get", "the", "title"]);

  assert.equal(args.command, "run");
  assert.equal(args.objective, "get the title");
});

test("parseArgs does not override --objective with positional", () => {
  const args = parseArgs(["node", "wire", "--objective", "explicit", "ignored", "words"]);

  assert.equal(args.objective, "explicit");
});

test("parseArgs parses browser session option flags", () => {
  const args = parseArgs([
    "node",
    "wire",
    "--use-proxy",
    "--solve-captcha",
    "--stealth",
    "--region",
    "us-east-1",
    "--user-agent",
    "Mozilla/5.0",
    "get",
    "title",
  ]);

  assert.equal(args.objective, "get title");
  assert.equal(args.useProxy, true);
  assert.equal(args.solveCaptcha, true);
  assert.equal(args.stealth, true);
  assert.equal(args.region, "us-east-1");
  assert.equal(args.userAgent, "Mozilla/5.0");
});

test("parseArgs positional is not confused by flags or commands", () => {
  const a = parseArgs(["node", "wire", "list"]);
  assert.equal(a.command, "list");
  assert.equal(a.objective, undefined);

  const b = parseArgs(["node", "wire", "--json"]);
  assert.equal(b.command, "run");
  assert.equal(b.objective, undefined);
});

test("parseArgs parses --json flag as true", () => {
  const args = parseArgs(["node", "wire", "review", "--run-id", "run_test123", "--json"]);

  assert.equal(args.json, true);
});

test("parseArgs parses --trace-llm flag", () => {
  const args = parseArgs(["node", "wire", "run", "--trace-llm", "inspect prompts"]);

  assert.equal(args.traceLlm, true);
  assert.equal(args.objective, "inspect prompts");
});

test("parseArgs parses version flags", () => {
  assert.equal(parseArgs(["node", "wire", "-V"]).version, true);
  assert.equal(parseArgs(["node", "wire", "--version"]).version, true);
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

test("parseArgs parses --critical-points as a run flag", () => {
  const args = parseArgs(["node", "wire", "--objective", "do a thing", "--critical-points"]);

  assert.equal(args.command, "run");
  assert.equal(args.criticalPoints, true);
  assert.equal(args.objective, "do a thing");
});

test("parseArgs parses craft command with run-id and out", () => {
  const args = parseArgs(["node", "wire", "craft", "--run-id", "run_abc", "--out", "script.js"]);

  assert.equal(args.command, "craft");
  assert.equal(args.runId, "run_abc");
  assert.equal(args.outFile, "script.js");
});

test("main craft crystallizes a run's exec steps into a script", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-cli-"));
  const previousRoot = process.env.WIRE_ROOT;
  const previousExitCode = process.exitCode;
  process.env.WIRE_ROOT = root;

  const task = {
    id: createId("task"),
    title: "Craft test",
    mode: "task" as const,
    objective: "Open example.com and read the heading",
    constraints: [],
    successCriteria: ["Heading returned"],
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
  // Real traces have monotonically increasing timestamps (the browser round
  // trip between an exec and its result guarantees result.ts > exec.ts), and
  // listTraceEvents orders by ts. Mirror that here so the exec→result pairing
  // is deterministic rather than scrambled by same-millisecond ties.
  let tick = 0;
  const traceEvent = (kind: "code-exec" | "code-result", payload: TraceEvent["payload"]): TraceEvent => ({
    id: createId("event"),
    runId: run.id,
    ts: new Date(Date.UTC(2026, 5, 1, 0, 0, tick++)).toISOString(),
    kind,
    payload,
  });

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value?: unknown) => {
    lines.push(String(value ?? ""));
  };

  try {
    await saveTask(root, task);
    await saveRun(root, run);
    await saveTraceEvent(root, traceEvent("code-exec", { code: 'window.location.href = "https://example.com";' }));
    await saveTraceEvent(root, traceEvent("code-result", { ok: true, durationMs: 1 }));
    await saveTraceEvent(root, traceEvent("code-exec", { code: "return document.querySelector('h1').innerText;" }));
    await saveTraceEvent(root, traceEvent("code-result", { ok: true, durationMs: 1, returnValue: "Example Domain" }));
    await main(["node", "wire", "craft", "--run-id", run.id]);
  } finally {
    console.log = originalLog;
    process.exitCode = previousExitCode;
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }

  const output = lines.join("\n");
  assert.match(output, /Open example\.com and read the heading/u);
  assert.match(output, /Step 1 \(navigate\)/u);
  assert.match(output, /Step 2 \(inspect\)/u);
  assert.match(output, /document\.querySelector\('h1'\)/u);
});

test("main rejects unknown run-id subcommand instead of running it as a task", async () => {
  const previousExitCode = process.exitCode;
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (value?: unknown) => {
    errors.push(String(value ?? ""));
  };

  try {
    process.exitCode = undefined;
    await main(["node", "wire", "--run-id", "run_test123", "reply"]);
  } finally {
    console.error = originalError;
    process.exitCode = previousExitCode;
  }

  assert.ok(errors.some((line) => /Unknown command after --run-id/u.test(line)));
});

// ---------------------------------------------------------------------------
// parseArgs — provider and base URL
// ---------------------------------------------------------------------------

test("parseArgs accepts zai as a provider", () => {
  const args = parseArgs(["node", "wire", "get title", "--provider", "zai"]);
  assert.equal(args.provider, "zai");
});

test("parseArgs parses --base-url", () => {
  const args = parseArgs(["node", "wire", "get title", "--base-url", "https://api.z.ai/api/anthropic/v1"]);
  assert.equal(args.baseUrl, "https://api.z.ai/api/anthropic/v1");
});
