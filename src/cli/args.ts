import type { TaskMode } from "../shared/types.js";
import type { LlmProvider } from "./config.js";

export interface CliArgs {
  command: "run" | "review" | "result" | "list" | "approve" | "bench";
  taskFile?: string;
  objective?: string;
  mode?: TaskMode;
  runId?: string;
  taskId?: string;
  profileId?: string;
  provider?: LlmProvider;
  model?: string;
  maxSteps?: number;
  skillDir?: string;
  benchmarksFile?: string;
  json?: boolean;
  help?: boolean;
}

const VALID_COMMANDS = new Set(["run", "review", "result", "list", "approve", "bench"]);

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // drop node and script path
  const result: CliArgs = { command: "run" };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      i++;
      continue;
    }

    if (arg === "--task-file") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.taskFile = val;
      }
      i++;
      continue;
    }

    if (arg === "--objective") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.objective = val;
      }
      i++;
      continue;
    }

    if (arg === "--mode") {
      i++;
      const val = args[i];
      if (val === "task" || val === "investigate" || val === "experiment") {
        result.mode = val;
      }
      i++;
      continue;
    }

    if (arg === "--run-id") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.runId = val;
      }
      i++;
      continue;
    }

    if (arg === "--task-id") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.taskId = val;
      }
      i++;
      continue;
    }

    if (arg === "--profile") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.profileId = val;
      }
      i++;
      continue;
    }

    if (arg === "--provider") {
      i++;
      const val = args[i];
      if (val === "openai" || val === "anthropic") {
        result.provider = val;
      }
      i++;
      continue;
    }

    if (arg === "--model") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.model = val;
      }
      i++;
      continue;
    }

    if (arg === "--max-steps") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        const n = Number(val);
        if (Number.isFinite(n) && n > 0) {
          result.maxSteps = Math.floor(n);
        }
      }
      i++;
      continue;
    }

    if (arg === "--skill-dir") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.skillDir = val;
      }
      i++;
      continue;
    }

    if (arg === "--benchmarks") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.benchmarksFile = val;
      }
      i++;
      continue;
    }

    if (arg === "--json") {
      result.json = true;
      i++;
      continue;
    }

    // Positional: the command
    if (arg !== undefined && VALID_COMMANDS.has(arg)) {
      result.command = arg as CliArgs["command"];
      i++;
      continue;
    }

    // Skip unknown args
    i++;
  }

  return result;
}

export function formatHelp(): string {
  return [
    "wire - zero-weight browser agent",
    "",
    "Usage:",
    "  wire <command> [options]",
    "",
    "Commands:",
    "  run       Execute a task (default)",
    "  review    Review a completed run",
    "  result    Print the final result for a run",
    "  list      List tasks or runs",
    "  approve   Approve pending actions",
    "  bench     Run benchmark suite",
    "",
    "Run options:",
    "  --objective <text>       Task objective (required unless --task-file)",
    "  --task-file <path>       Load task from a JSON file",
    "  --mode <mode>            Task mode: task | investigate | experiment",
    "  --profile <profile-id>   Browser profile to use",
    "  --provider <provider>    LLM provider: openai | anthropic",
    "  --model <model-id>       LLM model to use (e.g. gpt-5.4-mini, claude-sonnet-4-6)",
    "  --max-steps <n>          Maximum agent steps",
    "  --skill-dir <path>       Directory of skill definitions",
    "",
    "Review options:",
    "  --run-id <id>            Run to review",
    "  --task-id <id>           Review all runs for a task",
    "",
    "Result options:",
    "  --run-id <id>            Run whose final result should be printed",
    "",
    "List options:",
    "  --mode <mode>            Filter by task mode",
    "",
    "Approve options:",
    "  --run-id <id>            Run with pending approvals (required)",
    "",
    "Bench options:",
    "  --benchmarks <path>      Benchmark file (default: benchmarks/default.json)",
    "  --provider <provider>    LLM provider for agent and judge",
    "  --model <model-id>       LLM model for agent and judge",
    "",
    "General:",
    "  --json                   Output machine-readable JSON",
    "  --help, -h               Show this help message",
  ].join("\n");
}
