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
    if (a.updatedAt > b.updatedAt) return -1;
    if (a.updatedAt < b.updatedAt) return 1;
    return 0;
  });
}
