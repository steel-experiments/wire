import type { ProposedAction } from "../shared/types.js";
import { safeParseBoundary, proposedActionSchema } from "../shared/schemas.js";
import type { LoopState } from "./loop.js";

// ---------------------------------------------------------------------------
// Action kinds the LLM is allowed to produce
// ---------------------------------------------------------------------------

const ACTION_KINDS: Set<string> = new Set([
  "observe",
  "exec",
  "raw",
  "request-approval",
  "branch-experiment",
  "load-skill",
  "propose-skill",
  "finish",
]);

export function registerActionKind(kind: string): void {
  ACTION_KINDS.add(kind);
}

export { ACTION_KINDS };

// ---------------------------------------------------------------------------
// parseActionFromLlm — extract a ProposedAction from LLM text output
// ---------------------------------------------------------------------------

export function parseActionFromLlm(content: string, state: LoopState): ProposedAction {
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/u);
  const candidates = [
    jsonMatch?.[1],
    content.trim(),
    extractFirstJsonObject(content),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const parsed = tryParseAction(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const hasObservation = state.events.some((event) => event.kind === "observation");

  if (!hasObservation) {
    return {
      kind: "observe",
      summary: "Observe current browser state",
    };
  }

  return {
    kind: "finish",
    summary: `Model returned an invalid action payload: ${content.slice(0, 400)}`,
  };
}

export function tryParseAction(content: string): ProposedAction | undefined {
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return undefined;
    }

    if (typeof parsed.kind !== "string" || !ACTION_KINDS.has(parsed.kind as ProposedAction["kind"])) {
      return undefined;
    }
    if (typeof parsed.summary !== "string") {
      return undefined;
    }

    const result = safeParseBoundary(proposedActionSchema, parsed, "llm-action");
    if (!result.success) {
      return undefined;
    }

    return result.data as ProposedAction;
  } catch {
    return undefined;
  }
}

export function extractFirstJsonObject(content: string): string | undefined {
  const start = content.indexOf("{");
  if (start === -1) return undefined;

  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0) return content.slice(start, i + 1);
  }
  return undefined;
}
