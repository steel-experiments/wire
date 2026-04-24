import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { SkillMetadata } from "../shared/types.js";
import { ensureDir } from "../storage/atomic.js";

import { matchSkillsByHostname, matchSkillsByTags, sortByRelevance } from "./matcher.js";
import { parseSkillFile } from "./parser.js";

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
  await ensureDir(dir);

  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }

  const mdFiles = entries.filter((name) => name.endsWith(".md")).sort();
  const results: SkillMetadata[] = [];

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
      // Extract only the SkillMetadata fields (drop `title`).
      // Must conditionally include hostnamePatterns because
      // exactOptionalPropertyTypes forbids explicit `undefined`.
      const metadata: SkillMetadata = {
        id: frontmatter.id,
        scope: frontmatter.scope,
        tags: frontmatter.tags,
        updatedAt: frontmatter.updatedAt,
        source: frontmatter.source,
        ...(frontmatter.hostnamePatterns
          ? { hostnamePatterns: frontmatter.hostnamePatterns }
          : {}),
      };
      results.push(metadata);
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
  const all = await loadSkillsFromDir(skillsDir);

  const hasHostname = hostname !== undefined && hostname.length > 0;
  const hasTags = tags !== undefined && tags.length > 0;

  // No filters: return all, sorted
  if (!hasHostname && !hasTags) {
    return sortByRelevance(all);
  }

  const matched = new Set<SkillMetadata>();

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
