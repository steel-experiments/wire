// ABOUTME: Tests for run comparison artifact generation (Skills v2 Milestone 3).
// ABOUTME: Exercises extractRunMetrics, compareRuns, and deriveTaskKey.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type { LoopResult, LoopState } from "./loop.js";
import type { TraceEvent, Run, RunId, SkillId, Task } from "../shared/types.js";

import {
  extractRunMetrics,
  compareRuns,
  deriveTaskKey,
  generateComparisonConclusion,
  type RunComparisonEntry,
} from "./compare.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: createId("run"),
    taskId: createId("task"),
    status: "succeeded",
    startedAt: "2026-05-06T10:00:00.000Z",
    finishedAt: "2026-05-06T10:00:42.000Z",
    classification: { kind: "task-complete", confidence: 0.95 },
    outcomeSummary: "Task completed.",
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Download public filing from SEC",
    mode: "task",
    objective: "Download the latest 10-K filing for Apple",
    constraints: [],
    successCriteria: ["Filing content is extracted"],
    createdAt: "2026-05-06T10:00:00.000Z",
    ...overrides,
  };
}

function makeSkillLoadEvent(runId: RunId, skillIds: string[]): TraceEvent {
  return {
    id: createId("event"),
    runId,
    ts: "2026-05-06T10:00:01.000Z",
    kind: "skill-load",
    payload: {
      skills: skillIds,
      labels: skillIds.map(() => "label"),
      hostname: "example.com",
      source: "/skills",
    },
  };
}

function makeLoopResult(overrides: {
  run?: Run;
  task?: Task;
  events?: TraceEvent[];
  stepCount?: number;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
  startedAt?: string;
}): LoopResult {
  const run = overrides.run ?? makeRun();
  const result: LoopResult = {
    run,
    events: overrides.events ?? [],
    classification: { kind: "task-complete", confidence: 0.95 },
    outcomeSummary: "Done",
    sessionId: createId("session"),
    stepCount: overrides.stepCount ?? 5,
    startedAt: overrides.startedAt ?? run.startedAt ?? "2026-05-06T10:00:00.000Z",
    helperSource: "function noop() {}",
    helperVersion: 0,
  };
  if (overrides.usage !== undefined) result.usage = overrides.usage;
  return result;
}

// ---------------------------------------------------------------------------
// deriveTaskKey
// ---------------------------------------------------------------------------

test("deriveTaskKey slugs task title into a kebab-case key", () => {
  const task = makeTask({ title: "Download public filing from SEC" });
  const key = deriveTaskKey(task);
  assert.equal(key, "download-public-filing-from-sec");
});

test("deriveTaskKey collapses repeated hyphens and trims", () => {
  const task = makeTask({ title: "  Do   something!!!   Now   " });
  const key = deriveTaskKey(task);
  assert.match(key, /^do-something-now$/u);
});

// ---------------------------------------------------------------------------
// extractRunMetrics
// ---------------------------------------------------------------------------

test("extractRunMetrics captures all fields from a LoopResult", () => {
  const runId = createId("run");
  const skillA = createId("skill") as SkillId;
  const result = makeLoopResult({
    run: makeRun({ id: runId, startedAt: "2026-05-06T10:00:00.000Z", finishedAt: "2026-05-06T10:00:42.000Z" }),
    events: [makeSkillLoadEvent(runId, [skillA])],
    stepCount: 8,
    usage: { promptTokens: 5000, completionTokens: 7000, totalTokens: 12000 },
    startedAt: "2026-05-06T10:00:00.000Z",
  });

  const metrics = extractRunMetrics(result);

  assert.equal(metrics.runId, runId);
  assert.equal(metrics.loadedSkills.length, 1);
  assert.equal(metrics.loadedSkills[0], skillA);
  assert.equal(metrics.classification, "task-complete");
  assert.equal(metrics.stepCount, 8);
  assert.equal(metrics.totalTokens, 12000);
  assert.equal(metrics.durationMs, 42000);
});

