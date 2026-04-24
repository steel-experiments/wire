import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type {
  RunId,
  SkillId,
  TraceEvent,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A reusable finding extracted from a completed run. */
export interface PromotionCandidate {
  skillId: SkillId;
  hostname: string;
  facts: string[];
  selectors: string[];
  routes: string[];
  waits: string[];
  traps: string[];
  confidence: number;
  sourceRunId: RunId;
}

// ---------------------------------------------------------------------------
// Secret detection
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/iu,
  /(?:api[_-]?key|apikey)\s*[:=]\s*\S+/iu,
  /(?:secret|token|bearer)\s*[:=]\s*\S+/iu,
  /(?:auth[_-]?token|accesstoken|refresh[_-]?token)\s*[:=]\s*\S+/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bsk-[a-zA-Z0-9]{20,}\b/u,
  /\b(?:GH[pousr])_[A-Za-z0-9_]{36,}\b/u,
];

/**
 * Check whether `content` contains common secret patterns.
 * Returns `true` if any pattern matches.
 */
export function containsSecrets(content: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(content));
}

// ---------------------------------------------------------------------------
// Pattern extraction helpers
// ---------------------------------------------------------------------------

function extractHostname(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

interface FactEntry {
  hostname: string;
  count: number;
}

/**
 * Scan observation events for repeated successful observations of the same
 * hostname. A hostname observed 2+ times becomes a "fact".
 */
function extractFacts(events: TraceEvent[]): Map<string, FactEntry> {
  const hostCounts = new Map<string, FactEntry>();

  for (const event of events) {
    if (event.kind !== "observation") continue;

    const url = event.payload["url"];
    if (typeof url !== "string") continue;

    const hostname = extractHostname(url);
    if (hostname === null) continue;

    const existing = hostCounts.get(hostname);
    if (existing) {
      existing.count += 1;
    } else {
      hostCounts.set(hostname, { hostname, count: 1 });
    }
  }

  return hostCounts;
}

/**
 * Extract repeated CSS selectors from code-exec payloads.
 * Selectors used 2+ times across different events are considered reusable.
 */
function extractSelectors(events: TraceEvent[]): string[] {
  const selectorCounts = new Map<string, number>();

  for (const event of events) {
    if (event.kind !== "code-exec") continue;

    const code = event.payload["code"];
    if (typeof code !== "string") continue;

    // Naive extraction: look for querySelector / $ calls with string literals.
    const selectorRegex = /(?:querySelector|querySelectorAll|\$\$?)\(\s*['"]([^'"]+)['"]\s*\)/gu;
    let match: RegExpExecArray | null;
    while ((match = selectorRegex.exec(code)) !== null) {
      const sel = match[1]!;
      const current = selectorCounts.get(sel) ?? 0;
      selectorCounts.set(sel, current + 1);
    }
  }

  // Keep selectors used 2+ times
  const results: string[] = [];
  for (const [selector, count] of selectorCounts) {
    if (count >= 2) {
      results.push(selector);
    }
  }

  return results;
}

/**
 * Extract successful navigation routes from observation events.
 * Each unique URL path on the same hostname forms a "route".
 */
function extractRoutes(
  events: TraceEvent[],
  hostname: string,
): string[] {
  const routes = new Set<string>();

  for (const event of events) {
    if (event.kind !== "observation") continue;

    const url = event.payload["url"];
    if (typeof url !== "string") continue;

    const parsed = extractHostname(url);
    if (parsed !== hostname) continue;

    try {
      const path = new URL(url).pathname;
      if (path.length > 1) {
        routes.add(path);
      }
    } catch {
      // Skip malformed URLs
    }
  }

  return [...routes];
}

/**
 * Extract common wait patterns from code-exec events.
 * Looks for waitFor, waitForSelector, waitForNavigation patterns.
 */
function extractWaits(events: TraceEvent[]): string[] {
  const waitCounts = new Map<string, number>();

  for (const event of events) {
    if (event.kind !== "code-exec") continue;

    const code = event.payload["code"];
    if (typeof code !== "string") continue;

    const waitRegex =
      /waitFor(?:Selector|Navigation|Timeout)?\(\s*['"]([^'"]+)['"]\s*/gu;
    let match: RegExpExecArray | null;
    while ((match = waitRegex.exec(code)) !== null) {
      const pattern = match[1]!;
      const current = waitCounts.get(pattern) ?? 0;
      waitCounts.set(pattern, current + 1);
    }
  }

  const results: string[] = [];
  for (const [pattern, count] of waitCounts) {
    if (count >= 2) {
      results.push(pattern);
    }
  }

  return results;
}

/**
 * Extract common failure/trap patterns from error and code-result events.
 */
function extractTraps(events: TraceEvent[]): string[] {
  const traps = new Set<string>();

  for (const event of events) {
    if (event.kind === "error") {
      const message = event.payload["message"];
      if (typeof message === "string" && message.length > 0) {
        // Normalise to a short representative snippet
        const snippet = message.split("\n")[0]!.slice(0, 120);
        traps.add(snippet);
      }
    }

    if (event.kind === "code-result") {
      const ok = event.payload["ok"];
      const stderr = event.payload["stderr"];
      if (ok === false && typeof stderr === "string" && stderr.length > 0) {
        const snippet = stderr.split("\n")[0]!.slice(0, 120);
        traps.add(snippet);
      }
    }
  }

  return [...traps];
}

/**
 * Compute a rough confidence score for a candidate based on the density of
 * patterns found relative to total events.
 */
function computeConfidence(
  factsCount: number,
  selectorsCount: number,
  routesCount: number,
  waitsCount: number,
  trapsCount: number,
  totalEvents: number,
): number {
  if (totalEvents === 0) return 0;

  const signalCount =
    factsCount + selectorsCount + routesCount + waitsCount + trapsCount;

  // Each signal contributes; cap at 1.0
  const raw = Math.min(signalCount / Math.max(totalEvents * 0.3, 1), 1);
  // Round to two decimal places
  return Math.round(raw * 100) / 100;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan a run's trace events for repeated patterns that could be promoted to a
 * reusable skill. Returns one `PromotionCandidate` per hostname that yielded
 * actionable patterns, or an empty array if nothing is worth promoting.
 */
export function detectPromotionCandidates(
  events: TraceEvent[],
  runId: RunId,
): PromotionCandidate[] {
  if (events.length === 0) return [];

  const factsMap = extractFacts(events);
  const selectors = extractSelectors(events);
  const waits = extractWaits(events);
  const traps = extractTraps(events);

  const candidates: PromotionCandidate[] = [];

  for (const entry of factsMap.values()) {
    if (entry.count < 2) continue;

    const hostname = entry.hostname;
    const routes = extractRoutes(events, hostname);

    const confidence = computeConfidence(
      1, // this hostname is a fact
      selectors.length,
      routes.length,
      waits.length,
      traps.length,
      events.length,
    );

    // Only promote if there is at least some signal beyond just visiting a page
    const hasSignal =
      selectors.length > 0 ||
      routes.length > 0 ||
      waits.length > 0 ||
      traps.length > 0;

    if (!hasSignal && confidence < 0.3) continue;

    const skillId = createId("skill");

    candidates.push({
      skillId,
      hostname,
      facts: [`Observed ${entry.count} successful interactions on ${hostname}`],
      selectors,
      routes,
      waits,
      traps,
      confidence,
      sourceRunId: runId,
    });
  }

  return candidates;
}

/**
 * Generate a skill proposal as a markdown document with YAML frontmatter.
 * The output is suitable for writing to a skill directory for human review.
 */
export function generateSkillProposal(candidate: PromotionCandidate): string {
  const lines: string[] = [];

  lines.push("---");
  lines.push(`id: ${candidate.skillId}`);
  lines.push(`scope: domain`);
  lines.push(`source: generated`);
  lines.push(`tags:`);
  lines.push(`  - auto-promoted`);
  lines.push(`  - ${candidate.hostname}`);
  lines.push(`updatedAt: ${nowIsoUtc()}`);
  if (candidate.hostname) {
    lines.push(`hostnamePatterns:`);
    lines.push(`  - "${candidate.hostname}"`);
  }
  lines.push("---");
  lines.push("");
  lines.push(
    `# Skill Proposal: ${candidate.hostname}`,
  );
  lines.push("");
  lines.push(
    `Auto-generated from run \`${candidate.sourceRunId}\` with confidence ${candidate.confidence}.`,
  );
  lines.push("");

  if (candidate.facts.length > 0) {
    lines.push("## Facts");
    lines.push("");
    for (const fact of candidate.facts) {
      lines.push(`- ${fact}`);
    }
    lines.push("");
  }

  if (candidate.selectors.length > 0) {
    lines.push("## Selectors");
    lines.push("");
    for (const sel of candidate.selectors) {
      lines.push(`- \`${sel}\``);
    }
    lines.push("");
  }

  if (candidate.routes.length > 0) {
    lines.push("## Routes");
    lines.push("");
    for (const route of candidate.routes) {
      lines.push(`- \`${route}\``);
    }
    lines.push("");
  }

  if (candidate.waits.length > 0) {
    lines.push("## Wait Patterns");
    lines.push("");
    for (const wait of candidate.waits) {
      lines.push(`- \`${wait}\``);
    }
    lines.push("");
  }

  if (candidate.traps.length > 0) {
    lines.push("## Known Traps");
    lines.push("");
    for (const trap of candidate.traps) {
      lines.push(`- ${trap}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Write a promoted skill file to the given skill directory.
 *
 * Before writing, the proposal content is scanned for secrets. If any are
 * found the write is aborted and an error is thrown.
 *
 * Returns the absolute path of the written file.
 */
export async function promoteSkill(
  candidate: PromotionCandidate,
  skillDir: string,
): Promise<string> {
  const content = generateSkillProposal(candidate);

  if (containsSecrets(content)) {
    throw new Error(
      `Refusing to promote skill ${candidate.skillId}: secret patterns detected in generated content.`,
    );
  }

  const fileName = `${candidate.hostname.replace(/\./gu, "_")}-${candidate.skillId.slice(0, 16)}.md`;
  const filePath = join(skillDir, fileName);

  const { ensureDir } = await import("../storage/atomic.js");
  await ensureDir(skillDir);
  await writeFile(filePath, content, "utf-8");

  return filePath;
}
