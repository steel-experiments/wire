import { parseArgs, formatHelp, type CliArgs } from "./args.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { approveRun, runTask, type RunOptions } from "./runner.js";
import { loadConfig, resolveLlmConfig } from "./config.js";
import { formatReview } from "../ui/review.js";
import { loadRun, listRuns } from "../storage/runs.js";
import { listArtifacts } from "../storage/artifacts.js";
import { loadTask, listTasks } from "../storage/tasks.js";
import { listTraceEvents } from "../storage/events.js";
import { deriveRunResult } from "../agent/loop.js";
import { bench as runBench, formatBenchReport } from "../eval/bench.js";
import {
  exportRows,
  toTraceTrajectory,
  type TrajectoryExportFormat,
} from "../eval/trajectories.js";
import { scoreRun } from "../eval/scoring.js";
import { classifyError } from "./errors.js";
import { success, failure } from "./output.js";
import { buildTimeline, summarizeTimeline } from "../trace/replay.js";
import { crystallizeRunScript } from "../trace/crystallize.js";
import { defaultStorageRoot } from "../shared/paths.js";
import { NotFoundError } from "../storage/atomic.js";
import {
  alternateRootHint,
  defaultAlternateRoots,
  findEntityInAlternateRoots,
} from "./storage-hints.js";

// Look up an error's entity in known alternate storage roots so the failure
// message can point at the file when the active root simply isn't where the
// user's data lives.
async function alternateRootMessage(err: unknown, root: string): Promise<string | null> {
  if (!(err instanceof NotFoundError)) return null;
  const hit = await findEntityInAlternateRoots(
    err.entityKind,
    err.entityId,
    defaultAlternateRoots(root),
  );
  return hit ? alternateRootHint(hit) : null;
}