test("extractRunMetrics handles missing usage gracefully", () => {
  const result = makeLoopResult({ usage: undefined });
  const metrics = extractRunMetrics(result);
  assert.equal(metrics.totalTokens, undefined);
});

test("extractRunMetrics handles missing finishedAt gracefully", () => {
  const run = makeRun({ startedAt: "2026-05-06T10:00:00.000Z" });
  delete run.finishedAt;
  const result = makeLoopResult({
    run,
    startedAt: "2026-05-06T10:00:00.000Z",
  });
  const metrics = extractRunMetrics(result);
  assert.equal(metrics.durationMs, 0);
});

test("extractRunMetrics collects skills from multiple skill-load events", () => {
  const runId = createId("run");
  const skillA = createId("skill") as SkillId;
  const skillB = createId("skill") as SkillId;
  const result = makeLoopResult({
    run: makeRun({ id: runId }),
    events: [
      makeSkillLoadEvent(runId, [skillA]),
      makeSkillLoadEvent(runId, [skillB]),
    ],
  });

  const metrics = extractRunMetrics(result);
  assert.equal(metrics.loadedSkills.length, 2);
  assert.ok(metrics.loadedSkills.includes(skillA));
  assert.ok(metrics.loadedSkills.includes(skillB));
});

test("extractRunMetrics deduplicates skill IDs across sync events", () => {
  const runId = createId("run");
  const skillA = createId("skill") as SkillId;
  const result = makeLoopResult({
    run: makeRun({ id: runId }),
    events: [
      makeSkillLoadEvent(runId, [skillA]),
      makeSkillLoadEvent(runId, [skillA]),
    ],
  });

  const metrics = extractRunMetrics(result);
  assert.equal(metrics.loadedSkills.length, 1);
});

// ---------------------------------------------------------------------------
// generateComparisonConclusion
// ---------------------------------------------------------------------------

test("generateComparisonConclusion notes skill-backed improvement", () => {
  const entries: RunComparisonEntry[] = [
    {
      runId: "run_a" as RunId,
      loadedSkills: [],
      classification: "task-complete",
      stepCount: 8,
      totalTokens: 12000,
      durationMs: 42000,
    },
    {
      runId: "run_b" as RunId,
      loadedSkills: ["skill_sec" as SkillId],
      classification: "task-complete",
      stepCount: 4,
      totalTokens: 7000,
      durationMs: 19000,
    },
  ];

  const conclusion = generateComparisonConclusion(entries);
  assert.match(conclusion, /fewer steps/u);
  assert.match(conclusion, /4 vs 8/u);
  assert.match(conclusion, /lower token cost/u);
});

test("generateComparisonConclusion notes faster completion", () => {
  const entries: RunComparisonEntry[] = [
    {
      runId: "run_a" as RunId,
      loadedSkills: [],
      classification: "task-complete",
      stepCount: 5,
      totalTokens: 8000,
      durationMs: 60000,
    },
    {
      runId: "run_b" as RunId,
      loadedSkills: ["skill_x" as SkillId],
      classification: "task-complete",
      stepCount: 5,
      totalTokens: 8000,
      durationMs: 30000,
    },
  ];

  const conclusion = generateComparisonConclusion(entries);
  assert.match(conclusion, /faster/u);
  assert.match(conclusion, /30s vs 60s/u);
});

test("generateComparisonConclusion handles identical results", () => {
  const entries: RunComparisonEntry[] = [
    {
      runId: "run_a" as RunId,
      loadedSkills: [],
      classification: "task-complete",
      stepCount: 5,
      totalTokens: 8000,
      durationMs: 40000,
    },
    {
      runId: "run_b" as RunId,
      loadedSkills: ["skill_x" as SkillId],
      classification: "task-complete",
      stepCount: 5,
      totalTokens: 8000,
      durationMs: 40000,
    },
  ];

  const conclusion = generateComparisonConclusion(entries);
  assert.match(conclusion, /no measurable difference/iu);
});

