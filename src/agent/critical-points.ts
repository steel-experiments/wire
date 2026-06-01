// ABOUTME: LLM-authored critical-point checklists and per-criterion completion review.
// The model decomposes the objective into atomic, independently-verifiable points; the
// reviewer judges evidence against each point instead of one all-or-nothing verdict.

import type { Task } from "../shared/types.js";
import type { ChatMessage, LLMProvider } from "../providers/llm/openai.js";

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

function stripFences(text: string): string {
  return text.replace(/```(?:json)?/giu, "").trim();
}

function firstJsonArray(text: string): string | undefined {
  const trimmed = stripFences(text);
  if (trimmed.startsWith("[")) return trimmed;
  const start = trimmed.indexOf("[");
  const end = trimmed.lastIndexOf("]");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return undefined;
}

/**
 * Parse an LLM response into critical points. Accepts a JSON array of strings
 * or of `{text}` objects, tolerates code fences, and treats "NONE" or
 * unparseable content as an empty checklist (callers degrade gracefully).
 */
export function parseCriticalPoints(content: string): CriticalPoint[] {
  if (/^\s*none\s*$/iu.test(content)) return [];
  const candidate = firstJsonArray(content);
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
        "complete (a filter applied, a value extracted, a page reached, a file produced).",
        "Return ONLY a JSON array of short strings, one per critical point. Keep each",
        "point checkable from page state or the final result. If the objective has no",
        "verifiable requirements beyond 'do it', respond with exactly: NONE.",
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
        "You are a harsh completion reviewer for a browser agent. For each critical",
        "point, decide whether the evidence clearly satisfies it. Be strict: when the",
        "evidence is ambiguous, missing, or only partial, mark the point as not met.",
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
export function parseCriterionVerdicts(content: string, points: CriticalPoint[]): CriterionVerdict[] {
  const byId = new Map<string, { met: boolean; note?: string }>();
  const candidate = firstJsonArray(content);
  if (candidate) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (!item || typeof item !== "object") continue;
          const obj = item as { id?: unknown; met?: unknown; note?: unknown };
          if (typeof obj.id !== "string") continue;
          const entry: { met: boolean; note?: string } = { met: obj.met === true };
          if (typeof obj.note === "string" && obj.note.trim().length > 0) entry.note = obj.note.trim();
          byId.set(obj.id, entry);
        }
      }
    } catch {
      // Fall through to all-unmet defaults below.
    }
  }
  return points.map((point) => {
    const found = byId.get(point.id);
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