async function reportCliError(
  command: string,
  err: unknown,
  root: string,
  json: boolean | undefined,
): Promise<void> {
  const extraHint = await alternateRootMessage(err, root);
  if (json) {
    const classified = classifyError(err);
    const enriched = extraHint
      ? { ...classified, hint: `${classified.hint} ${extraHint}` }
      : classified;
    console.log(JSON.stringify(failure(command, enriched)));
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    if (extraHint) console.error(`Hint: ${extraHint}`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (args.version) {
    console.log(await packageVersion());
    return;
  }

  if (args.help || argv.length <= 2) {
    console.log(formatHelp());
    return;
  }

  if (args.command === "run" && args.runId && args.objective && !args.taskFile) {
    const hint = `Unknown command after --run-id: "${args.objective}". Use one of: review, result, replay, approve, export.`;
    if (args.json) {
      console.log(JSON.stringify(failure("run", {
        error_class: "input",
        error_code: "UNKNOWN_RUN_COMMAND",
        retryable: false,
        hint,
      })));
    } else {
      console.error(`Error: ${hint}`);
    }
    process.exitCode = 1;
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
    case "replay": {
      await handleReplay(args);
      break;
    }
    case "craft": {
      await handleCraft(args);
      break;
    }
    case "bench": {
      await handleBench(args);
      break;
    }
    case "export": {
      await handleExport(args);
      break;
    }
    default: {
      if (args.json) {
        console.log(JSON.stringify(failure(args.command ?? "unknown", {
          error_class: "input",
          error_code: "UNKNOWN_COMMAND",
          retryable: false,
          hint: `Unknown command: ${args.command}. Run "wire --help" for available commands.`,
        })));
      } else {
        console.error(`Unknown command: ${args.command}`);
        console.log(formatHelp());
      }
      process.exitCode = 1;
    }
  }
}

async function packageVersion(): Promise<string> {
  const pkg = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf-8")) as { version?: string };
  return pkg.version ?? "0.0.0";
}

async function handleRun(
  args: CliArgs,
): Promise<void> {
  if (!args.objective && !args.taskFile) {
    if (args.json) {
      console.log(JSON.stringify(failure("run", {
        error_class: "input",
        error_code: "MISSING_OBJECTIVE",
        retryable: false,
        hint: "Provide --objective <text> or --task-file <path>.",
      })));
    } else {
      console.error("Error: --objective or --task-file is required for 'run'.");
    }
    process.exitCode = 1;
    return;
  }

  let objective = args.objective ?? "";

  try {
    if (args.taskFile) {
      const fs = await import("node:fs/promises");
      const raw = await fs.readFile(args.taskFile, "utf-8");
      let parsed: { objective?: string };
      try {
        parsed = JSON.parse(raw) as { objective?: string };
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`Invalid task file JSON: ${args.taskFile}: ${detail}`);
      }
      if (typeof parsed.objective === "string" && parsed.objective.length > 0) {
        objective = parsed.objective;
      }
    }

    if (!objective) {
      if (args.json) {
        console.log(JSON.stringify(failure("run", {
          error_class: "input",
          error_code: "MISSING_OBJECTIVE",
          retryable: false,
          hint: "No objective provided.",
        })));
      } else {
        console.error("Error: no objective provided.");
      }
      process.exitCode = 1;
      return;
    }

    const config = await loadConfig(undefined, undefined, args.strict);
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
    if (/\bkeep(?:ing)?\s+(?:the\s+)?session\s+open\b/iu.test(objective)) opts.keepSessionOpen = true;
    if (config.browser?.session) opts.sessionConfig = { ...config.browser.session };
    if (args.mode) opts.mode = args.mode;
    if (args.profileId) opts.profileId = args.profileId;
    if (llm.provider) opts.provider = llm.provider;
    if (llm.model) opts.model = llm.model;
    if (args.maxSteps) opts.maxSteps = args.maxSteps;
    if (args.skillDir) opts.skillDir = args.skillDir;
    if (args.useProxy !== undefined) opts.sessionConfig = { ...(opts.sessionConfig ?? {}), useProxy: args.useProxy };
    if (args.solveCaptcha !== undefined) opts.sessionConfig = { ...(opts.sessionConfig ?? {}), solveCaptcha: args.solveCaptcha };
    if (args.stealth !== undefined) opts.sessionConfig = { ...(opts.sessionConfig ?? {}), stealth: args.stealth };
    if (args.region) opts.sessionConfig = { ...(opts.sessionConfig ?? {}), region: args.region };
    if (args.userAgent) opts.sessionConfig = { ...(opts.sessionConfig ?? {}), userAgent: args.userAgent };
    if (args.json) opts.json = args.json;
    if (args.yes) opts.yes = args.yes;
    if (args.verbose) opts.verbose = args.verbose;
    if (args.quiet) opts.quiet = args.quiet;
    if (args.noColor) opts.color = false;
    if (args.traceLlm) opts.traceLlmMessages = true;

    const result = await runTask(opts);

    if (args.json) {
      console.log(JSON.stringify(success("run", result, result.runId)));
    }
  } catch (err) {
    if (args.json) {
      console.log(JSON.stringify(failure("run", classifyError(err))));
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

async function handleReview(
  args: CliArgs,
): Promise<void> {
  const root = defaultStorageRoot();

  if (args.taskId) {
    const runs = await listRuns(root, args.taskId as `task_${string}`);
    if (runs.length === 0) {
      if (args.json) {
        console.log(JSON.stringify(failure("review", {
          error_class: "session",
          error_code: "RUN_NOT_FOUND",
          retryable: false,
          hint: `No runs found for task ${args.taskId}.`,
        })));
      } else {
        console.error(`No runs found for task ${args.taskId}.`);
      }
      process.exitCode = 1;
      return;
    }
    for (const run of runs) {
      const artifacts = await listArtifacts(root, run.id);
      const events = await listTraceEvents(root, run.id);
      const task = await loadTask(root, run.taskId);
      const score = scoreRun(task, run, events, artifacts);
      if (args.json) {
        console.log(JSON.stringify(success("review", { run, task, events, artifacts, score })));
      } else {
        console.log(formatReview({ run, task, events, artifacts, score }));
        console.log("");
      }
    }
    return;
  }

  if (!args.runId) {
    if (args.json) {
      console.log(JSON.stringify(failure("review", {
        error_class: "input",
        error_code: "MISSING_RUN_ID",
        retryable: false,
        hint: "--run-id or --task-id is required for 'review'.",
      })));
    } else {
      console.error("Error: --run-id or --task-id is required for 'review'.");
    }
    process.exitCode = 1;
    return;
  }

  if (args.runId.startsWith("task_")) {
    if (args.json) {
      console.log(JSON.stringify(failure("review", {
        error_class: "input",
        error_code: "INVALID_RUN_ID",
        retryable: false,
        hint: `"${args.runId}" is a task ID. Use --task-id instead.`,
      })));
    } else {
      console.error(`Error: "${args.runId}" is a task ID, not a run ID.`);
      console.error(`Use --task-id ${args.runId} to review all runs for that task.`);
      console.error(`Or use --run-id with a run ID (starts with "run_").`);
    }
    process.exitCode = 1;
    return;
  }

  try {
    const runId = args.runId as `run_${string}`;
    const run = await loadRun(root, runId);
    const task = await loadTask(root, run.taskId);
    const artifacts = await listArtifacts(root, runId);
    const events = await listTraceEvents(root, runId);
    const score = scoreRun(task, run, events, artifacts);

    if (args.json) {
      console.log(JSON.stringify(success("review", { run, task, events, artifacts, score }, runId)));
    } else {
      console.log(formatReview({ run, task, events, artifacts, score }));
    }
  } catch (err) {
    await reportCliError("review", err, root, args.json);
    process.exitCode = 1;
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
    console.log(JSON.stringify(success("list", { tasks: filteredTasks, runs })));
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
    if (args.json) {
      console.log(JSON.stringify(failure("result", {
        error_class: "input",
        error_code: "MISSING_RUN_ID",
        retryable: false,
        hint: "--run-id is required for 'result'.",
      })));
    } else {
      console.error("Error: --run-id is required for 'result'.");
    }
    process.exitCode = 1;
    return;
  }

  try {
    const runId = args.runId as `run_${string}`;
    const run = await loadRun(root, runId);
    const task = await loadTask(root, run.taskId);
    const events = await listTraceEvents(root, runId);
    const finishSummary = task.mode === "task" ? deriveRunResult(events, "investigate") : undefined;
    const result = run.result ??
      deriveRunResult(events, task.mode) ??
      finishSummary;

    if (!result) {
      if (args.json) {
        console.log(JSON.stringify(failure("result", {
          error_class: "session",
          error_code: "NO_RESULT",
          retryable: false,
          hint: `No final result recorded for ${runId}.`,
        }, runId)));
      } else {
        console.error(`No final result recorded for ${runId}.`);
        if (task.mode === "task" && finishSummary) {
          console.error(`Last finish summary: ${finishSummary}`);
        }
      }
      process.exitCode = 1;
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(success("result", {
        runId,
        result,
        classification: run.classification?.kind ?? "unknown",
        status: run.status,
      }, runId)));
    } else {
      console.log(result);
    }
  } catch (err) {
    await reportCliError("result", err, root, args.json);
    process.exitCode = 1;
  }
}

async function handleApprove(
  args: CliArgs,
): Promise<void> {
  if (!args.runId) {
    if (args.json) {
      console.log(JSON.stringify(failure("approve", {
        error_class: "input",
        error_code: "MISSING_RUN_ID",
        retryable: false,
        hint: "--run-id is required for 'approve'.",
      })));
    } else {
      console.error("Error: --run-id is required for 'approve'.");
    }
    process.exitCode = 1;
    return;
  }

  try {
    const result = await approveRun(args.runId as `run_${string}`, args.json);
    if (args.json) {
      console.log(JSON.stringify(success("approve", result, args.runId)));
    }
  } catch (err) {
    await reportCliError("approve", err, defaultStorageRoot(), args.json);
    process.exitCode = 1;
  }
}

async function handleReplay(
  args: CliArgs,
): Promise<void> {
  if (!args.runId) {
    if (args.json) {
      console.log(JSON.stringify(failure("replay", {
        error_class: "input",
        error_code: "MISSING_RUN_ID",
        retryable: false,
        hint: "--run-id is required for 'replay'.",
      })));
    } else {
      console.error("Error: --run-id is required for 'replay'.");
    }
    process.exitCode = 1;
    return;
  }

  const root = defaultStorageRoot();
  try {
    const runId = args.runId as `run_${string}`;
    const run = await loadRun(root, runId);
    const events = await listTraceEvents(root, runId);
    const timeline = buildTimeline(events, runId);

    if (args.json) {
      console.log(JSON.stringify(success("replay", {
        timeline,
        run: { id: run.id, status: run.status, classification: run.classification?.kind },
      }, runId)));
    } else {
      console.log(summarizeTimeline(timeline));
    }
  } catch (err) {
    await reportCliError("replay", err, root, args.json);
    process.exitCode = 1;
  }
}

async function handleCraft(args: CliArgs): Promise<void> {
  if (!args.runId) {
    if (args.json) {
      console.log(JSON.stringify(failure("craft", {
        error_class: "input",
        error_code: "MISSING_RUN_ID",
        retryable: false,
        hint: "--run-id is required for 'craft'.",
      })));
    } else {
      console.error("Error: --run-id is required for 'craft'.");
    }
    process.exitCode = 1;
    return;
  }

  const root = defaultStorageRoot();
  try {
    const runId = args.runId as `run_${string}`;
    const run = await loadRun(root, runId);
    const task = await loadTask(root, run.taskId);
    const events = await listTraceEvents(root, runId);
    const crafted = crystallizeRunScript(events, {
      objective: task.objective,
      runId,
      generatedAt: new Date().toISOString(),
    });

    if (args.outFile) {
      await mkdir(dirname(args.outFile), { recursive: true });
      await writeFile(args.outFile, crafted.source.endsWith("\n") ? crafted.source : `${crafted.source}\n`, "utf-8");
      if (args.json) {
        console.log(JSON.stringify(success("craft", { steps: crafted.steps.length, outFile: args.outFile }, runId)));
      } else {
        console.log(`Crafted ${crafted.steps.length} step(s) from ${runId} to ${args.outFile}`);
      }
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(success("craft", { steps: crafted.steps, source: crafted.source }, runId)));
    } else {
      console.log(crafted.source);
    }
  } catch (err) {
    await reportCliError("craft", err, root, args.json);
    process.exitCode = 1;
  }
}

async function handleBench(
  args: CliArgs,
): Promise<void> {
  try {
    const report = await runBench({
      benchmarksFile: args.benchmarksFile,
      provider: args.provider,
      model: args.model,
      json: args.json,
    });

    if (args.json) {
      console.log(JSON.stringify(success("bench", report)));
    } else {
      console.log(formatBenchReport(report));
    }

    if (!report.passed) {
      process.exitCode = 1;
    }
  } catch (err) {
    if (args.json) {
      console.log(JSON.stringify(failure("bench", classifyError(err))));
    } else {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.exitCode = 1;
  }
}

async function handleExport(args: CliArgs): Promise<void> {
  const root = defaultStorageRoot();
  try {
    const format: TrajectoryExportFormat = args.exportFormat ?? "trajectory";
    const runs = await selectRunsForExport(root, args);
    const trajectories = [];

    for (const run of runs) {
      const task = await loadTask(root, run.taskId);
      const events = await listTraceEvents(root, run.id);
      const artifacts = await listArtifacts(root, run.id);
      trajectories.push(toTraceTrajectory(task, run, events, artifacts));
    }

    const exportOptions: { minScore?: number; minPreferenceDelta?: number } = {};
    if (args.minScore !== undefined) exportOptions.minScore = args.minScore;
    if (args.minPreferenceDelta !== undefined) exportOptions.minPreferenceDelta = args.minPreferenceDelta;
    const rows = exportRows(trajectories, format, exportOptions);
    const jsonl = rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");

    if (args.outFile) {
      await mkdir(dirname(args.outFile), { recursive: true });
      await writeFile(args.outFile, jsonl, "utf-8");
      if (args.json) {
        console.log(JSON.stringify(success("export", {
          format,
          rows: rows.length,
          outFile: args.outFile,
        })));
      } else {
        console.log(`Exported ${rows.length} ${format} rows to ${args.outFile}`);
      }
      return;
    }

    if (args.json) {
      console.log(JSON.stringify(success("export", { format, rows })));
    } else {
      process.stdout.write(jsonl);
    }
  } catch (err) {
    await reportCliError("export", err, root, args.json);
    process.exitCode = 1;
  }
}

async function selectRunsForExport(root: string, args: CliArgs) {
  if (args.runId) {
    return [await loadRun(root, args.runId as `run_${string}`)];
  }
  if (args.taskId) {
    return listRuns(root, args.taskId as `task_${string}`);
  }
  return listRuns(root);
}
