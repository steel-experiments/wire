import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseArgs } from "../cli/args.js";
import { nowIsoUtc } from "../shared/ids.js";
import {
  loadBenchmarks,
  formatBenchReport,
  saveBenchReport,
  loadBenchReport,
  listBenchReports,
  evaluateBenchmarkPass,
  parseJudgeScore,
  type BenchReport,
  type BenchResult,
} from "./bench.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReport(overrides: Partial<BenchReport> = {}): BenchReport {
  return {
    id: "bench-test",
    runAt: nowIsoUtc(),
    results: [],
    passed: true,
    passRate: 1,
    avgJudge: 0,
    avgSteps: 0,
    avgDurationMs: 0,
    avgAutoRecoveryRate: 1,
    ...overrides,
  };
}

function makeResult(overrides: Partial<BenchResult> = {}): BenchResult {
  return {
    id: "test-result",
    passed: true,
    classification: "task-complete",
    confidence: 0.9,
    classificationMatch: true,
    answerRelevance: 1,
    stepCount: 3,
    stepEfficiency: 1,
    durationMs: 1000,
    errorCount: 0,
    autoRecoveryRate: 1,
    judgeScore: null,
    result: "ok",
    notes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// loadBenchmarks
// ---------------------------------------------------------------------------

test("loadBenchmarks reads and parses a valid benchmark file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wire-bench-"));
  const benchmarks = [
    {
      id: "test-1",
      objective: "Go to example.com",
      mode: "task",
      maxSteps: 5,
      expected: { classification: "task-complete", answerContains: ["Example"], maxSteps: 3 },
    },
  ];
  const filePath = join(dir, "bench.json");
  await writeFile(filePath, JSON.stringify(benchmarks), "utf-8");

  const loaded = await loadBenchmarks(filePath);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.id, "test-1");
  assert.equal(loaded[0]!.objective, "Go to example.com");
  assert.equal(loaded[0]!.mode, "task");
  assert.equal(loaded[0]!.maxSteps, 5);
  assert.deepEqual(loaded[0]!.expected.answerContains, ["Example"]);
});

test("parseJudgeScore returns null for unscoreable replies, not a misleading 0", () => {
  // Reasoning models can spend their token budget before emitting the number,
  // returning empty/prose. That must read as "no judge signal" (null), not a
  // 0.0 that fails a correct answer — the bug that made the suite swing.
  assert.equal(parseJudgeScore(""), null);
  assert.equal(parseJudgeScore("I think the answer is good"), null);
  // Real scores parse, including when wrapped in stray prose, and clamp.
  assert.equal(parseJudgeScore("0.85"), 0.85);
  assert.equal(parseJudgeScore("Score: 1.0"), 1);
  assert.equal(parseJudgeScore("0"), 0);
  assert.equal(parseJudgeScore("1.7"), 1);
  assert.equal(parseJudgeScore("-0.5"), 0);
});

test("loadBenchmarks preserves an optional per-case sessionConfig", async () => {
  // Anti-bot sites (booking) and fair-access sites (SEC EDGAR) only pass with
  // the right session config, so a case may carry stealth/proxy/userAgent.
  const dir = await mkdtemp(join(tmpdir(), "wire-bench-"));
  const benchmarks = [
    {
      id: "test-cfg",
      objective: "Go to a bot-walled site",
      mode: "task",
      maxSteps: 5,
      sessionConfig: { useProxy: true, stealth: true, solveCaptcha: true, userAgent: "Wire Research wire@example.com" },
      expected: { classification: "task-complete" },
    },
  ];
  const filePath = join(dir, "bench.json");
  await writeFile(filePath, JSON.stringify(benchmarks), "utf-8");

  const loaded = await loadBenchmarks(filePath);
  assert.deepEqual(loaded[0]!.sessionConfig, {
    useProxy: true,
    stealth: true,
    solveCaptcha: true,
    userAgent: "Wire Research wire@example.com",
  });
});

