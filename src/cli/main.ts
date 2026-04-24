import { parseArgs, formatHelp } from "./args.js";
import { approveRun, runTask } from "./runner.js";
import { loadConfig, resolveLlmConfig } from "./config.js";
import { formatReview } from "../ui/review.js";
import { loadRun, listRuns } from "../storage/runs.js";
import { listArtifacts } from "../storage/artifacts.js";
import { listTasks } from "../storage/tasks.js";
import { listTraceEvents } from "../storage/events.js";
import { stableJsonStringify } from "../shared/ids.js";
import type { TraceEvent } from "../shared/types.js";

function defaultStorageRoot(): string {
  return process.env["WIRE_ROOT"] ?? ".wire";
}

function deriveResultFromEvents(events: TraceEvent[]): string | undefined {
  const latestAnswerEvent = [...events].reverse().find((event) =>
    event.kind === "code-result" &&
    event.payload.ok === true &&
    (
      typeof event.payload.stdout === "string" ||
      event.payload.returnValue !== undefined
    )
  );

  if (latestAnswerEvent) {
    const stdout = latestAnswerEvent.payload.stdout;
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      return stdout;
    }

    const returnValue = latestAnswerEvent.payload.returnValue;
    if (returnValue !== undefined) {
      return typeof returnValue === "string"
        ? returnValue
        : stableJsonStringify(returnValue);
    }
  }

  const latestFinishSummary = [...events].reverse().find((event) =>
    event.kind === "thought-summary" &&
    event.payload.kind === "finish" &&
    typeof event.payload.summary === "string" &&
    event.payload.summary.trim().length > 0
  );

  if (latestFinishSummary && typeof latestFinishSummary.payload.summary === "string") {
    return latestFinishSummary.payload.summary;
  }

  return undefined;
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
    default: {
      console.error(`Unknown command: ${args.command}`);
      console.log(formatHelp());
      process.exitCode = 1;
    }
  }
}

async function handleRun(
  args: { objective?: string; taskFile?: string; mode?: "task" | "investigate" | "experiment"; profileId?: string; provider?: "openai" | "anthropic"; model?: string; maxSteps?: number; skillDir?: string },
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

  const opts: { objective: string; mode?: "task" | "investigate" | "experiment"; profileId?: string; provider?: "openai" | "anthropic"; model?: string; maxSteps?: number; skillDir?: string } = { objective };
  if (args.mode) opts.mode = args.mode;
  if (args.profileId) opts.profileId = args.profileId;
  if (llm.provider) opts.provider = llm.provider;
  if (llm.model) opts.model = llm.model;
  if (args.maxSteps) opts.maxSteps = args.maxSteps;
  if (args.skillDir) opts.skillDir = args.skillDir;

  await runTask(opts);
}

async function handleReview(
  args: { runId?: string; taskId?: string },
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

  console.log(formatReview({ run, events, artifacts }));
}

async function handleList(
  args: { mode?: "task" | "investigate" | "experiment" },
): Promise<void> {
  const root = defaultStorageRoot();

  console.log("=== Tasks ===");
  const tasks = await listTasks(root);

  if (tasks.length === 0) {
    console.log("  (no tasks)");
  } else {
    for (const task of tasks) {
      if (args.mode && task.mode !== args.mode) continue;
      console.log(`  ${task.id}  [${task.mode}]  ${task.title}`);
    }
  }

  console.log("");
  console.log("=== Runs ===");
  const runs = await listRuns(root);

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
  args: { runId?: string },
): Promise<void> {
  const root = defaultStorageRoot();

  if (!args.runId) {
    console.error("Error: --run-id is required for 'result'.");
    process.exitCode = 1;
    return;
  }

  const runId = args.runId as `run_${string}`;
  const run = await loadRun(root, runId);

  const result = run.result ?? deriveResultFromEvents(await listTraceEvents(root, runId));

  if (!result) {
    console.error(`No final result recorded for ${runId}.`);
    process.exitCode = 1;
    return;
  }

  console.log(result);
}

async function handleApprove(
  args: { runId?: string },
): Promise<void> {
  if (!args.runId) {
    console.error("Error: --run-id is required for 'approve'.");
    process.exitCode = 1;
    return;
  }

  await approveRun(args.runId as `run_${string}`);
}
