import { parseArgs, formatHelp, type CliArgs } from "./args.js";
import { approveRun, runTask, type RunOptions } from "./runner.js";
import { loadConfig, resolveLlmConfig } from "./config.js";
import { formatReview } from "../ui/review.js";
import { loadRun, listRuns } from "../storage/runs.js";
import { listArtifacts } from "../storage/artifacts.js";
import { loadTask, listTasks } from "../storage/tasks.js";
import { listTraceEvents } from "../storage/events.js";
import { deriveRunResult } from "../agent/loop.js";
import { bench as runBench, formatBenchReport } from "../eval/bench.js";

function defaultStorageRoot(): string {
  return process.env["WIRE_ROOT"] ?? ".wire";
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(formatHelp());
    return;
  }

  switch (args.command) {
    case "run": {
      await handleRun(args);
      break;
    }
    case "review": {
      await handleReview(args);
      break;
    }
    case "result": {
      await handleResult(args);
      break;
    }
    case "list": {
      await handleList(args);
      break;
    }
    case "approve": {
      await handleApprove(args);
      break;
    }
    case "bench": {
      await handleBench(args);
      break;
    }
    default: {
      console.error(`Unknown command: ${args.command}`);
      console.log(formatHelp());
      process.exitCode = 1;
    }
  }
}

async function handleRun(
  args: CliArgs,
): Promise<void> {
  if (!args.objective && !args.taskFile) {
    console.error("Error: --objective or --task-file is required for 'run'.");
    process.exitCode = 1;
    return;
  }

  let objective = args.objective ?? "";

  if (args.taskFile) {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(args.taskFile, "utf-8");
    const parsed = JSON.parse(raw) as { objective?: string };
    if (typeof parsed.objective === "string" && parsed.objective.length > 0) {
      objective = parsed.objective;
    }
  }

  if (!objective) {
    console.error("Error: no objective provided.");
    process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  const llm = resolveLlmConfig(
    args.provider,
    args.model,
    process.env.WIRE_PROVIDER === "openai" || process.env.WIRE_PROVIDER === "anthropic"
      ? process.env.WIRE_PROVIDER
      : undefined,
    process.env.WIRE_MODEL,
    config,
  );

  const opts: RunOptions = { objective };
  if (args.mode) opts.mode = args.mode;
  if (args.profileId) opts.profileId = args.profileId;
  if (llm.provider) opts.provider = llm.provider;
  if (llm.model) opts.model = llm.model;
  if (args.maxSteps) opts.maxSteps = args.maxSteps;
  if (args.skillDir) opts.skillDir = args.skillDir;
  if (args.json) opts.json = args.json;

  await runTask(opts);
}

async function handleReview(
  args: CliArgs,
): Promise<void> {
  const root = defaultStorageRoot();

  if (args.taskId) {
    const runs = await listRuns(root, args.taskId as `task_${string}`);
    if (runs.length === 0) {
      console.error(`No runs found for task ${args.taskId}.`);
      process.exitCode = 1;
      return;
    }
    for (const run of runs) {
      const artifacts = await listArtifacts(root, run.id);
      const events = await listTraceEvents(root, run.id);
      console.log(formatReview({ run, events, artifacts }));
      console.log("");
    }
    return;
  }

  if (!args.runId) {
    console.error("Error: --run-id or --task-id is required for 'review'.");
    process.exitCode = 1;
    return;
  }

  if (args.runId.startsWith("task_")) {
    console.error(`Error: "${args.runId}" is a task ID, not a run ID.`);
    console.error(`Use --task-id ${args.runId} to review all runs for that task.`);
    console.error(`Or use --run-id with a run ID (starts with "run_").`);
    process.exitCode = 1;
    return;
  }

  const runId = args.runId as `run_${string}`;

  const run = await loadRun(root, runId);
  const artifacts = await listArtifacts(root, runId);
  const events = await listTraceEvents(root, runId);

  if (args.json) {
    console.log(JSON.stringify({ run, events, artifacts }));
  } else {
    console.log(formatReview({ run, events, artifacts }));
  }
}

async function handleList(
  args: CliArgs,
): Promise<void> {
  const root = defaultStorageRoot();
  const tasks = await listTasks(root);
  const filteredTasks = args.mode ? tasks.filter((t) => t.mode === args.mode) : tasks;
  const runs = await listRuns(root);

  if (args.json) {
    console.log(JSON.stringify({ tasks: filteredTasks, runs }));
    return;
  }

  console.log("=== Tasks ===");
  if (filteredTasks.length === 0) {
    console.log("  (no tasks)");
  } else {
    for (const task of filteredTasks) {
      console.log(`  ${task.id}  [${task.mode}]  ${task.title}`);
    }
  }

  console.log("");
  console.log("=== Runs ===");
  if (runs.length === 0) {
    console.log("  (no runs)");
  } else {
    for (const run of runs) {
      const cls = run.classification
        ? ` (${run.classification.kind})`
        : "";
      console.log(`  ${run.id}  [${run.status}]${cls}  task: ${run.taskId}`);
    }
  }
}

async function handleResult(
  args: CliArgs,
): Promise<void> {
  const root = defaultStorageRoot();

  if (!args.runId) {
    console.error("Error: --run-id is required for 'result'.");
    process.exitCode = 1;
    return;
  }

  const runId = args.runId as `run_${string}`;
  const run = await loadRun(root, runId);
  const task = await loadTask(root, run.taskId);
  const events = await listTraceEvents(root, runId);
  const finishSummary = task.mode === "task" ? deriveRunResult(events, "investigate") : undefined;
  const result = run.result ??
    deriveRunResult(events, task.mode) ??
    finishSummary;

  if (!result) {
    console.error(`No final result recorded for ${runId}.`);
    if (task.mode === "task" && finishSummary) {
      console.error(`Last finish summary: ${finishSummary}`);
    }
    process.exitCode = 1;
    return;
  }

  if (args.json) {
    console.log(JSON.stringify({
      runId,
      result,
      classification: run.classification?.kind ?? "unknown",
      status: run.status,
    }));
  } else {
    console.log(result);
  }
}

async function handleApprove(
  args: CliArgs,
): Promise<void> {
  if (!args.runId) {
    console.error("Error: --run-id is required for 'approve'.");
    process.exitCode = 1;
    return;
  }

  await approveRun(args.runId as `run_${string}`, args.json);
}

async function handleBench(
  args: CliArgs,
): Promise<void> {
  const report = await runBench({
    benchmarksFile: args.benchmarksFile,
    provider: args.provider,
    model: args.model,
    json: args.json,
  });

  if (args.json) {
    console.log(JSON.stringify(report));
  } else {
    console.log(formatBenchReport(report));
  }

  if (!report.passed) {
    process.exitCode = 1;
  }
}