test("loadBenchmarks rejects missing file", async () => {
  await assert.rejects(
    () => loadBenchmarks("/nonexistent/bench.json"),
  );
});

// ---------------------------------------------------------------------------
// formatBenchReport
// ---------------------------------------------------------------------------

test("formatBenchReport formats passing results", () => {
  const report = makeReport({
    results: [makeResult({
      id: "example-title",
      confidence: 0.85,
      stepCount: 3,
      durationMs: 2100,
      judgeScore: 1.0,
    })],
  });

  const text = formatBenchReport(report);
  assert.ok(text.includes("=== Wire Benchmark Report ==="));
  assert.ok(text.includes("[x] example-title"));
  assert.ok(text.includes("task-complete"));
  assert.ok(text.includes("0.85"));
  assert.ok(text.includes("3 steps"));
  assert.ok(text.includes("2.1s"));
  assert.ok(text.includes("judge: 1.0"));
  assert.ok(text.includes("Pass rate: 1/1 (100%)"));
});

test("formatBenchReport formats failing results", () => {
  const report = makeReport({
    passed: false,
    passRate: 0,
    results: [makeResult({
      id: "httpbin-fail",
      passed: false,
      classification: "partial-success",
      confidence: 0.6,
      classificationMatch: false,
      answerRelevance: 0.5,
      stepCount: 4,
      durationMs: 3000,
      errorCount: 1,
      judgeScore: 0.4,
      notes: ["Expected task-complete, got partial-success"],
    })],
  });

  const text = formatBenchReport(report);
  assert.ok(text.includes("[ ] httpbin-fail"));
  assert.ok(text.includes("partial-success"));
  assert.ok(text.includes("Pass rate: 0/1 (0%)"));
});

test("formatBenchReport omits judge score when null", () => {
  const report = makeReport({
    results: [makeResult({ id: "no-judge", judgeScore: null })],
  });

  const text = formatBenchReport(report);
  assert.ok(!text.includes("judge:"));
});

test("formatBenchReport formats multiple results with aggregate stats", () => {
  const report = makeReport({
    passRate: 1,
    avgJudge: 0.9,
    avgSteps: 4,
    avgDurationMs: 4150,
    results: [
      makeResult({ id: "bench-a", confidence: 0.85, stepCount: 3, durationMs: 2100, judgeScore: 1.0 }),
      makeResult({ id: "bench-b", confidence: 0.7, stepCount: 5, durationMs: 6200, judgeScore: 0.8 }),
    ],
  });

  const text = formatBenchReport(report);
  assert.ok(text.includes("[x] bench-a"));
  assert.ok(text.includes("[x] bench-b"));
  assert.ok(text.includes("Pass rate: 2/2 (100%)"));
  assert.ok(text.includes("Avg judge: 0.90"));
  assert.ok(text.includes("Avg steps: 4.0"));
  assert.ok(text.includes("Avg time: 4.2s"));
});

test("evaluateBenchmarkPass accepts high judge score despite metric mismatch", () => {
  assert.equal(evaluateBenchmarkPass(false, 1, 1.0), true);
  assert.equal(evaluateBenchmarkPass(true, 0.5, 0.9), true);
  assert.equal(evaluateBenchmarkPass(false, 1, 0.7), false);
});

// ---------------------------------------------------------------------------
// Report persistence
// ---------------------------------------------------------------------------

test("saveBenchReport + loadBenchReport round-trips a report", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-bench-"));
  const report = makeReport({
    id: "bench-rt",
    runAt: "2026-04-25T12:00:00.000Z",
    results: [makeResult({ id: "example-title", result: "Example Domain" })],
  });

  await saveBenchReport(root, report);
  const loaded = await loadBenchReport(root, "bench-rt");

  assert.equal(loaded.id, "bench-rt");
  assert.equal(loaded.runAt, "2026-04-25T12:00:00.000Z");
  assert.equal(loaded.results.length, 1);
  assert.equal(loaded.results[0]!.id, "example-title");
  assert.equal(loaded.results[0]!.result, "Example Domain");
});

