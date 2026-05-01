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
  headings?: string[];
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
  repeatSignal?: { sameSig: number; sameResult: number; noProgress: number };
  sessionCapabilities?: Record<string, unknown>;
  providerActions?: Array<{ kind: string; description: string }>;
}

import { redactSecrets } from "../shared/redact.js";

const INJECTION_LINE_PATTERN = /^(system|ignore previous|disregard|forget)\b/iu;
const SYSTEM_TAG_PATTERN = /<system>[\s\S]*?<\/system>/giu;
const SKILL_GUIDANCE_CHAR_LIMIT = 1000;

export function sanitizeSkillContent(text: string): string {
  let result = text.replace(SYSTEM_TAG_PATTERN, "");

  result = result
    .split("\n")
    .filter((line) => !INJECTION_LINE_PATTERN.test(line))
    .join("\n");

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
    sections.push("Loaded skills:\nSite-specific; follow their Workflow and Traps before guessing.\n" + skillLines.join("\n"));
  }

  // Current observations
  if (context.observations.length > 0) {
    const obs = context.observations[context.observations.length - 1]!;
    const obsParts = [`Current page: ${obs.url}`];
    if (obs.title) {
      obsParts.push(`Title: ${obs.title}`);
    }
    obsParts.push(`Elements: ${obs.forms} forms, ${obs.buttons} buttons, ${obs.dialogs} dialogs`);
    if (obs.headings && obs.headings.length > 0) {
      obsParts.push(`Headings: ${obs.headings.join(" | ")}`);
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

  if (context.repeatSignal) {
    const { sameSig, sameResult, noProgress } = context.repeatSignal;
    if (noProgress >= 2) sections.push(`STALLED: Your last ${noProgress} successful execs returned no usable data (empty payloads, navigation-only, or error-shaped). Stop probing the same way — extract real content (innerText, attributes, structured DOM) or pivot to a different page.`);
    else if (sameResult >= 3) sections.push(`STUCK: You ran the same exec code ${sameSig} times in a row and got the same result ${sameResult} times. Stop probing — change strategy now or the run will be aborted.`);
    else if (sameSig >= 4) sections.push(`REPEATING: You ran the same exec code ${sameSig} times in a row. If this isn't progressing, switch to a different selector, action, or approach.`);
  }

  // Session capabilities (generic rendering)
  if (context.sessionCapabilities) {
    const entries = Object.entries(context.sessionCapabilities).filter(
      ([, v]) => v !== undefined,
    );
    if (entries.length > 0) {
      const parts = entries.map(([k, v]) => `- ${k}: ${JSON.stringify(v)}`);
      sections.push("Current session capabilities:\n" + parts.join("\n"));
    }
  }

  if (sections.length === 0) {
    return "No context available yet. Proceed with the task objective.";
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Action guidance — LLM-facing instructions for available actions
// ---------------------------------------------------------------------------

const BASE_ACTION_GUIDANCE = [
  "Return exactly one next action as JSON.",
  'For "observe", omit payload unless you need {"targetId":"..."}',
  'For "exec", set payload.code to JavaScript that runs in the browser. Code is auto-wrapped as (async () => { YOUR_CODE })(). Do NOT wrap your code in another IIFE; use top-level `return` to output results.',
  "Each exec call defaults to a 12-second CDP timeout and payload.timeoutMs is capped at 12000. Keep scripts short; avoid sleep/poll loops. For long sequences, split across turns or return wireActions.",
  'For "raw", set payload.method to a CDP method and payload.params to its parameters. Use raw only when exec cannot reach the needed browser behavior.',
  '"exec" code can return {wireActions: [{method, params}, ...]} to send CDP commands after the code runs. Keep wireActions batches under 80 commands; send another action after reading state.',
  "Observation gives you orientation (URL, title, headings, element counts) — NOT page content. To read page content, write exec code (e.g. return document.body.innerText or query specific selectors).",
  "Prefer direct URL patterns before brittle DOM hunting when the destination is obvious.",
  "For web search tasks, use DuckDuckGo (duckduckgo.com) or Bing (bing.com). Google blocks headless browsers with captchas.",
  "Wire auto-observes after navigation code. Do NOT emit a separate observe after navigating.",
  "After navigating to a target page, always exec code to extract the answer before finishing. Navigation alone is not task completion.",
  "Only use finish after your exec code has returned the actual answer in its return value.",
  "Use reusable routes, selectors, waits, and traps from loaded skills when they apply.",
  "Do not wrap the JSON in prose.",
];

export function buildActionGuidance(context: ContextBundle): string {
  const coreKinds = ["observe", "exec", "raw", "finish"];
  const providerKinds = (context.providerActions ?? []).map((a) => a.kind);
  const allKinds = [...coreKinds, ...providerKinds].join("|");

  const lines = [
    `Use this shape: {"kind":"${allKinds}","summary":"short text","payload":{...}}.`,
    ...BASE_ACTION_GUIDANCE,
  ];

  // Add provider action descriptions
  for (const action of context.providerActions ?? []) {
    lines.push(action.description);
  }

  if (context.skills.length > 0) {
    lines.push("When loaded skills provide workflow steps, follow the applicable durable guidance before inventing new selectors.");
  }

  if (context.stateDiff && context.stateDiff.consecutiveUnchanged >= 2) {
    lines.push("Your last actions did not change observable state. Try a materially different executable approach.");
  }

  return lines.join("\n");
}
