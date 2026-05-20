import type { Run, RunId, TaskId, TraceEvent } from "../shared/types.js";
import type { LLMProvider } from "../providers/llm/openai.js";
import type { LlmProvider } from "../cli/config.js";

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { runTask, resolveProviderSelection, type RunOptions } from "../cli/runner.js";
import { loadRun } from "../storage/runs.js";
import { listTraceEvents } from "../storage/events.js";
import { listArtifacts } from "../storage/artifacts.js";
import { computeTaskMetrics, type TaskMetrics } from "./metrics.js";
import { createOpenAIProvider } from "../providers/llm/openai.js";
import { createAnthropicProvider } from "../providers/llm/anthropic.js";
import { nowIsoUtc } from "../shared/ids.js";
import { atomicWriteJson, ensureDir, entityDir, entityPath, listJsonFiles, readJsonFile } from "../storage/atomic.js";
import { defaultStorageRoot } from "../shared/paths.js";

// Types

export interface BenchmarkCase {
  id: string;
  objective: string;
  mode: "task" | "investigate" | "experiment";
  maxSteps: number;
  expected: {
    classification: string;
    answerContains?: string[];
    maxSteps?: number;
  };
}

export interface BenchResult {
  id: string;
  passed: boolean;
  classification: string;
  confidence: number;
  classificationMatch: boolean;
  answerRelevance: number;
  stepCount: number;
  stepEfficiency: number;
  durationMs: number;
  errorCount: number;
  autoRecoveryRate: number;
  judgeScore: number | null;
  result: string;
  notes: string[];
}

export interface BenchReport {
  id: string;
  runAt: string;
  results: BenchResult[];
  passed: boolean;
  passRate: number;
  avgJudge: number;
  avgSteps: number;
  avgDurationMs: number;
  avgAutoRecoveryRate: number;
}

export interface BenchOptions {
  benchmarksFile?: string | undefined;
  provider?: LlmProvider | undefined;
  model?: string | undefined;
  json?: boolean | undefined;
}

const JUDGE_PASS_THRESHOLD = 0.8;

export function evaluateBenchmarkPass(
  classificationMatch: boolean,
  answerRelevance: number,
  judgeScore: number | null,
): boolean {
  const metricPassed = classificationMatch && answerRelevance >= 1;
  const judgePassed = judgeScore !== null && judgeScore >= JUDGE_PASS_THRESHOLD;
  return metricPassed || judgePassed;
}

// Main runner

export async function bench(options: BenchOptions): Promise<BenchReport> {
  const filePath = resolve(options.benchmarksFile ?? "benchmarks/default.json");
  const benchmarks = await loadBenchmarks(filePath);
  const judgeProvider = createJudgeProvider(options.provider, options.model);

  const results: BenchResult[] = [];

  for (const bm of benchmarks) {
    console.log(`Running benchmark: ${bm.id}...`);
    const result = await runBenchmark(bm, options, judgeProvider);
    results.push(result);
  }

  const passedCount = results.filter((r) => r.passed).length;
  const judgeScores = results
    .filter((r) => r.judgeScore !== null)
    .map((r) => r.judgeScore!);

  const runAt = nowIsoUtc();
  const report: BenchReport = {
    id: `bench-${runAt.replace(/[:.]/gu, "-")}`,
    runAt,
    results,
    passed: results.every((r) => r.passed),
    passRate: results.length > 0 ? passedCount / results.length : 0,
    avgJudge:
      judgeScores.length > 0
        ? judgeScores.reduce((a, b) => a + b, 0) / judgeScores.length
        : 0,
    avgSteps:
      results.length > 0
        ? results.reduce((a, b) => a + b.stepCount, 0) / results.length
        : 0,
    avgDurationMs:
      results.length > 0
        ? results.reduce((a, b) => a + b.durationMs, 0) / results.length
        : 0,
    avgAutoRecoveryRate:
      results.length > 0
        ? results.reduce((a, b) => a + b.autoRecoveryRate, 0) / results.length
        : 1,
  };

  const root = defaultStorageRoot();
  await saveBenchReport(root, report);

  return report;
}

