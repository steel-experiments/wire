import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { LoadedSkill, SkillMetadata } from "../shared/types.js";
import { ensureDir } from "../storage/atomic.js";

import { scoreSkills, sortByRelevance, type SkillMatchScore } from "./matcher.js";
import { extractSections, parseSkillFile } from "./parser.js";
import { readSkillStats, type SkillStats } from "./stats.js";
import { sanitizeSkillContent } from "../agent/context.js";

// Load all skills from a directory

/**
 * Scan `dir` for `*.md` files, parse each one's frontmatter, and return
 * the resulting `SkillMetadata[]`. Files that fail to parse are skipped
 * (logged via a thrown-on-read error path, silently ignored here to keep
 * the loader resilient).
 */
export async function loadSkillsFromDir(dir: string): Promise<SkillMetadata[]> {
  const loaded = await loadSkillDocsFromDir(dir);
  return loaded.map(toSkillMetadata);
}

export async function loadSkillDocsFromDir(dir: string): Promise<LoadedSkill[]> {
  await ensureDir(dir);

  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((name) => name.endsWith(".md")).sort();
  const results: LoadedSkill[] = [];

  for (const name of mdFiles) {
    const filePath = join(dir, name);

    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      logSkillLoadFailure(filePath, "read", err);
      continue;
    }

    try {
      const frontmatter = parseSkillFile(raw, filePath);
      const sections = Object.fromEntries(extractSections(raw));
      const loadedSkill: LoadedSkill = {
        id: frontmatter.id,
        scope: frontmatter.scope,
        ...(frontmatter.status ? { status: frontmatter.status } : {}),
        tags: frontmatter.tags,
        updatedAt: frontmatter.updatedAt,
        source: frontmatter.source,
        ...(frontmatter.confidence !== undefined ? { confidence: frontmatter.confidence } : {}),
        ...(frontmatter.sourceRunIds ? { sourceRunIds: frontmatter.sourceRunIds } : {}),
        ...(frontmatter.supersedes ? { supersedes: frontmatter.supersedes } : {}),
        path: filePath,
        body: sanitizeSkillContent(raw),
        sections,
        ...(frontmatter.hostnamePatterns
          ? { hostnamePatterns: frontmatter.hostnamePatterns }
          : {}),
      };
      results.push(loadedSkill);
    } catch (err) {
      logSkillLoadFailure(filePath, "parse", err);
      continue;
    }
  }

  return results;
}

let skillLoadWarningSink: ((line: string) => void) | undefined;

export function setSkillLoadWarningSink(sink: ((line: string) => void) | undefined): void {
  skillLoadWarningSink = sink;
}

function logSkillLoadFailure(path: string, phase: "read" | "parse", err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  (skillLoadWarningSink ?? console.error)(`[skill-loader] ${phase} failed for ${path}: ${message}`);
}

// Load and filter skills

/**
 * Load all skill files from `skillsDir` and filter by hostname and/or tags.
 * If both filters are provided, a skill must match at least one of them.
 * Inactive skills are excluded. Results are sorted by match score.
 */
export async function findMatchingSkills(
  skillsDir: string,
  hostname?: string,
  tags?: string[],
): Promise<SkillMetadata[]> {
  const matched = await findMatchingSkillDocs(skillsDir, hostname, tags);
  return matched.map(toSkillMetadata);
}

export async function findMatchingSkillDocs(
  skillsDir: string,
  hostname?: string,
  tags?: string[],
): Promise<LoadedSkill[]> {
  return (await findMatchingSkillDocMatches(skillsDir, hostname, tags)).map((entry) => entry.skill);
}

export async function findMatchingSkillDocMatches(
  skillsDir: string,
  hostname?: string,
  tags?: string[],
): Promise<Array<SkillMatchScore<LoadedSkill>>> {
  const all = await loadSkillDocsFromDir(skillsDir);
  const statsBySkillId = await loadStatsForSkills(skillsDir, all);
  return filterMatchingSkillDocMatches(all, hostname, tags, statsBySkillId);
}

async function loadStatsForSkills(skillsDir: string, skills: LoadedSkill[]): Promise<Record<string, SkillStats>> {
  const entries: Array<[string, SkillStats]> = [];
  for (const skill of skills) {
    const stats = await readSkillStats(skillsDir, skill.id);
    if (stats) entries.push([skill.id, stats]);
  }
  return Object.fromEntries(entries);
}

function sortByEffectiveness(active: LoadedSkill[], statsBySkillId: Record<string, SkillStats>): Array<SkillMatchScore<LoadedSkill>> {
  return scoreSkills(active, {
    minScore: Number.NEGATIVE_INFINITY,
    statsBySkillId,
  });
}

function filterMatchingSkillDocMatches(
  all: LoadedSkill[],
  hostname?: string,
  tags?: string[],
  statsBySkillId: Record<string, SkillStats> = {},
): Array<SkillMatchScore<LoadedSkill>> {

  const hasHostname = hostname !== undefined && hostname.length > 0;
  const hasTags = tags !== undefined && tags.length > 0;
  const active = all.filter((skill) =>
    skill.status !== "proposed" &&
    skill.status !== "rejected" &&
    skill.status !== "superseded"
  );

  if (!hasHostname && !hasTags) {
    return Object.keys(statsBySkillId).length > 0
      ? sortByEffectiveness(active, statsBySkillId)
      : sortByRelevance(active).map((skill) => ({ skill, score: 0, reasons: ["recent-or-confident"] }));
  }

  const minScore = hasHostname ? 6 : 6;
  const scoreOptions: { hostname?: string; tags?: string[]; minScore: number; statsBySkillId?: Record<string, SkillStats> } = { minScore };
  if (hostname) scoreOptions.hostname = hostname;
  if (tags) scoreOptions.tags = tags;
  if (Object.keys(statsBySkillId).length > 0) scoreOptions.statsBySkillId = statsBySkillId;
  return scoreSkills(active, scoreOptions);
}

function toSkillMetadata(skill: LoadedSkill): SkillMetadata {
  return {
    id: skill.id,
    scope: skill.scope,
    ...(skill.status ? { status: skill.status } : {}),
    tags: skill.tags,
    updatedAt: skill.updatedAt,
    source: skill.source,
    ...(skill.confidence !== undefined ? { confidence: skill.confidence } : {}),
    ...(skill.sourceRunIds ? { sourceRunIds: skill.sourceRunIds } : {}),
    ...(skill.supersedes ? { supersedes: skill.supersedes } : {}),
    ...(skill.hostnamePatterns
      ? { hostnamePatterns: skill.hostnamePatterns }
      : {}),
  };
}
