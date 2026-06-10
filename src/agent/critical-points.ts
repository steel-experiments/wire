// ABOUTME: LLM-authored critical-point checklists and per-criterion completion review.
// The model decomposes the objective into atomic, independently-verifiable points; the
// reviewer judges evidence against each point instead of one all-or-nothing verdict.

import type { Task } from "../shared/types.js";
import type { ChatMessage, LLMProvider } from "../providers/llm/types.js";
import { extractFirstJsonArray } from "./llm-parse.js";

export interface CriticalPoint {
  /** Stable per-task id: cp1, cp2, … */
  id: string;
  text: string;
}

export interface CriterionVerdict {
  id: string;
  met: boolean;
  note?: string;
}

export interface CriticalPointReview {
  passed: boolean;
  points: CriticalPoint[];
  verdicts: CriterionVerdict[];
  /** Texts of the points judged unmet, for human-facing problem reporting. */
  unmet: string[];
}

const MAX_POINTS = 12;

/**
 * Parse an LLM response into critical points. Accepts a JSON array of strings
 * or of `{text}` objects, tolerates surrounding prose/code fences, and treats
 * "NONE" or unparseable content as an empty checklist (callers degrade
 * gracefully).
 */
export function parseCriticalPoints(content: string): CriticalPoint[] {
  const candidate = extractFirstJsonArray(content);
  if (!candidate) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const points: CriticalPoint[] = [];
  for (const item of parsed) {
    const raw = typeof item === "string"
      ? item
      : item && typeof item === "object" && typeof (item as { text?: unknown }).text === "string"
        ? (item as { text: string }).text
        : "";
    const text = raw.trim();
    if (text.length === 0) continue;
    points.push({ id: `cp${points.length + 1}`, text });
    if (points.length >= MAX_POINTS) break;
  }
  return points;
}

function objectiveBlock(task: Task): string {
  const lines = [`Objective: ${task.objective}`];
  if (task.constraints.length > 0) lines.push(`Constraints:\n- ${task.constraints.join("\n- ")}`);
  if (task.successCriteria.length > 0) lines.push(`Success criteria:\n- ${task.successCriteria.join("\n- ")}`);
  return lines.join("\n");
}

export function buildCriticalPointsPrompt(task: Task): ChatMessage[] {
  return [
    {
      role: "system",
      content: [
        "You decompose a browser-task objective into critical points: the atomic,",
        "independently-verifiable requirements that must each hold for the task to be",
        "complete. Each point is judged ONLY by reading the agent's final result and",
        "produced artifacts, so write points that are decidable from that output alone:",
        "a value extracted, a required field present, an item count met, a constraint",
        "or format satisfied, no placeholder text.",
        "Do NOT write points whose truth depends on anything outside the output:",
        "navigation or the path taken, clicks, logging in, or whether the output",
        "matches the live page or external ground truth (the reviewer cannot reopen the",
        "site, so 'these really are the current top results' is not checkable).",
        "Reachability is verified separately. Do NOT require an exact presentation",
        "format when the requested data itself is present.",
        "Return ONLY a JSON array of short strings, one per critical point. If the",
        "objective has no verifiable outcome beyond 'do it', respond with exactly: NONE.",
        "Do not wrap the array in prose or code fences.",
      ].join("\n"),
    },
    { role: "user", content: objectiveBlock(task) },
  ];
}

/**
 * Ask the model to enumerate the task's critical points. Never throws: on any
 * LLM or parse failure it returns an empty checklist so the caller falls back
 * to its deterministic contract.
 */
export async function proposeCriticalPoints(task: Task, llm: LLMProvider): Promise<CriticalPoint[]> {
  try {
    const response = await llm.chat(buildCriticalPointsPrompt(task), { maxTokens: 500 });
    return parseCriticalPoints(response.content);
  } catch {
    return [];
  }
}

export function criticalPointsToChecklist(points: CriticalPoint[]): string {
  if (points.length === 0) return "";
  return ["Critical points (each must be satisfied):", ...points.map((p) => `- [ ] ${p.id}: ${p.text}`)].join("\n");
}