// Single benchmark execution

async function runBenchmark(
  bm: BenchmarkCase,
  options: BenchOptions,
  judgeProvider?: LLMProvider,
): Promise<BenchResult> {
  const notes: string[] = [];
  const root = defaultStorageRoot();

  const runOpts: RunOptions = {
    objective: bm.objective,
    mode: bm.mode,
    maxSteps: bm.maxSteps,
    json: true,
  };
  if (options.provider) runOpts.provider = options.provider;
  if (options.model) runOpts.model = options.model;

  // Suppress per-task output while collecting the runId
  const origLog = console.log;
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  console.log = () => {};
  let runId: RunId;
  try {
    const runResult = await runTask(runOpts);
    runId = runResult.runId;
  } finally {
    console.log = origLog;
  }

  // Load results from storage
  const run = await loadRun(root, runId);
  const events = await listTraceEvents(root, runId);
  const artifacts = await listArtifacts(root, runId);
  const metrics = computeTaskMetrics(run, events, artifacts.length);

  // Hard metrics
  const actualClassification = run.classification?.kind ?? "unknown";
  const classificationMatch = actualClassification === bm.expected.classification;

  const extractedResult = extractResult(run, events);

  let answerRelevance = 1;
  const keywords = bm.expected.answerContains ?? [];
  if (keywords.length > 0) {
    const text = (extractedResult ?? "").toLowerCase();
    const matched = keywords.filter((kw) => text.includes(kw.toLowerCase()));
    answerRelevance = matched.length / keywords.length;
  }

  const stepEfficiency = bm.expected.maxSteps
    ? Math.min(1, bm.expected.maxSteps / metrics.stepCount)
    : 1;

  if (!classificationMatch) {
    notes.push(`Expected ${bm.expected.classification}, got ${actualClassification}`);
  }
  if (answerRelevance < 1) {
    notes.push(`Missing answer keywords (${(answerRelevance * 100).toFixed(0)}% relevance)`);
  }

  // LLM judge
  let judgeScore: number | null = null;
  if (judgeProvider && extractedResult) {
    judgeScore = await judgeResult(judgeProvider, bm.objective, extractedResult);
  }

  const passed = evaluateBenchmarkPass(classificationMatch, answerRelevance, judgeScore);
  if (passed && judgeScore !== null && judgeScore >= JUDGE_PASS_THRESHOLD && (!classificationMatch || answerRelevance < 1)) {
    notes.push(`Judge accepted output with score ${judgeScore.toFixed(1)}`);
  }

  return {
    id: bm.id,
    passed,
    classification: actualClassification,
    confidence: metrics.confidence,
    classificationMatch,
    answerRelevance,
    stepCount: metrics.stepCount,
    stepEfficiency,
    durationMs: metrics.durationMs,
    errorCount: metrics.errors,
    autoRecoveryRate: metrics.autoRecoveryRate,
    judgeScore,
    result: extractedResult ?? "",
    notes,
  };
}

// Result extraction (mirrors main.ts deriveExtractedResultFromEvents)

function extractResult(run: Run, events: TraceEvent[]): string | undefined {
  if (run.result) return run.result;

  const latestCodeResult = [...events].reverse().find((e) =>
    e.kind === "code-result" &&
    e.payload.ok === true &&
    (typeof e.payload.stdout === "string" || e.payload.returnValue !== undefined),
  );

  if (latestCodeResult) {
    const stdout = latestCodeResult.payload.stdout;
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      return stdout;
    }
    const rv = latestCodeResult.payload.returnValue;
    if (rv !== undefined) {
      return typeof rv === "string" ? rv : JSON.stringify(rv);
    }
  }

  const noteArtifact = [...events].reverse().find((e) =>
    e.kind === "artifact" &&
    e.payload.kind === "note" &&
    typeof e.payload.content === "string" &&
    (e.payload.content as string).trim().length > 0,
  );

  if (noteArtifact && typeof noteArtifact.payload.content === "string") {
    return noteArtifact.payload.content;
  }

  return undefined;
}

