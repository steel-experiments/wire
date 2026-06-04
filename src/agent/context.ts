import type { JsonObject } from "../shared/types.js";

export interface TaskObjective {
  mode: string;
  objective: string;
  constraints: string[];
  successCriteria: string[];
  /** Exploration guidance for an experiment-mode branch run. */
  branchDirective?: string;
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
  targetId?: string;
  tabs?: Array<{ id: string; url: string; title: string }>;
  tabDrift?: string;
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

export interface ObjectiveOverride {
  newObjective: string;
  originalObjective: string;
}

export interface UrlEvidence {
  url: string;
  content: string;
}

export interface ContextBundle {
  task: TaskObjective;
  skills: SkillSummary[];
  observations: ObservationSummary[];
  recentTraces: TraceSummary[];
  policyNotes: string[];
  budget?: BudgetSummary;
  plan?: string;
  contract?: string;
  stateDiff?: StateDiffSummary;
  repeatSignal?: { sameSig: number; sameResult: number; noProgress: number };
  sessionCapabilities?: Record<string, unknown>;
  providerActions?: Array<{ kind: string; description: string }>;
  /** Last N user messages, newest first. */
  userMessages?: string[];
  /** When set, the user has redirected the task to a new objective. */
  objectiveOverride?: ObjectiveOverride;
  /** Latest substantive extraction per URL visited this run. Lets the agent
   *  reuse what it has already pulled instead of re-navigating to re-extract. */
  evidence?: UrlEvidence[];
  /** Model-authored structured evidence accumulated across actions. */
  progressLedger?: JsonObject[];
  /** Concrete reviewer failures that must be repaired before finishing. */
  repairInstructions?: string[];
}

import { redactSecrets } from "../shared/redact.js";
import {
  ACTIVE_BROWSER_SYSTEM_GUIDANCE,
  BASE_ACTION_GUIDANCE,
  LOADED_SKILLS_GUIDANCE,
  NO_CONTEXT_PROMPT,
  STATE_UNCHANGED_WARNING,
  USER_MESSAGE_GUIDANCE,
  repeatingPrompt,
  stalledPrompt,
  stuckPrompt,
} from "./prompts.js";

const INJECTION_LINE_PATTERN = /^(system|ignore previous|disregard|forget)\b/iu;
const SYSTEM_TAG_PATTERN = /<system>[\s\S]*?<\/system>/giu;
const SKILL_GUIDANCE_CHAR_LIMIT = 1000;

export function stripInjectionPatterns(text: string): string {
  let result = text.replace(SYSTEM_TAG_PATTERN, "");
  result = result
    .split("\n")
    .filter((line) => !INJECTION_LINE_PATTERN.test(line))
    .join("\n");
  return result;
}

export function sanitizeSkillContent(text: string): string {
  return stripInjectionPatterns(text).slice(0, SKILL_GUIDANCE_CHAR_LIMIT);
}

/**
 * Build a compact system prompt from the context bundle.
 * No secrets appear in the output.
 */
export function assembleSystemPrompt(context: ContextBundle): string {
  const sections: string[] = [];

  sections.push(`You are a browser automation agent running in ${context.task.mode} mode.`);
  sections.push(ACTIVE_BROWSER_SYSTEM_GUIDANCE);

  if (context.objectiveOverride) {
    sections.push(`Objective: ${redactSecrets(context.objectiveOverride.newObjective)}`);
    sections.push(`Previous objective (superseded by user redirect): ${redactSecrets(context.objectiveOverride.originalObjective)}`);
  } else {
    sections.push(`Objective: ${redactSecrets(context.task.objective)}`);
  }

  if (context.task.constraints.length > 0) {
    sections.push(
      "Constraints:\n" + context.task.constraints.map((c) => `- ${redactSecrets(c)}`).join("\n"),
    );
  }

  if (context.task.successCriteria.length > 0) {
    sections.push(
      "Success criteria:\n" +
        context.task.successCriteria.map((c) => `- ${redactSecrets(c)}`).join("\n"),
    );
  }

  if (context.task.branchDirective && context.task.branchDirective.trim().length > 0) {
    sections.push(
      `This is a branch run in an experiment. Branch directive: ${redactSecrets(context.task.branchDirective)}`,
    );
  }

  if (context.policyNotes.length > 0) {
    sections.push(
      "Policy notes:\n" +
        context.policyNotes.map((n) => `- ${redactSecrets(n)}`).join("\n"),
    );
  }

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

  if (context.userMessages && context.userMessages.length > 0) {
    const redirectActive = !!context.objectiveOverride;
    const framing = redirectActive ? USER_MESSAGE_GUIDANCE.redirected : USER_MESSAGE_GUIDANCE.direct;
    sections.push(
      "Recent user messages (most recent first):\n" +
        context.userMessages.map((m) => `- ${redactSecrets(m)}`).join("\n") +
        "\n\n" + framing,
    );
  }

  if (context.plan && context.plan.trim().length > 0) {
    sections.push(`Execution plan:\n${redactSecrets(context.plan)}`);
  }

  if (context.contract && context.contract.trim().length > 0) {
    sections.push(`Completion contract:\n${redactSecrets(context.contract)}`);
  }

  if (context.skills.length > 0) {
    const skillLines = context.skills.map(
      (s) => {
        const base = `- ${s.id} (${s.scope}): ${redactSecrets(s.matchReason)}`;
        if (s.guidance && s.guidance.length > 0) {
          return `${base}\n  Guidance: ${redactSecrets(s.guidance)}`;
        }
        return base;
      },
    );
    sections.push(LOADED_SKILLS_GUIDANCE + "\n" + skillLines.join("\n"));
  }

  if (context.observations.length > 0) {
    const obs = context.observations[context.observations.length - 1]!;
    const obsParts = [`Current page: ${obs.url}`];
    if (obs.title) {
      obsParts.push(`Title: ${obs.title}`);
    }
    if (obs.targetId) {
      obsParts.push(`Selected tab: ${obs.targetId}`);
    }
    if (obs.tabs && obs.tabs.length > 0) {
      const tabs = obs.tabs
        .slice(0, 6)
        .map((tab) => `${tab.id}: ${tab.title || tab.url || "(untitled)"}`)
        .join(" | ");
      obsParts.push(`Open tabs: ${tabs}`);
    }
    if (obs.tabDrift) {
      obsParts.push(`WARNING: ${obs.tabDrift}`);
    }
    obsParts.push(`Elements: ${obs.forms} forms, ${obs.buttons} buttons, ${obs.dialogs} dialogs`);
    if (obs.headings && obs.headings.length > 0) {
      obsParts.push(`Headings: ${obs.headings.join(" | ")}`);
    }
    sections.push(obsParts.join("\n"));
  }

  if (context.evidence && context.evidence.length > 0) {
    // Evidence content is sanitized upstream in latestExtractionsPerUrl
    // (redactSecrets + stripInjectionPatterns applied BEFORE slicing). The
    // URL itself still goes through redactSecrets here to scrub query-string
    // tokens like ?session_token=…
    const blocks = context.evidence.map(
      (item) => `From ${redactSecrets(item.url)}:\n${item.content}`,
    );
    sections.push(
      "Evidence already extracted this run (do not re-navigate to re-fetch):\n\n" +
        blocks.join("\n\n"),
    );
  }

  if (context.progressLedger && context.progressLedger.length > 0) {
    sections.push(
      "Progress ledger (preserve and build on this structured evidence; do not replace it with a generic page snapshot):\n" +
        redactSecrets(JSON.stringify(context.progressLedger, null, 2)),
    );
  }

  if (context.repairInstructions && context.repairInstructions.length > 0) {
    sections.push(
      "Required artifact repair before finishing:\n" +
        context.repairInstructions.map((problem) => `- ${redactSecrets(problem)}`).join("\n"),
    );
  }

  if (context.recentTraces.length > 0) {
    const traceLines = context.recentTraces.slice(-5).map(
      (t) => `[${t.kind}] ${redactSecrets(t.summary)}`,
    );
    sections.push("Recent activity:\n" + traceLines.join("\n"));
  }

  if (context.stateDiff) {
    const diff = context.stateDiff;
    const diffParts = [`Last state change: ${diff.summary}`, `Consecutive unchanged observations: ${diff.consecutiveUnchanged}`];
    if (diff.consecutiveUnchanged >= 2) {
      diffParts.push(STATE_UNCHANGED_WARNING);
    }
    sections.push(diffParts.join("\n"));
  }

  if (context.repeatSignal) {
    const { sameSig, sameResult, noProgress } = context.repeatSignal;
    if (noProgress >= 2) sections.push(stalledPrompt(noProgress));
    else if (sameResult >= 3) sections.push(stuckPrompt(sameSig, sameResult));
    else if (sameSig >= 4) sections.push(repeatingPrompt(sameSig));
  }

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
    return NO_CONTEXT_PROMPT;
  }

  return sections.join("\n\n");
}

export function buildActionGuidance(context: ContextBundle): string {
  const coreKinds = ["observe", "edit-helper", "exec", "raw", "finish"];
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
