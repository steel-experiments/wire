import type { ProfileId, ProviderKind, TaskMode } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileConfig {
  id: ProfileId;
  name: string;
  provider: ProviderKind;
  privileged?: boolean;
  hostnamePatterns?: string[];
  usageHistory?: { taskCount: number; lastUsed: string };
}

export interface ProfileSelection {
  profile: ProfileConfig;
  reason: string;
}

// ---------------------------------------------------------------------------
// Hostname pattern matching
// ---------------------------------------------------------------------------

/**
 * Check whether a hostname matches a simple pattern.
 * Supports wildcard prefix: `"*.example.com"` matches `"sub.example.com"`.
 */
function hostnameMatches(pattern: string, hostname: string): boolean {
  const p = pattern.toLowerCase();
  const h = hostname.toLowerCase();

  if (p.startsWith("*.")) {
    const suffix = p.slice(1); // ".example.com"
    return h.endsWith(suffix) || h === p.slice(2);
  }

  return h === p;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/**
 * Score a profile for a given task mode and optional hostname.
 * Higher scores indicate better matches. A score of 0 means no match.
 */
function scoreProfile(
  profile: ProfileConfig,
  taskMode: TaskMode,
  hostname?: string,
): number {
  let score = 0;

  // Privileged profiles are generally preferred for "task" mode where the
  // agent has a clear objective and may need elevated access.
  if (taskMode === "task" && profile.privileged === true) {
    score += 2;
  }

  // For "experiment" and "investigate" modes, prefer non-privileged profiles
  // to limit blast radius.
  if (
    (taskMode === "experiment" || taskMode === "investigate") &&
    profile.privileged !== true
  ) {
    score += 2;
  }

  // Hostname pattern match is a strong signal
  if (
    hostname !== undefined &&
    hostname.length > 0 &&
    profile.hostnamePatterns &&
    profile.hostnamePatterns.length > 0
  ) {
    const matches = profile.hostnamePatterns.some((pattern) =>
      hostnameMatches(pattern, hostname),
    );
    if (matches) {
      score += 5;
    }
  }

  // Usage history: prefer profiles that have been used successfully before
  if (profile.usageHistory) {
    score += Math.min(profile.usageHistory.taskCount, 10);
  }

  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Select the best profile from the available profiles for a given task mode
 * and optional target hostname.
 *
 * Selection criteria (in priority order):
 * 1. Hostname pattern match (strongest signal)
 * 2. Privilege level appropriate for task mode
 * 3. Usage history (prefer previously-used profiles)
 *
 * Returns `null` if no profiles are available.
 */
export function selectProfile(
  available: ProfileConfig[],
  taskMode: TaskMode,
  hostname?: string,
): ProfileSelection | null {
  if (available.length === 0) return null;

  let bestProfile: ProfileConfig | null = null;
  let bestScore = -1;
  let bestReason = "";

  for (const profile of available) {
    const score = scoreProfile(profile, taskMode, hostname);

    if (score > bestScore) {
      bestScore = score;
      bestProfile = profile;

      const reasons: string[] = [];
      reasons.push(`score ${score}`);

      if (
        hostname !== undefined &&
        hostname.length > 0 &&
        profile.hostnamePatterns &&
        profile.hostnamePatterns.length > 0 &&
        profile.hostnamePatterns.some((p) => hostnameMatches(p, hostname))
      ) {
        reasons.push("hostname match");
      }

      if (taskMode === "task" && profile.privileged === true) {
        reasons.push("privileged for task mode");
      }

      if (
        (taskMode === "experiment" || taskMode === "investigate") &&
        profile.privileged !== true
      ) {
        reasons.push("non-privileged for safety");
      }

      if (profile.usageHistory) {
        reasons.push(
          `used ${profile.usageHistory.taskCount} times previously`,
        );
      }

      bestReason = `Selected ${profile.name}: ${reasons.join(", ")}`;
    }
  }

  if (bestProfile === null) return null;

  return {
    profile: bestProfile,
    reason: bestReason,
  };
}

/**
 * Check whether a profile requires explicit human approval before it can be
 * used for privileged operations (e.g. financial transactions, account
 * modifications, data exports).
 *
 * A profile requires approval if it is marked as privileged.
 */
export function requiresApproval(profile: ProfileConfig): boolean {
  return profile.privileged === true;
}
