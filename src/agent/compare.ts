// ABOUTME: Run comparison artifact generation for experiment evaluation.
// ABOUTME: Produces compact, secret-free comparisons of run metrics without affecting runtime.

import type { LoopResult } from "./loop.js";
import type { RunId, SkillId, Task } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunComparisonEntry {
  runId: RunId;
  loadedSkills: SkillId[];
  classification: string;
  stepCount: number;
  totalTokens?: number;
  durationMs: number;
}

export interface RunComparison {
  taskKey: string;
  runs: RunComparisonEntry[];
  conclusion: string;
}

// ---------------------------------------------------------------------------
// extractRunMetrics
// ---------------------------------------------------------------------------

export function extractRunMetrics(result: LoopResult): RunComparisonEntry {
  const skillIds = extractLoadedSkills(result.events, result.run.id);

  let durationMs = 0;
  if (result.run.finishedAt && result.startedAt) {
    durationMs = Math.max(0, Date.parse(result.run.finishedAt) - Date.parse(result.startedAt));
  }

  return {
    runId: result.run.id,
    loadedSkills: skillIds,
    classification: result.classification.kind,
    stepCount: result.stepCount,
    ...(result.usage?.totalTokens !== undefined
      ? { totalTokens: result.usage.totalTokens }
      : {}),
    durationMs,
  };
}

function extractLoadedSkills(events: LoopResult["events"], runId: RunId): SkillId[] {
  const seen = new Set<SkillId>();
  for (const event of events) {
    if (event.kind !== "skill-load" || event.runId !== runId) continue;
    const skills = event.payload["skills"];
    if (!Array.isArray(skills)) continue;
    for (const id of skills) {
      if (typeof id === "string") seen.add(id as SkillId);
    }
  }
  return [...seen];
}

// ---------------------------------------------------------------------------
// deriveTaskKey
// ---------------------------------------------------------------------------

export function deriveTaskKey(task: Task): string {
  return task.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

// ---------------------------------------------------------------------------
// generateComparisonConclusion
// ---------------------------------------------------------------------------

export function generateComparisonConclusion(runs: RunComparisonEntry[]): string {
  if (runs.length < 2) {
    return "Single run recorded; no comparison available.";
  }

  const baseline = runs[0]!;
  const candidate = runs[runs.length - 1]!;

  const improvements: string[] = [];
  const regressions: string[] = [];

  // Classification check
  const baselineOk = baseline.classification === "task-complete";
  const candidateOk = candidate.classification === "task-complete";
  if (baselineOk && !candidateOk) {
    return `Regression: baseline (${baseline.runId}) succeeded but candidate (${candidate.runId}) classified as ${candidate.classification}.`;
  }
  if (!baselineOk && candidateOk) {
    improvements.push("candidate succeeded where baseline failed");
  }

  // Step comparison
  if (candidate.stepCount < baseline.stepCount) {
    improvements.push(`fewer steps (${candidate.stepCount} vs ${baseline.stepCount})`);
  } else if (candidate.stepCount > baseline.stepCount) {
    regressions.push(`more steps (${candidate.stepCount} vs ${baseline.stepCount})`);
  }

  // Token comparison
  if (candidate.totalTokens !== undefined && baseline.totalTokens !== undefined) {
    if (candidate.totalTokens < baseline.totalTokens) {
      improvements.push(`lower token cost (${candidate.totalTokens} vs ${baseline.totalTokens})`);
    } else if (candidate.totalTokens > baseline.totalTokens) {
      regressions.push(`higher token cost (${candidate.totalTokens} vs ${baseline.totalTokens})`);
    }
  }

  // Duration comparison
  if (candidate.durationMs < baseline.durationMs) {
    const cSec = Math.round(candidate.durationMs / 1000);
    const bSec = Math.round(baseline.durationMs / 1000);
    improvements.push(`faster (${cSec}s vs ${bSec}s)`);
  } else if (candidate.durationMs > baseline.durationMs) {
    const cSec = Math.round(candidate.durationMs / 1000);
    const bSec = Math.round(baseline.durationMs / 1000);
    regressions.push(`slower (${cSec}s vs ${bSec}s)`);
  }

  if (improvements.length === 0 && regressions.length === 0) {
    const skillLabel = candidate.loadedSkills.length > 0
      ? " despite loaded skills"
      : "";
    return `No measurable difference between runs${skillLabel}.`;
  }

  const parts: string[] = [];
  if (improvements.length > 0) {
    parts.push(`Candidate improved: ${improvements.join(", ")}.`);
  }
  if (regressions.length > 0) {
    parts.push(`Regressed: ${regressions.join(", ")}.`);
  }

  return parts.join(" ");
}

// ---------------------------------------------------------------------------
// compareRuns
// ---------------------------------------------------------------------------

export function compareRuns(task: Task, results: LoopResult[]): RunComparison {
  const taskKey = deriveTaskKey(task);
  const runs = results.map(extractRunMetrics);
  const conclusion = generateComparisonConclusion(runs);

  return { taskKey, runs, conclusion };
}