test("generateComparisonConclusion notes when candidate failed but baseline succeeded", () => {
  const entries: RunComparisonEntry[] = [
    {
      runId: "run_a" as RunId,
      loadedSkills: [],
      classification: "task-complete",
      stepCount: 5,
      totalTokens: 8000,
      durationMs: 40000,
    },
    {
      runId: "run_b" as RunId,
      loadedSkills: ["skill_x" as SkillId],
      classification: "agent-error",
      stepCount: 10,
      totalTokens: 15000,
      durationMs: 60000,
    },
  ];

  const conclusion = generateComparisonConclusion(entries);
  assert.match(conclusion, /regression/iu);
});

test("generateComparisonConclusion handles single run", () => {
  const entries: RunComparisonEntry[] = [
    {
      runId: "run_a" as RunId,
      loadedSkills: [],
      classification: "task-complete",
      stepCount: 5,
      totalTokens: 8000,
      durationMs: 40000,
    },
  ];

  const conclusion = generateComparisonConclusion(entries);
  assert.match(conclusion, /single run/iu);
});

// ---------------------------------------------------------------------------
// compareRuns
// ---------------------------------------------------------------------------

test("compareRuns produces full comparison artifact", () => {
  const task = makeTask();
  const runIdA = createId("run");
  const runIdB = createId("run");
  const skillA = createId("skill") as SkillId;

  const baseline = makeLoopResult({
    run: makeRun({ id: runIdA, startedAt: "2026-05-06T10:00:00.000Z", finishedAt: "2026-05-06T10:00:42.000Z" }),
    task,
    events: [makeSkillLoadEvent(runIdA, [])],
    stepCount: 8,
    usage: { promptTokens: 5000, completionTokens: 7000, totalTokens: 12000 },
    startedAt: "2026-05-06T10:00:00.000Z",
  });

  const candidate = makeLoopResult({
    run: makeRun({ id: runIdB, startedAt: "2026-05-06T10:01:00.000Z", finishedAt: "2026-05-06T10:01:19.000Z" }),
    task,
    events: [makeSkillLoadEvent(runIdB, [skillA])],
    stepCount: 4,
    usage: { promptTokens: 3000, completionTokens: 4000, totalTokens: 7000 },
    startedAt: "2026-05-06T10:01:00.000Z",
  });

  const comparison = compareRuns(task, [baseline, candidate]);

  assert.equal(comparison.taskKey, "download-public-filing-from-sec");
  assert.equal(comparison.runs.length, 2);
  assert.equal(comparison.runs[0]!.runId, runIdA);
  assert.equal(comparison.runs[1]!.runId, runIdB);
  assert.equal(comparison.runs[1]!.loadedSkills.length, 1);
  assert.match(comparison.conclusion, /fewer steps/u);
});

test("compareRuns does not contain secrets or transcript content", () => {
  const task = makeTask();
  const result = makeLoopResult({
    run: makeRun(),
    task,
    events: [
      {
        id: createId("event"),
        runId: createId("run"),
        ts: "2026-05-06T10:00:01.000Z",
        kind: "code-exec",
        payload: { code: "return document.body.innerText" },
      },
      {
        id: createId("event"),
        runId: createId("run"),
        ts: "2026-05-06T10:00:02.000Z",
        kind: "code-result",
        payload: { ok: true, stdout: "Secret data: api_key=sk-abc123def456ghi789" },
      },
    ],
  });

  const comparison = compareRuns(task, [result]);
  const serialized = JSON.stringify(comparison);

  assert.ok(!serialized.includes("api_key"), "comparison must not contain secrets");
  assert.ok(!serialized.includes("sk-abc"), "comparison must not contain secret values");
  assert.ok(!serialized.includes("code-exec"), "comparison must not contain transcript events");
  assert.ok(!serialized.includes("code-result"), "comparison must not contain transcript events");
});
