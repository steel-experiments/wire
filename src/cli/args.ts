import type { TaskMode } from "../shared/types.js";
import type { LlmProvider } from "./config.js";
import { normalizeProvider } from "./config.js";
import type { TrajectoryExportFormat } from "../eval/trajectories.js";

export interface CliArgs {
  command: "run" | "review" | "result" | "list" | "approve" | "bench" | "replay" | "export" | "craft";
  taskFile?: string;
  objective?: string;
  mode?: TaskMode;
  runId?: string;
  taskId?: string;
  profileId?: string;
  provider?: LlmProvider;
  model?: string;
  baseUrl?: string;
  maxSteps?: number;
  skillDir?: string;
  useProxy?: boolean;
  solveCaptcha?: boolean;
  stealth?: boolean;
  region?: string;
  userAgent?: string;
  benchmarksFile?: string;
  exportFormat?: TrajectoryExportFormat;
  outFile?: string;
  minScore?: number;
  minPreferenceDelta?: number;
  minPassRate?: number;
  json?: boolean;
  yes?: boolean;
  strict?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  noColor?: boolean;
  traceLlm?: boolean;
  criticalPoints?: boolean;
  help?: boolean;
  version?: boolean;
}

const VALID_COMMANDS = new Set(["run", "review", "result", "list", "approve", "bench", "replay", "export", "craft"]);

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2); // drop node and script path
  const result: CliArgs = { command: "run" };
  const objectiveParts: string[] = [];
  let objectiveFromFlag = false;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];

    if (arg === "--help" || arg === "-h") {
      result.help = true;
      i++;
      continue;
    }

    if (arg === "--version" || arg === "-V") {
      result.version = true;
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
        objectiveFromFlag = true;
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
      const provider = normalizeProvider(args[i]);
      if (provider) {
        result.provider = provider;
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

    if (arg === "--base-url") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.baseUrl = val;
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

    if (arg === "--use-proxy") {
      result.useProxy = true;
      i++;
      continue;
    }

    if (arg === "--solve-captcha") {
      result.solveCaptcha = true;
      i++;
      continue;
    }

    if (arg === "--stealth") {
      result.stealth = true;
      i++;
      continue;
    }

    if (arg === "--region") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.region = val;
      }
      i++;
      continue;
    }

    if (arg === "--user-agent") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.userAgent = val;
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

    if (arg === "--format") {
      i++;
      const val = args[i];
      if (val === "trajectory" || val === "sft" || val === "rewards" || val === "preferences") {
        result.exportFormat = val;
      }
      i++;
      continue;
    }

    if (arg === "--out") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        result.outFile = val;
      }
      i++;
      continue;
    }

    if (arg === "--min-score") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        const n = Number(val);
        if (Number.isFinite(n)) {
          result.minScore = Math.max(0, Math.min(1, n));
        }
      }
      i++;
      continue;
    }

    if (arg === "--min-pass-rate") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        const n = Number(val);
        if (Number.isFinite(n)) {
          result.minPassRate = Math.max(0, Math.min(1, n));
        }
      }
      i++;
      continue;
    }

    if (arg === "--min-delta") {
      i++;
      const val = args[i];
      if (val !== undefined) {
        const n = Number(val);
        if (Number.isFinite(n)) {
          result.minPreferenceDelta = Math.max(0, Math.min(1, n));
        }
      }
      i++;
      continue;
    }

    if (arg === "--json") {
      result.json = true;
      i++;
      continue;
    }

    if (arg === "--yes" || arg === "--non-interactive") {
      result.yes = true;
      i++;
      continue;
    }

    if (arg === "--strict") {
      result.strict = true;
      i++;
      continue;
    }

    if (arg === "--verbose" || arg === "-v") {
      result.verbose = true;
      i++;
      continue;
    }

    if (arg === "--quiet" || arg === "-q") {
      result.quiet = true;
      i++;
      continue;
    }

    if (arg === "--no-color") {
      result.noColor = true;
      i++;
      continue;
    }

    if (arg === "--critical-points") {
      result.criticalPoints = true;
      i++;
      continue;
    }
    if (arg === "--no-critical-points") {
      result.criticalPoints = false;
      i++;
      continue;
    }
    if (arg === "--trace-llm") {
      result.traceLlm = true;
      i++;
      continue;
    }

    // Positional: the command
    if (arg !== undefined && VALID_COMMANDS.has(arg)) {
      result.command = arg as CliArgs["command"];
      i++;
      continue;
    }

    // Positional: collect objective words when no explicit --objective was set
    if (arg !== undefined && !arg.startsWith("-") && !objectiveFromFlag) {
      objectiveParts.push(arg);
    }

    i++;
  }

  if (!objectiveFromFlag && objectiveParts.length > 0) {
    result.objective = objectiveParts.join(" ");
  }

  return result;
}

