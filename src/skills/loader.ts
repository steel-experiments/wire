import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { LoadedSkill, SkillMetadata } from "../shared/types.js";
import { ensureDir } from "../storage/atomic.js";

import { scoreSkills, sortByRelevance, type SkillMatchScore } from "./matcher.js";
import { extractSections, parseSkillFile } from "./parser.js";
import { signalSimilarity, textSignal } from "./promote.js";
import { readSkillStats, type SkillStats } from "./stats.js";
import { sanitizeSkillContent } from "../shared/sanitize.js";

// Load all skills from a directory

export interface SkillLoadOptions {
  includeProposals?: boolean;
}

export interface SkillMatchOptions extends SkillLoadOptions {}

/**
 * Scan `dir` for `*.md` files, parse each one's frontmatter, and return
 * the resulting `SkillMetadata[]`. Files that fail to parse are skipped
 * (logged via a thrown-on-read error path, silently ignored here to keep
 * the loader resilient).
 */
export async function loadSkillsFromDir(dir: string, options: SkillLoadOptions = {}): Promise<SkillMetadata[]> {
  const loaded = await loadSkillDocsFromDir(dir, options);
  return loaded.map(toSkillMetadata);
}

interface SkillFileCandidate {
  filePath: string;
}

async function skillFileCandidates(dir: string, options: SkillLoadOptions): Promise<SkillFileCandidate[]> {
  await ensureDir(dir);
  const candidates: SkillFileCandidate[] = [];
  try {
    const entries = await readdir(dir);
    candidates.push(
      ...entries
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => ({ filePath: join(dir, name) })),
    );
  } catch {
    return candidates;
  }

  if (options.includeProposals === true) {
    const proposalDir = join(dir, ".proposals");
    try {
      const proposalEntries = await readdir(proposalDir);
      candidates.push(
        ...proposalEntries
          .filter((name) => name.endsWith(".md"))
          .sort()
          .map((name) => ({ filePath: join(proposalDir, name) })),
      );
    } catch {
      // No proposal directory yet.
    }
  }

  return candidates;
}