export function buildCriterionReviewPrompt(
  points: CriticalPoint[],
  objective: string,
  evidence: string,
): ChatMessage[] {
  const checklist = points.map((p) => `${p.id}: ${p.text}`).join("\n");
  return [
    {
      role: "system",
      content: [
        "You are a strict completion reviewer for a browser agent. The evidence is the",
        "agent's final result and produced artifacts. For each critical point, decide",
        "whether that evidence clearly satisfies it; when it is genuinely ambiguous or",
        "only partial, mark the point as not met.",
        "Judge only the substance of the result and artifacts. Navigation and the",
        "agent's process are verified separately — never mark a point unmet merely",
        "because the path taken or pages visited are not shown, and you cannot reopen",
        "the site to re-confirm the output against the live page. When the requested",
        "data is present, do not fail a point over its exact presentation format.",
        'Return ONLY a JSON array of {"id": string, "met": boolean, "note": string},',
        "one entry per critical point id. Do not wrap it in prose or code fences.",
      ].join("\n"),
    },
    {
      role: "user",
      content: `Objective: ${objective}\n\nCritical points:\n${checklist}\n\nEvidence:\n${evidence}`,
    },
  ];
}

/**
 * Parse per-criterion verdicts, keyed by point id. Any point without an
 * explicit `met: true` verdict defaults to unmet — a missing or malformed
 * verdict never silently passes a requirement.
 */
// A met flag is satisfied by the boolean `true` or the common string forms
// models emit ("true"/"yes", any case). Anything else is treated as unmet.
function isMet(value: unknown): boolean {
  if (value === true) return true;
  return typeof value === "string" && /^(true|yes)$/iu.test(value.trim());
}

export function parseCriterionVerdicts(content: string, points: CriticalPoint[]): CriterionVerdict[] {
  // Key by lowercased id so a case-mismatched response id ("CP1" vs "cp1")
  // still matches its point instead of defaulting to unmet.
  const byId = new Map<string, { met: boolean; note?: string }>();
  const candidate = extractFirstJsonArray(content);
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const obj = item as { id?: unknown; met?: unknown; note?: unknown };
          if (typeof obj.id !== "string") continue;
          const entry: { met: boolean; note?: string } = { met: isMet(obj.met) };
          const note = typeof obj.note === "string" ? obj.note.trim() : "";
          if (note.length > 0) entry.note = note;
          byId.set(obj.id.toLowerCase(), entry);
        }
      }
    } catch {
      // Fall through to all-unmet defaults below.
    }
  }
  return points.map((point) => {
    const found = byId.get(point.id.toLowerCase());
    const verdict: CriterionVerdict = { id: point.id, met: found?.met === true };
    if (found?.note !== undefined) verdict.note = found.note;
    return verdict;
  });
}

export function summarizeCriticalPointReview(
  points: CriticalPoint[],
  verdicts: CriterionVerdict[],
): CriticalPointReview {
  const metById = new Map(verdicts.map((v) => [v.id, v.met]));
  const unmet = points.filter((p) => metById.get(p.id) !== true).map((p) => p.text);
  // No checklist → nothing to gate on; pass so this never blocks a task that
  // had no verifiable critical points.
  const passed = points.length === 0 ? true : unmet.length === 0;
  return { passed, points, verdicts, unmet };
}

/**
 * Judge evidence against the critical-point checklist. Never throws: an LLM or
 * parse failure degrades to a passing review so reviewer trouble can't block a
 * completed task (mirrors the artifact reviewer's skip-on-unparseable stance).
 */
export async function reviewCriticalPoints(
  task: Task,
  points: CriticalPoint[],
  evidence: string,
  llm: LLMProvider,
): Promise<CriticalPointReview> {
  if (points.length === 0) return { passed: true, points, verdicts: [], unmet: [] };
  try {
    const response = await llm.chat(buildCriterionReviewPrompt(points, task.objective, evidence), { maxTokens: 700 });
    const verdicts = parseCriterionVerdicts(response.content, points);
    return summarizeCriticalPointReview(points, verdicts);
  } catch {
    return { passed: true, points, verdicts: [], unmet: [] };
  }
}
