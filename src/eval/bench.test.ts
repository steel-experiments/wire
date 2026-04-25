import { strict as assert } from "node:assert";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { parseArgs } from "../cli/args.js";
import { loadBenchmarks, formatBenchReport, type BenchReport, type BenchResult } from "./bench.js";

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

test("loadBenchmarks rejects missing file", async () => {
  await assert.rejects(
    () => loadBenchmarks("/nonexistent/bench.json"),
  );
});

// ---------------------------------------------------------------------------
// formatBenchReport
// ---------------------------------------------------------------------------

test("formatBenchReport formats passing results", () => {
  const report: BenchReport = {
    results: [
      {
        id: "example-title",
        passed: true,
        classification: "task-complete",
        confidence: 0.85,
        classificationMatch: true,
        answerRelevance: 1,
        stepCount: 3,
        stepEfficiency: 0.75,
        durationMs: 2100,
        errorCount: 0,
        judgeScore: 1.0,
        result: "Example Domain",
        notes: [],
      },
    ],
    passed: true,
    passRate: 1,
    avgJudge: 1.0,
    avgSteps: 3,
    avgDurationMs: 2100,
  };

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
  const report: BenchReport = {
    results: [
      {
        id: "httpbin-fail",
        passed: false,
        classification: "partial-success",
        confidence: 0.6,
        classificationMatch: false,
        answerRelevance: 0.5,
        stepCount: 4,
        stepEfficiency: 1,
        durationMs: 3000,
        errorCount: 1,
        judgeScore: 0.4,
        result: "",
        notes: ["Expected task-complete, got partial-success"],
      },
    ],
    passed: false,
    passRate: 0,
    avgJudge: 0.4,
    avgSteps: 4,
    avgDurationMs: 3000,
  };

  const text = formatBenchReport(report);
  assert.ok(text.includes("[ ] httpbin-fail"));
  assert.ok(text.includes("partial-success"));
  assert.ok(text.includes("Pass rate: 0/1 (0%)"));
});

test("formatBenchReport omits judge score when null", () => {
  const report: BenchReport = {
    results: [
      {
        id: "no-judge",
        passed: true,
        classification: "task-complete",
        confidence: 0.9,
        classificationMatch: true,
        answerRelevance: 1,
        stepCount: 2,
        stepEfficiency: 1,
        durationMs: 1000,
        errorCount: 0,
        judgeScore: null,
        result: "ok",
        notes: [],
      },
    ],
    passed: true,
    passRate: 1,
    avgJudge: 0,
    avgSteps: 2,
    avgDurationMs: 1000,
  };

  const text = formatBenchReport(report);
  assert.ok(!text.includes("judge:"));
});

test("formatBenchReport formats multiple results with aggregate stats", () => {
  const report: BenchReport = {
    results: [
      {
        id: "bench-a",
        passed: true,
        classification: "task-complete",
        confidence: 0.85,
        classificationMatch: true,
        answerRelevance: 1,
        stepCount: 3,
        stepEfficiency: 0.75,
        durationMs: 2100,
        errorCount: 0,
        judgeScore: 1.0,
        result: "ok",
        notes: [],
      },
      {
        id: "bench-b",
        passed: true,
        classification: "task-complete",
        confidence: 0.7,
        classificationMatch: true,
        answerRelevance: 1,
        stepCount: 5,
        stepEfficiency: 0.6,
        durationMs: 6200,
        errorCount: 0,
        judgeScore: 0.8,
        result: "ok",
        notes: [],
      },
    ],
    passed: true,
    passRate: 1,
    avgJudge: 0.9,
    avgSteps: 4,
    avgDurationMs: 4150,
  };

  const text = formatBenchReport(report);
  assert.ok(text.includes("[x] bench-a"));
  assert.ok(text.includes("[x] bench-b"));
  assert.ok(text.includes("Pass rate: 2/2 (100%)"));
  assert.ok(text.includes("Avg judge: 0.90"));
  assert.ok(text.includes("Avg steps: 4.0"));
  assert.ok(text.includes("Avg time: 4.2s"));
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

test("default benchmarks file is valid and has 5 entries", async () => {
  const loaded = await loadBenchmarks("benchmarks/default.json");
  assert.equal(loaded.length, 5);

  const ids = loaded.map((b) => b.id);
  assert.ok(ids.includes("example-title"));
  assert.ok(ids.includes("booking-search"));
  assert.ok(ids.includes("sec-edgar-filing"));
  assert.ok(ids.includes("lesswrong-posts"));
  assert.ok(ids.includes("httpbin-headers"));

  for (const bm of loaded) {
    assert.ok(bm.id.length > 0, "id must be non-empty");
    assert.ok(bm.objective.length > 0, "objective must be non-empty");
    assert.ok(bm.maxSteps > 0, "maxSteps must be positive");
    assert.ok(bm.expected.classification.length > 0, "classification must be non-empty");
    assert.ok(["task", "investigate", "experiment"].includes(bm.mode), "mode must be valid");
  }
});
