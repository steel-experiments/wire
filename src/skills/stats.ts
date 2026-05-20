
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopResult } from "../agent/loop.js";
import type { RunClassificationKind, RunId, SkillId, TraceEvent } from "../shared/types.js";

const MAX_RUN_SAMPLES = 20;

export interface SkillRunSample {
  runId: RunId;
  loadedAt: string;
  outcome: RunClassificationKind;
  stepCount: number;
  totalTokens: number;
  loadedWithSkillIds: SkillId[];
}

export interface SkillStats {
  loadedCount: number;
  successCount: number;
  outcomeCounts: Partial<Record<RunClassificationKind, number>>;
  totalSteps: number;
  totalTokens: number;
  lastLoadedAt: string;
  recentRuns: SkillRunSample[];
}

export const DEFAULT_STATS: SkillStats = {
  loadedCount: 0,
  successCount: 0,
  outcomeCounts: {},
  totalSteps: 0,
  totalTokens: 0,
  lastLoadedAt: "",
  recentRuns: [],
};

export function skillSuccessRate(stats: SkillStats): number {
  return stats.loadedCount === 0 ? 0 : stats.successCount / stats.loadedCount;
}

export function averageStepsWhenLoaded(stats: SkillStats): number {
  return stats.loadedCount === 0 ? 0 : stats.totalSteps / stats.loadedCount;
}

export function averageTokensWhenLoaded(stats: SkillStats): number {
  return stats.loadedCount === 0 ? 0 : stats.totalTokens / stats.loadedCount;
}

export function mergeStats(existing: SkillStats, run: {
  succeeded: boolean;
  stepCount: number;
  totalTokens: number;
  loadedAt: string;
  runId?: RunId;
  outcome?: RunClassificationKind;
  loadedWithSkillIds?: SkillId[];
}): SkillStats {
  const normalized = normalizeSkillStats(existing);
  const outcome: RunClassificationKind = run.outcome ?? (run.succeeded ? "task-complete" : "ambiguous");
  const outcomeCounts = {
    ...normalized.outcomeCounts,
    [outcome]: (normalized.outcomeCounts[outcome] ?? 0) + 1,
  };
  const recentRuns = run.runId
    ? [
      ...normalized.recentRuns,
      {
        runId: run.runId,
        loadedAt: run.loadedAt,
        outcome,
        stepCount: run.stepCount,
        totalTokens: run.totalTokens,
        loadedWithSkillIds: run.loadedWithSkillIds ?? [],
      },
    ].slice(-MAX_RUN_SAMPLES)
    : normalized.recentRuns;

  return {
    loadedCount: normalized.loadedCount + 1,
    successCount: normalized.successCount + (run.succeeded ? 1 : 0),
    outcomeCounts,
    totalSteps: normalized.totalSteps + run.stepCount,
    totalTokens: normalized.totalTokens + run.totalTokens,
    lastLoadedAt: run.loadedAt,
    recentRuns,
  };
}

export function normalizeSkillStats(raw: Partial<SkillStats> | null | undefined): SkillStats {
  return {
    loadedCount: raw?.loadedCount ?? 0,
    successCount: raw?.successCount ?? 0,
    outcomeCounts: raw?.outcomeCounts ?? {},
    totalSteps: raw?.totalSteps ?? 0,
    totalTokens: raw?.totalTokens ?? 0,
    lastLoadedAt: raw?.lastLoadedAt ?? "",
    recentRuns: raw?.recentRuns ?? [],
  };
}

function statsPath(skillDir: string, skillId: string): string {
  return join(skillDir, ".stats", `${skillId}.json`);
}

export async function readSkillStats(skillDir: string, skillId: string): Promise<SkillStats | null> {
  try {
    const raw = await readFile(statsPath(skillDir, skillId), "utf-8");
    return normalizeSkillStats(JSON.parse(raw) as Partial<SkillStats>);
  } catch { return null; }
}

export async function writeSkillStats(skillDir: string, skillId: string, stats: Partial<SkillStats>): Promise<void> {
  const dir = join(skillDir, ".stats");
  await mkdir(dir, { recursive: true });
  await writeFile(statsPath(skillDir, skillId), JSON.stringify(normalizeSkillStats(stats), null, 2), "utf-8");
}

export async function updateSkillStatsFromRun(skillDir: string, result: LoopResult): Promise<void> {
  const skillIds = extractLoadedSkills(result.events, result.run.id);
  if (skillIds.length === 0) return;
  const succeeded = result.classification.kind === "task-complete";
  const totalTokens = result.usage?.totalTokens ?? 0;
  for (const id of skillIds) {
    const existing = await readSkillStats(skillDir, id) ?? DEFAULT_STATS;
    const updated = mergeStats(existing, {
      succeeded,
      stepCount: result.stepCount,
      totalTokens,
      loadedAt: result.startedAt,
      runId: result.run.id,
      outcome: result.classification.kind,
      loadedWithSkillIds: skillIds.filter((skillId) => skillId !== id),
    });
    await writeSkillStats(skillDir, id, updated);
  }
}

function extractLoadedSkills(events: TraceEvent[], runId: string): SkillId[] {
  const seen = new Set<SkillId>();
  for (const e of events) {
    if (e.kind !== "skill-load" || e.runId !== runId) continue;
    const skills = e.payload["skills"];
    if (!Array.isArray(skills)) continue;
    for (const id of skills) {
      if (typeof id === "string") seen.add(id as SkillId);
    }
  }
  return [...seen];
}
