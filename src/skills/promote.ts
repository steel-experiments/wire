import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type {
  RunId,
  SkillId,
  TraceEvent,
} from "../shared/types.js";
import type { LLMProvider, ChatMessage } from "../providers/llm/openai.js";

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

// ---------------------------------------------------------------------------
// Trace serialization for LLM
// ---------------------------------------------------------------------------

const SKIP_KINDS = new Set(["skill-load", "policy-check", "skill-proposal", "approval-request"]);

/**
 * Serialize trace events into a compact one-line-per-event format suitable
 * for an LLM prompt.
 */
export function serializeTraceForLLM(events: TraceEvent[]): string {
  const lines: string[] = [];

  for (const event of events) {
    if (SKIP_KINDS.has(event.kind)) continue;

    switch (event.kind) {
      case "observation": {
        const url = String(event.payload["url"] ?? "");
        const title = String(event.payload["title"] ?? "");
        lines.push(`[observation] url=${url} title=${title}`);
        break;
      }
      case "code-exec": {
        const code = String(event.payload["code"] ?? "").slice(0, 500);
        lines.push(`[code-exec] ${code}`);
        break;
      }
      case "code-result": {
        const ok = event.payload["ok"];
        if (ok) {
          const stdout = String(event.payload["stdout"] ?? "").slice(0, 200);
          lines.push(`[code-result] ok=true stdout=${stdout}`);
        } else {
          const error = String(event.payload["stderr"] ?? event.payload["error"] ?? "").slice(0, 200);
          lines.push(`[code-result] ok=false error=${error}`);
        }
        break;
      }
      case "thought-summary": {
        const text = String(event.payload["summary"] ?? event.payload["reason"] ?? "");
        lines.push(`[thought-summary] ${text}`);
        break;
      }
      case "error": {
        const message = String(event.payload["message"] ?? "");
        lines.push(`[error] ${message.slice(0, 200)}`);
        break;
      }
      default: {
        const summary = String(event.payload["summary"] ?? event.kind);
        lines.push(`[${event.kind}] ${summary.slice(0, 200)}`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// LLM response parsing
// ---------------------------------------------------------------------------

/**
 * Parse the LLM response content into a `PromotionCandidate`, or `null` if
 * the LLM indicated no proposal or the output is unparseable.
 */
export function parseSkillProposalResponse(
  content: string,
  runId: RunId,
): PromotionCandidate | null {
  const trimmed = content.trim();

  if (trimmed === "NONE") return null;

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Fall back to extracting the first {…} block
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end === -1 || end <= start) return null;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }

  if (typeof parsed.hostname !== "string" || !parsed.hostname) return null;

  const confidence = typeof parsed.confidence === "number"
    ? Math.max(0, Math.min(1, Math.round(parsed.confidence * 100) / 100))
    : 0.5;

  return {
    skillId: createId("skill"),
    hostname: parsed.hostname,
    facts: Array.isArray(parsed.facts) ? parsed.facts.filter((f: unknown) => typeof f === "string") : [],
    selectors: Array.isArray(parsed.selectors) ? parsed.selectors.filter((s: unknown) => typeof s === "string") : [],
    routes: Array.isArray(parsed.routes) ? parsed.routes.filter((r: unknown) => typeof r === "string") : [],
    waits: Array.isArray(parsed.waits) ? parsed.waits.filter((w: unknown) => typeof w === "string") : [],
    traps: Array.isArray(parsed.traps) ? parsed.traps.filter((t: unknown) => typeof t === "string") : [],
    confidence,
    sourceRunId: runId,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ask the LLM to propose a reusable skill from a completed run's trace.
 * Returns a `PromotionCandidate` if the LLM identifies reusable knowledge,
 * or `null` otherwise. Never throws — errors are caught and return `null`.
 */
export async function llmProposeSkill(
  events: TraceEvent[],
  runId: RunId,
  llmProvider: LLMProvider,
): Promise<PromotionCandidate | null> {
  try {
    const trace = serializeTraceForLLM(events);

    // Extract the task objective from thought-summary or the task itself
    const objective = events
      .filter((e) => e.kind === "thought-summary" && e.payload["kind"] === "finish")
      .map((e) => String(e.payload["summary"] ?? ""))
      .join("; ") || "browser automation task";

    const systemPrompt = [
      "You are a skill-distillation agent for a browser automation framework called Wire.",
      "Given a trace of events from a completed run, decide whether there is reusable browser knowledge worth saving as a skill file.",
      "If the trace contains useful domain knowledge (routes, selectors, wait patterns, common pitfalls), return a JSON object with this shape:",
      '{"hostname":"example.com","facts":["..."],"selectors":["..."],"routes":["..."],"waits":["..."],"traps":["..."],"confidence":0.8}',
      "If nothing is worth saving, respond with exactly: NONE",
      "Do not wrap the JSON in prose or code fences.",
    ].join("\n");

    const userPrompt = `Trace from a successful run (objective: ${objective}):\n\n${trace}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ];

    const response = await llmProvider.chat(messages, { maxTokens: 500 });

    return parseSkillProposalResponse(response.content, runId);
  } catch {
    return null;
  }
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
