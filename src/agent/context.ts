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

export interface ContextBundle {
  task: TaskObjective;
  skills: SkillSummary[];
  observations: ObservationSummary[];
  recentTraces: TraceSummary[];
  policyNotes: string[];
  budget?: BudgetSummary;
}

// ---------------------------------------------------------------------------
// Prompt assembly
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/gu,
  /key[_-]?[a-zA-Z0-9]{16,}/giu,
  /token[_-]?[a-zA-Z0-9]{16,}/giu,
  /password\s*[:=]\s*\S+/giu,
  /bearer\s+[a-zA-Z0-9._-]+/giu,
];

function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
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

  // Loaded skills
  if (context.skills.length > 0) {
    const skillLines = context.skills.map(
      (s) => `- ${s.id} (${s.scope}): ${redactSecrets(s.matchReason)}`,
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

  if (sections.length === 0) {
    return "No context available yet. Proceed with the task objective.";
  }

  return sections.join("\n\n");
}