export async function loadSkillDocsFromDir(dir: string, options: SkillLoadOptions = {}): Promise<LoadedSkill[]> {
  const candidates = await skillFileCandidates(dir, options);
  const results: LoadedSkill[] = [];
  // Active-dir candidates are listed before .proposals/, so keeping the first
  // occurrence of an id means a promoted skill's active copy shadows any
  // lingering proposal copy instead of both loading into the run.
  const seenIds = new Set<string>();

  for (const { filePath } of candidates) {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf-8");
    } catch (err) {
      logSkillLoadFailure(filePath, "read", err);
      continue;
    }

    try {
      const frontmatter = parseSkillFile(raw, filePath);
      if (seenIds.has(frontmatter.id)) continue;
      seenIds.add(frontmatter.id);
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
  options: SkillMatchOptions = {},
): Promise<SkillMetadata[]> {
  const matched = await findMatchingSkillDocs(skillsDir, hostname, tags, options);
  return matched.map(toSkillMetadata);
}

export async function findMatchingSkillDocs(
  skillsDir: string,
  hostname?: string,
  tags?: string[],
  options: SkillMatchOptions = {},
): Promise<LoadedSkill[]> {
  return (await findMatchingSkillDocMatches(skillsDir, hostname, tags, options)).map((entry) => entry.skill);
}

export async function findMatchingSkillDocMatches(
  skillsDir: string,
  hostname?: string,
  tags?: string[],
  options: SkillMatchOptions = {},
): Promise<Array<SkillMatchScore<LoadedSkill>>> {
  const all = await loadSkillDocsFromDir(skillsDir, options);
  const statsBySkillId = await loadStatsForSkills(skillsDir, all);
  return filterMatchingSkillDocMatches(all, hostname, tags, statsBySkillId, options);
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

// Per-run injection cap: every matched skill rides into the model context, so
// the cost of accumulation is paid on each step. Hostname matches outscore
// tag-only matches by an order of magnitude, so the cap keeps the most
// relevant skills and drops incidental tag overlap first.
const MAX_MATCHED_SKILLS = 5;

function filterMatchingSkillDocMatches(
  all: LoadedSkill[],
  hostname?: string,
  tags?: string[],
  statsBySkillId: Record<string, SkillStats> = {},
  options: SkillMatchOptions = {},
): Array<SkillMatchScore<LoadedSkill>> {

  const hasHostname = hostname !== undefined && hostname.length > 0;
  const hasTags = tags !== undefined && tags.length > 0;
  const active = shadowDuplicateProposals(all.filter((skill) =>
    (options.includeProposals === true || skill.status !== "proposed") &&
    skill.status !== "rejected" &&
    skill.status !== "superseded"
  ));

  if (!hasHostname && !hasTags) {
    const unfiltered = Object.keys(statsBySkillId).length > 0
      ? sortByEffectiveness(active, statsBySkillId)
      : sortByRelevance(active).map((skill) => ({ skill, score: 0, reasons: ["recent-or-confident"] }));
    return unfiltered.slice(0, MAX_MATCHED_SKILLS);
  }

  const minScore = hasHostname ? 6 : 6;
  const scoreOptions: { hostname?: string; tags?: string[]; minScore: number; limit: number; statsBySkillId?: Record<string, SkillStats> } = {
    minScore,
    limit: MAX_MATCHED_SKILLS,
  };
  if (hostname) scoreOptions.hostname = hostname;
  if (tags) scoreOptions.tags = tags;
  if (Object.keys(statsBySkillId).length > 0) scoreOptions.statsBySkillId = statsBySkillId;
  return scoreSkills(active, scoreOptions);
}

// Proposals for a hostname that already has an active skill are mostly
// re-derivations of the same knowledge (observed live: one active example.com
// skill plus four phrasing-variant proposals all rode into context together).
// Per active-covered hostname, at most ONE proposal loads — the most novel
// relative to the covering active skills. Proposal files stay on disk (they
// still count as rediscovery evidence for cumulative promotion); they just
// don't all ride into the run. Uncovered proposals always load.
function shadowDuplicateProposals(skills: LoadedSkill[]): LoadedSkill[] {
  const actives = skills.filter((skill) => skill.status !== "proposed");
  if (actives.length === 0 || actives.length === skills.length) return skills;

  const activeSignals = new Map(actives.map((skill) => [skill, textSignal(skill.body)]));
  const kept = new Set<LoadedSkill>(actives);
  const buckets = new Map<string, Array<{ skill: LoadedSkill; novelty: number }>>();

  for (const skill of skills) {
    if (skill.status !== "proposed") continue;
    const covering = actives.filter((activeSkill) => sharesHostnamePattern(activeSkill, skill));
    if (covering.length === 0) {
      kept.add(skill);
      continue;
    }
    const signal = textSignal(skill.body);
    const closest = Math.max(
      ...covering.map((activeSkill) => signalSimilarity(signal, activeSignals.get(activeSkill)!)),
    );
    const key = covering.map((activeSkill) => activeSkill.id).sort().join("|");
    const bucket = buckets.get(key) ?? [];
    bucket.push({ skill, novelty: 1 - closest });
    buckets.set(key, bucket);
  }

  for (const bucket of buckets.values()) {
    bucket.sort((a, b) =>
      b.novelty - a.novelty || b.skill.updatedAt.localeCompare(a.skill.updatedAt)
    );
    kept.add(bucket[0]!.skill);
  }

  return skills.filter((skill) => kept.has(skill));
}

function sharesHostnamePattern(a: LoadedSkill, b: LoadedSkill): boolean {
  if (!a.hostnamePatterns || !b.hostnamePatterns) return false;
  const patterns = new Set(a.hostnamePatterns.map((pattern) => pattern.toLowerCase()));
  return b.hostnamePatterns.some((pattern) => patterns.has(pattern.toLowerCase()));
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