// LLM-as-judge

async function judgeResult(
  provider: LLMProvider,
  objective: string,
  result: string,
): Promise<number> {
  const response = await provider.chat(
    [
      {
        role: "system",
        content: [
          "You are a judge evaluating whether a browser agent's output fulfills an objective.",
          "Score the output from 0.0 to 1.0 based on:",
          "1. Does the output address the objective? (0.5 weight)",
          "2. Is the output structured and complete? (0.5 weight)",
          "Respond with ONLY a number between 0.0 and 1.0. No other text.",
        ].join("\n"),
      },
      {
        role: "user",
        content: `Objective: ${objective}\n\nAgent output:\n${result.slice(0, 2000)}`,
      },
    ],
    { temperature: 0, maxTokens: 16 },
  );

  const score = parseFloat(response.content.trim());
  if (isNaN(score)) return 0;
  return Math.min(1, Math.max(0, score));
}

// Provider helpers

function createJudgeProvider(
  provider?: LlmProvider,
  model?: string,
): LLMProvider | undefined {
  const selected = resolveProviderSelection(provider, model);
  if (selected === "openai") return createOpenAIProvider(model ? { model } : undefined);
  if (selected === "anthropic") return createAnthropicProvider(model ? { model } : undefined);
  return undefined;
}

// File loading

export async function loadBenchmarks(filePath: string): Promise<BenchmarkCase[]> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as BenchmarkCase[];
}

// Report persistence

const BENCH_KIND = "benchmarks";

function benchReportPath(root: string, id: string): string {
  return entityPath(root, BENCH_KIND, id);
}

export async function saveBenchReport(root: string, report: BenchReport): Promise<void> {
  await atomicWriteJson(benchReportPath(root, report.id), report);
}

export async function loadBenchReport(root: string, id: string): Promise<BenchReport> {
  const raw = await readJsonFile(benchReportPath(root, id));
  return raw as BenchReport;
}

export async function listBenchReports(root: string): Promise<BenchReport[]> {
  const dir = entityDir(root, BENCH_KIND);
  const files = await listJsonFiles(dir);
  const reports: BenchReport[] = [];

  for (const name of files) {
    const id = name.replace(/\.json$/u, "");
    const raw = await readJsonFile(benchReportPath(root, id));
    if (raw) {
      reports.push(raw as BenchReport);
    }
  }

  return reports.sort((a, b) => b.runAt.localeCompare(a.runAt));
}

// Report formatting

export function formatBenchReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push("=== Wire Benchmark Report ===");
  lines.push("");

  for (const r of report.results) {
    const mark = r.passed ? "x" : " ";
    const cls = r.classification.padEnd(16);
    const conf = r.confidence.toFixed(2);
    const steps = `${r.stepCount} steps`;
    const time = `${(r.durationMs / 1000).toFixed(1)}s`;
    const judge = r.judgeScore !== null ? `  judge: ${r.judgeScore.toFixed(1)}` : "";
    lines.push(`[${mark}] ${r.id.padEnd(20)} ${cls} ${conf}  ${steps}  ${time}${judge}`);
  }

  lines.push("");

  const passCount = report.results.filter((r) => r.passed).length;
  const total = report.results.length;
  const passInfo = `Pass rate: ${passCount}/${total} (${(report.passRate * 100).toFixed(0)}%)`;
  const judgeInfo = report.avgJudge > 0 ? `  Avg judge: ${report.avgJudge.toFixed(2)}` : "";
  const stepInfo = `  Avg steps: ${report.avgSteps.toFixed(1)}`;
  const timeInfo = `  Avg time: ${(report.avgDurationMs / 1000).toFixed(1)}s`;
  const recoveryInfo = report.avgAutoRecoveryRate < 1
    ? `  Avg auto-recovery: ${(report.avgAutoRecoveryRate * 100).toFixed(0)}%`
    : "";
  lines.push(`${passInfo}${judgeInfo}${stepInfo}${timeInfo}${recoveryInfo}`);

  return lines.join("\n");
}
