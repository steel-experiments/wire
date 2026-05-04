#!/usr/bin/env node
export * from "./shared/ids.js";
export * from "./shared/schemas.js";
export * from "./shared/types.js";
export * from "./storage/atomic.js";
export * from "./storage/tasks.js";
export * from "./storage/runs.js";
export * from "./storage/sessions.js";
export * from "./storage/artifacts.js";
export * from "./storage/artifact-registry.js";
export * from "./storage/events.js";
export * from "./storage/approvals.js";
export * from "./storage/checkpoints.js";
export * from "./browser/bridge.js";
export * from "./browser/session.js";
export * from "./browser/observe.js";
export * from "./browser/exec.js";
export * from "./browser/raw.js";
export * from "./browser/targets.js";
export * from "./providers/browser/steel.js";
export * from "./policy/rules.js";
export * from "./policy/engine.js";
export * from "./policy/approvals.js";
export * from "./providers/llm/openai.js";
export * from "./providers/llm/anthropic.js";
export * from "./skills/parser.js";
export * from "./skills/matcher.js";
export * from "./skills/loader.js";
export * from "./skills/promote.js";
export * from "./trace/replay.js";
export * from "./agent/context.js";
export * from "./agent/classify.js";
export * from "./agent/loop.js";
export * from "./agent/planning.js";
export * from "./agent/runtime.js";
export * from "./agent/branching.js";
export * from "./experiments/hypotheses.js";
export * from "./experiments/summaries.js";
export * from "./profiles/auth.js";
export * from "./cli/args.js";
export * from "./cli/runner.js";
export * from "./cli/main.js";
export * from "./cli/output.js";
export * from "./cli/errors.js";
export * from "./ui/review.js";
export * from "./eval/metrics.js";
export * from "./eval/harness.js";
export * from "./eval/bench.js";

import { pathToFileURL } from "node:url";

import { main } from "./cli/main.js";

const entryArg = process.argv[1];
const isDirectExecution = entryArg !== undefined && import.meta.url === pathToFileURL(entryArg).href;

if (isDirectExecution) {
  try { process.loadEnvFile(); } catch { /* .env optional */ }
  void main(process.argv).catch((err) => {
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    console.error(message);
    process.exitCode = 1;
  });
}