test("listBenchReports returns reports sorted newest first", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-bench-"));

  await saveBenchReport(root, makeReport({
    id: "bench-old",
    runAt: "2026-04-24T10:00:00.000Z",
  }));
  await saveBenchReport(root, makeReport({
    id: "bench-new",
    runAt: "2026-04-25T10:00:00.000Z",
  }));
  await saveBenchReport(root, makeReport({
    id: "bench-mid",
    runAt: "2026-04-24T18:00:00.000Z",
  }));

  const reports = await listBenchReports(root);
  assert.equal(reports.length, 3);
  assert.equal(reports[0]!.id, "bench-new");
  assert.equal(reports[1]!.id, "bench-mid");
  assert.equal(reports[2]!.id, "bench-old");
});

test("listBenchReports returns empty for no reports", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-bench-"));
  const reports = await listBenchReports(root);
  assert.deepEqual(reports, []);
});

test("saveBenchReport persists all BenchResult fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-bench-"));
  const result: BenchResult = {
    id: "full-result",
    passed: false,
    classification: "partial-success",
    confidence: 0.65,
    classificationMatch: false,
    answerRelevance: 0.5,
    stepCount: 7,
    stepEfficiency: 0.43,
    durationMs: 12345,
    errorCount: 2,
    autoRecoveryRate: 0.5,
    judgeScore: 0.3,
    result: "partial output",
    notes: ["Expected task-complete, got partial-success", "Missing answer keywords (50% relevance)"],
  };

  const report = makeReport({
    id: "bench-full",
    runAt: "2026-04-25T12:00:00.000Z",
    passed: false,
    passRate: 0,
    results: [result],
  });

  await saveBenchReport(root, report);
  const loaded = await loadBenchReport(root, "bench-full");

  assert.deepEqual(loaded.results[0], result);
});

// ---------------------------------------------------------------------------
// CLI parsing for bench command
// ---------------------------------------------------------------------------

test("parseArgs parses bench command", () => {
  const args = parseArgs(["node", "wire", "bench"]);
  assert.equal(args.command, "bench");
});

test("parseArgs parses bench command with --benchmarks flag", () => {
  const args = parseArgs(["node", "wire", "bench", "--benchmarks", "custom.json"]);
  assert.equal(args.command, "bench");
  assert.equal(args.benchmarksFile, "custom.json");
});

test("parseArgs parses bench command with provider and model", () => {
  const args = parseArgs(["node", "wire", "bench", "--provider", "openai", "--model", "gpt-5.4-mini"]);
  assert.equal(args.command, "bench");
  assert.equal(args.provider, "openai");
  assert.equal(args.model, "gpt-5.4-mini");
});

test("parseArgs parses bench command with --json flag", () => {
  const args = parseArgs(["node", "wire", "bench", "--json"]);
  assert.equal(args.command, "bench");
  assert.equal(args.json, true);
});

// ---------------------------------------------------------------------------
// Default benchmark file validation
// ---------------------------------------------------------------------------

test("default benchmarks file is valid and has 7 entries", async () => {
  const loaded = await loadBenchmarks("benchmarks/default.json");
  assert.equal(loaded.length, 7);

  const ids = loaded.map((b) => b.id);
  assert.ok(ids.includes("example-title"));
  assert.ok(ids.includes("wire-click-trusted-event"));
  assert.ok(ids.includes("booking-search"));
  assert.ok(ids.includes("sec-edgar-filing"));
  assert.ok(ids.includes("lesswrong-posts"));
  assert.ok(ids.includes("httpbin-headers"));
  assert.ok(ids.includes("elgoog-2048"));

  for (const bm of loaded) {
    assert.ok(bm.id.length > 0, "id must be non-empty");
    assert.ok(bm.objective.length > 0, "objective must be non-empty");
    assert.ok(bm.maxSteps > 0, "maxSteps must be positive");
    assert.ok(bm.expected.classification.length > 0, "classification must be non-empty");
    assert.ok(["task", "investigate", "experiment"].includes(bm.mode), "mode must be valid");
  }
});
