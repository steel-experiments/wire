import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { LoadedSkill, SkillMetadata } from "../shared/types.js";
import { ensureDir } from "../storage/atomic.js";

import { matchSkillsByHostname, matchSkillsByTags, sortByRelevance } from "./matcher.js";
import { extractSections, parseSkillFile } from "./parser.js";

// ---------------------------------------------------------------------------
// Load all skills from a directory
// ---------------------------------------------------------------------------

/**
 * Scan `dir` for `*.md` files, parse each one's frontmatter, and return
 * the resulting `SkillMetadata[]`. Files that fail to parse are skipped
 * (logged via a thrown-on-read error path, silently ignored here to keep
 * the loader resilient).
 */
export async function loadSkillsFromDir(dir: string): Promise<SkillMetadata[]> {
  const loaded = await loadSkillDocsFromDir(dir);
  return loaded.map((skill) => ({
    id: skill.id,
    scope: skill.scope,
    tags: skill.tags,
    updatedAt: skill.updatedAt,
    source: skill.source,
    ...(skill.hostnamePatterns
      ? { hostnamePatterns: skill.hostnamePatterns }
      : {}),
  }));
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
    } catch {
      continue;
    }

    try {
      const frontmatter = parseSkillFile(raw, filePath);
      const sections = Object.fromEntries(extractSections(raw));
      const loadedSkill: LoadedSkill = {
        id: frontmatter.id,
        scope: frontmatter.scope,
        tags: frontmatter.tags,
        updatedAt: frontmatter.updatedAt,
        source: frontmatter.source,
        path: filePath,
        body: raw,
        sections,
        ...(frontmatter.hostnamePatterns
          ? { hostnamePatterns: frontmatter.hostnamePatterns }
          : {}),
      };
      results.push(loadedSkill);
    } catch {
      // Skip unparseable skill files rather than crashing the entire load.
      continue;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Load and filter skills
// ---------------------------------------------------------------------------

/**
 * Load all skill files from `skillsDir` and filter by hostname and/or tags.
 * If both filters are provided, a skill must match at least one of them.
 * Results are sorted by `updatedAt` descending.
 */
export async function findMatchingSkills(
  skillsDir: string,
  hostname?: string,
  tags?: string[],
): Promise<SkillMetadata[]> {
  const all = await loadSkillDocsFromDir(skillsDir);

  const hasHostname = hostname !== undefined && hostname.length > 0;
  const hasTags = tags !== undefined && tags.length > 0;

  // No filters: return all, sorted
  if (!hasHostname && !hasTags) {
    return sortByRelevance(all);
  }

  const matched = new Set<LoadedSkill>();

  if (hasHostname) {
    for (const skill of matchSkillsByHostname(all, hostname!)) {
      matched.add(skill);
    }
  }

  if (hasTags) {
    for (const skill of matchSkillsByTags(all, tags!)) {
      matched.add(skill);
    }
  }

  return sortByRelevance([...matched]).map((skill) => ({
    id: skill.id,
    scope: skill.scope,
    tags: skill.tags,
    updatedAt: skill.updatedAt,
    source: skill.source,
    ...(skill.hostnamePatterns
      ? { hostnamePatterns: skill.hostnamePatterns }
      : {}),
  }));
}

export async function findMatchingSkillDocs(
  skillsDir: string,
  hostname?: string,
  tags?: string[],
): Promise<LoadedSkill[]> {
  const all = await loadSkillDocsFromDir(skillsDir);

  const hasHostname = hostname !== undefined && hostname.length > 0;
  const hasTags = tags !== undefined && tags.length > 0;

  if (!hasHostname && !hasTags) {
    return sortByRelevance(all);
  }

  const matched = new Set<LoadedSkill>();

  if (hasHostname) {
    for (const skill of matchSkillsByHostname(all, hostname!)) {
      matched.add(skill);
    }
  }

  if (hasTags) {
    for (const skill of matchSkillsByTags(all, tags!)) {
      matched.add(skill);
    }
  }

  return sortByRelevance([...matched]);
}