export function formatHelp(): string {
  return [
    "wire - zero-weight browser agent",
    "",
    "Usage:",
    "  wire [command] [options]",
    "  wire <objective>",
    "",
    "Commands:",
    "  run       Execute a task (default)",
    "  review    Review a completed run",
    "  result    Print the final result for a run",
    "  list      List tasks or runs",
    "  approve   Approve pending actions",
    "  replay    Replay a run and show timeline",
    "  craft     Crystallize a run into a re-runnable browser script",
    "  bench     Run benchmark suite",
    "  export    Export scored trace trajectories for eval/training",
    "",
    "Run options:",
    "  <objective>              Shorthand: first non-flag, non-command argument",
    "  --objective <text>       Task objective (required unless --task-file)",
    "  --task-file <path>       Load task from a JSON file",
    "  --mode <mode>            Task mode: task | investigate | experiment",
    "  --profile <profile-id>   Browser profile to use",
    "  --provider <provider>    LLM provider: openai | anthropic | zai",
    "  --model <model-id>       LLM model to use (e.g. gpt-5.4-mini, claude-sonnet-4-6, glm-4.7)",
    "  --base-url <url>         LLM API base URL override (e.g. an Anthropic-compatible proxy)",
    "  --max-steps <n>          Maximum agent steps",
    "  --skill-dir <path>       Directory of skill definitions",
    "  --use-proxy              Start browser with provider proxy enabled",
    "  --solve-captcha          Start browser with provider captcha support enabled",
    "  --stealth                Request provider stealth mode when supported",
    "  --region <region>        Provider browser region",
    "  --user-agent <ua>        Browser user agent override",
    "",
    "Review options:",
    "  --run-id <id>            Run to review",
    "  --task-id <id>           Review all runs for a task",
    "",
    "Result options:",
    "  --run-id <id>            Run whose final result should be printed",
    "",
    "Replay options:",
    "  --run-id <id>            Run to replay",
    "",
    "Craft options:",
    "  --run-id <id>            Run to crystallize into a script (required)",
    "  --out <path>             Write the script to a file instead of stdout",
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
    "  --min-pass-rate <n>      Exit non-zero only if pass rate < n (0..1).",
    "                           Variance-tolerant gate; default requires all pass.",
    "",
    "Export options:",
    "  --format <format>        trajectory | sft | rewards | preferences",
    "  --out <path>             Write JSONL rows to a file instead of stdout",
    "  --run-id <id>            Export one run",
    "  --task-id <id>           Export runs for one task",
    "  --min-score <n>          Minimum score for SFT rows (0..1)",
    "  --min-delta <n>          Minimum score gap for preference pairs (0..1)",
    "",
    "General:",
    "  --json                   Output machine-readable JSON",
    "  --yes, --non-interactive Auto-approve policy actions",
    "  --strict                 Fail on missing config or schema violations",
    "  --verbose, -v            Stream observations, policy checks and full output",
    "  --quiet, -q              Suppress per-step trace stream",
    "  --no-color               Disable ANSI color in trace stream",
    "  --trace-llm              Store LLM messages/responses as blob refs",
    "  --critical-points        Judge completion against an LLM-authored checklist (default on)",
    "  --no-critical-points     Skip the critical-point completion check",
    "  --version, -V            Show version",
    "  --help, -h               Show this help message",
  ].join("\n");
}
