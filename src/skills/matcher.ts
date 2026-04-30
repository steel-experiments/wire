import type { SkillMetadata } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Hostname matching
// ---------------------------------------------------------------------------

/**
 * Return skills whose `hostnamePatterns` include a pattern that matches the
 * given hostname. Pattern matching is case-insensitive and supports a single
 * trailing wildcard: `"*.stripe.com"` matches `"dashboard.stripe.com"`.
 *
 * Skills without `hostnamePatterns` are never returned.
 */
export function matchSkillsByHostname<T extends SkillMetadata>(
  skills: T[],
  hostname: string,
): T[] {
  const lower = hostname.toLowerCase();

  return skills.filter((skill) => {
    if (!skill.hostnamePatterns || skill.hostnamePatterns.length === 0) {
      return false;
    }

    return skill.hostnamePatterns.some((pattern) =>
      hostnameMatches(pattern, lower),
    );
  });
}

function hostnameMatches(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();

  // Wildcard: *.example.com
  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return hostname.endsWith(suffix) || hostname === p.slice(2);
  }

  return hostname === p;
}

// ---------------------------------------------------------------------------
// Tag matching
// ---------------------------------------------------------------------------

/**
 * Return skills that have at least one tag in common with the requested tags.
 * Comparison is case-sensitive.
 */
export function matchSkillsByTags<T extends SkillMetadata>(
  skills: T[],
  tags: string[],
): T[] {
  if (tags.length === 0) return [];

  const tagSet = new Set(tags);

  return skills.filter((skill) =>
    skill.tags.some((t) => tagSet.has(t)),
  );
}

// ---------------------------------------------------------------------------
// Relevance sorting
// ---------------------------------------------------------------------------

/**
 * Sort skills by `updatedAt` descending (newest first). Returns a new array.
 */
export function sortByRelevance<T extends SkillMetadata>(skills: T[]): T[] {
  return [...skills].sort((a, b) => {
    const confidenceDelta = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confidenceDelta !== 0) return confidenceDelta;
    if (a.updatedAt > b.updatedAt) return -1;
    if (a.updatedAt < b.updatedAt) return 1;
    return 0;
  });
}

export interface SkillMatchScore<T extends SkillMetadata> {
  skill: T;
  score: number;
  reasons: string[];
}

export interface ScoreSkillsOptions {
  hostname?: string;
  tags?: string[];
  minScore?: number;
  limit?: number;
}

export function scoreSkills<T extends SkillMetadata>(
  skills: T[],
  options: ScoreSkillsOptions = {},
): SkillMatchScore<T>[] {
  const hostname = options.hostname?.toLowerCase();
  const tags = new Set((options.tags ?? []).map((tag) => tag.toLowerCase()));
  const minScore = options.minScore ?? 1;

  const filtersProvided = Boolean(hostname) || tags.size > 0;
  const scored: SkillMatchScore<T>[] = [];
  for (const skill of skills) {
    let score = 0;
    let hasMatchSignal = false;
    const reasons: string[] = [];

    if (hostname && skill.hostnamePatterns?.length) {
      for (const pattern of skill.hostnamePatterns) {
        if (hostnameMatches(pattern, hostname)) {
          const exact = !pattern.startsWith("*.") && pattern.toLowerCase() === hostname;
          score += exact ? 100 : 80;
          hasMatchSignal = true;
          reasons.push(exact ? "exact-hostname" : "wildcard-hostname");
          break;
        }
      }
    }

    if (tags.size > 0) {
      const overlap = skill.tags.filter((tag) => tags.has(tag.toLowerCase())).length;
      if (overlap > 0) {
        score += overlap * 6;
        hasMatchSignal = true;
        reasons.push(`tag-overlap:${overlap}`);
      }
    }

    if (skill.scope === "domain") score += 3;
    if (skill.scope === "workflow") score += 2;
    if (skill.scope === "interaction") score += 1;
    if (skill.source === "team") score += 2;
    if (skill.source === "generated") score += Math.round((skill.confidence ?? 0.5) * 4);
    if (skill.status === "proposed") score -= 40;
    if (skill.status === "rejected" || skill.status === "superseded") score -= 100;

    // When filters are provided, a skill must have an actual match signal
    // (hostname or tag overlap) — scope and source bonuses alone aren't a
    // reason to load a skill that has nothing to do with the current task.
    if (filtersProvided && !hasMatchSignal) continue;

    if (score >= minScore) {
      scored.push({ skill, score, reasons });
    }
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return sortByRelevance([a.skill, b.skill])[0] === a.skill ? -1 : 1;
  });

  return options.limit ? scored.slice(0, options.limit) : scored;
}
