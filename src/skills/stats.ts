// ABOUTME: Per-skill effectiveness statistics — loaded count, success correlation, step/token averages.
// ABOUTME: Descriptive only; does not alter skill matching or runtime behavior.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { LoopResult } from "../agent/loop.js";
import type { SkillId, TraceEvent } from "../shared/types.js";

export interface SkillStats {
  loadedCount: number;
  successCount: number;
  totalSteps: number;
  totalTokens: number;
  lastLoadedAt: string;
}

export const DEFAULT_STATS: SkillStats = {
  loadedCount: 0, successCount: 0, totalSteps: 0, totalTokens: 0, lastLoadedAt: "",
};

export function mergeStats(existing: SkillStats, run: {
  succeeded: boolean; stepCount: number; totalTokens: number; loadedAt: string;
}): SkillStats {
  return {
    loadedCount: existing.loadedCount + 1,
    successCount: existing.successCount + (run.succeeded ? 1 : 0),
    totalSteps: existing.totalSteps + run.stepCount,
    totalTokens: existing.totalTokens + run.totalTokens,
    lastLoadedAt: run.loadedAt,
  };
}

function statsPath(skillDir: string, skillId: string): string {
  return join(skillDir, ".stats", `${skillId}.json`);
}

export async function readSkillStats(skillDir: string, skillId: string): Promise<SkillStats | null> {
  try {
    const raw = await readFile(statsPath(skillDir, skillId), "utf-8");
    return JSON.parse(raw) as SkillStats;
  } catch { return null; }
}

export async function writeSkillStats(skillDir: string, skillId: string, stats: SkillStats): Promise<void> {
  const dir = join(skillDir, ".stats");
  await mkdir(dir, { recursive: true });
  await writeFile(statsPath(skillDir, skillId), JSON.stringify(stats, null, 2), "utf-8");
}

export async function updateSkillStatsFromRun(skillDir: string, result: LoopResult): Promise<void> {
  const skillIds = extractLoadedSkills(result.events, result.run.id);
  if (skillIds.length === 0) return;
  const succeeded = result.classification.kind === "task-complete";
  const totalTokens = result.usage?.totalTokens ?? 0;
  for (const id of skillIds) {
    const existing = await readSkillStats(skillDir, id) ?? DEFAULT_STATS;
    const updated = mergeStats(existing, {
      succeeded, stepCount: result.stepCount, totalTokens, loadedAt: result.startedAt,
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
