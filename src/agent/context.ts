// ---------------------------------------------------------------------------
// Context assembly types
// ---------------------------------------------------------------------------

export interface TaskObjective {
  mode: string;
  objective: string;
  constraints: string[];
  successCriteria: string[];
}

export interface SkillSummary {
  id: string;
  scope: string;
  matchReason: string;
  guidance?: string;
}

export interface ObservationSummary {
  url: string;
  title: string;
  forms: number;
  buttons: number;
  dialogs: number;
  visibleTexts?: string[];
}

export interface TraceSummary {
  kind: string;
  summary: string;
}

export interface BudgetSummary {
  remaining: number;
  max: number;
  unit: string;
}

export interface StateDiffSummary {
  summary: string;
  consecutiveUnchanged: number;
}

export interface ContextBundle {
  task: TaskObjective;
  skills: SkillSummary[];
  observations: ObservationSummary[];
  recentTraces: TraceSummary[];
  policyNotes: string[];
  budget?: BudgetSummary;
  plan?: string;
  stateDiff?: StateDiffSummary;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

import { redactSecrets } from "../shared/redact.js";

// ---------------------------------------------------------------------------
// Context assembly types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Skill content sanitization — strip injection patterns before LLM injection
// ---------------------------------------------------------------------------

const INJECTION_LINE_PATTERN = /^(system|ignore previous|disregard|forget)\b/iu;
const SYSTEM_TAG_PATTERN = /<system>[\s\S]*?<\/system>/giu;
const SKILL_GUIDANCE_CHAR_LIMIT = 300;

export function sanitizeSkillContent(text: string): string {
  // Strip <system>...</system> blocks
  let result = text.replace(SYSTEM_TAG_PATTERN, "");

  // Strip injection-attempt lines
  result = result
    .split("\n")
    .filter((line) => !INJECTION_LINE_PATTERN.test(line))
    .join("\n");

  // Cap at char limit
  return result.slice(0, SKILL_GUIDANCE_CHAR_LIMIT);
}

/**
 * Build a compact system prompt from the context bundle.
 * No secrets appear in the output.
 */
export function assembleSystemPrompt(context: ContextBundle): string {
  const sections: string[] = [];

  // Role and task mode
  sections.push(`You are a browser automation agent running in ${context.task.mode} mode.`);
  sections.push("You have an active browser session. You MUST interact with the browser to complete tasks — never answer from prior knowledge.");
  sections.push(`Objective: ${redactSecrets(context.task.objective)}`);

  // Constraints
  if (context.task.constraints.length > 0) {
    sections.push(
      "Constraints:\n" + context.task.constraints.map((c) => `- ${redactSecrets(c)}`).join("\n"),
    );
  }

  // Success criteria
  if (context.task.successCriteria.length > 0) {
    sections.push(
      "Success criteria:\n" +
        context.task.successCriteria.map((c) => `- ${redactSecrets(c)}`).join("\n"),
    );
  }

  // Policy notes
  if (context.policyNotes.length > 0) {
    sections.push(
      "Policy notes:\n" +
        context.policyNotes.map((n) => `- ${redactSecrets(n)}`).join("\n"),
    );
  }

  // Budget
  if (context.budget) {
    const { remaining, max, unit } = context.budget;
    sections.push(`Budget: ${remaining}/${max} ${unit} remaining.`);
  }

  return sections.join("\n\n");
}

/**
 * Build a compact user message from observations, skills, and trace evidence.
 * No secrets appear in the output.
 */
export function assembleUserPrompt(context: ContextBundle): string {
  const sections: string[] = [];

  if (context.plan && context.plan.trim().length > 0) {
    sections.push(`Execution plan:\n${redactSecrets(context.plan)}`);
  }

  // Loaded skills
  if (context.skills.length > 0) {
    const skillLines = context.skills.map(
      (s) => {
        const base = `- ${s.id} (${s.scope}): ${redactSecrets(s.matchReason)}`;
        if (s.guidance && s.guidance.length > 0) {
          return `${base}\n  Guidance: ${redactSecrets(sanitizeSkillContent(s.guidance))}`;
        }
        return base;
      },
    );
    sections.push("Loaded skills:\n" + skillLines.join("\n"));
  }

  // Current observations
  if (context.observations.length > 0) {
    const obs = context.observations[context.observations.length - 1]!;
    const obsParts = [`Current page: ${obs.url}`];
    if (obs.title) {
      obsParts.push(`Title: ${obs.title}`);
    }
    obsParts.push(`Elements: ${obs.forms} forms, ${obs.buttons} buttons, ${obs.dialogs} dialogs`);
    if (obs.visibleTexts && obs.visibleTexts.length > 0) {
      obsParts.push(`Visible text: ${obs.visibleTexts.slice(0, 5).join(" | ")}`);
    }
    sections.push(obsParts.join("\n"));
  }

  // Recent traces
  if (context.recentTraces.length > 0) {
    const traceLines = context.recentTraces.slice(-5).map(
      (t) => `[${t.kind}] ${redactSecrets(t.summary)}`,
    );
    sections.push("Recent activity:\n" + traceLines.join("\n"));
  }

  // State diff
  if (context.stateDiff) {
    const diff = context.stateDiff;
    const diffParts = [`Last state change: ${diff.summary}`, `Consecutive unchanged observations: ${diff.consecutiveUnchanged}`];
    if (diff.consecutiveUnchanged >= 2) {
      diffParts.push("WARNING: Your last 2+ actions had no effect. Try a different approach: raw CDP input (Input.dispatchKeyEvent for trusted keypresses), click a specific element, or inspect the DOM more carefully.");
    }
    sections.push(diffParts.join("\n"));
  }

  if (sections.length === 0) {
    return "No context available yet. Proceed with the task objective.";
  }

  return sections.join("\n\n");
}
