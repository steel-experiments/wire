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

export interface PageSketchControlSummary {
  label: string;
  tag: string;
  role?: string;
  type?: string;
  selectorHint: string;
}

export interface PageSketchSectionSummary {
  id: string;
  kind: string;
  label?: string;
  heading?: string;
  textPreview?: string;
  selectorHint: string;
  controls: PageSketchControlSummary[];
}

export interface PageSketchSummary {
  sections: PageSketchSectionSummary[];
  truncated?: boolean;
}

export interface PageSketchReuseSummary {
  host: string;
  routeShape: string;
  similarPages: number;
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
  /** Optional opt-in structured visible page regions and controls. */
  pageSketch?: PageSketchSummary;
  /** Repeated PageSketch template observed across similar entity/detail pages. */
  pageSketchReuse?: PageSketchReuseSummary;
  /** Latest substantive extraction per URL visited this run. Lets the agent
   *  reuse what it has already pulled instead of re-navigating to re-extract. */
  evidence?: UrlEvidence[];
  /** Model-authored structured evidence accumulated across actions. */
  progressLedger?: JsonObject[];
  /** Concrete reviewer failures that must be repaired before finishing. */
  repairInstructions?: string[];
  /** Latest result reflects the search query back — surface the SERP-trap warning. */
  queryEchoDetected?: boolean;
}

import { redactSecrets } from "../shared/redact.js";
import {
  ACTIVE_BROWSER_SYSTEM_GUIDANCE,
  actionGuidanceTexts,
  LOADED_SKILLS_GUIDANCE,
  NO_CONTEXT_PROMPT,
  STATE_UNCHANGED_WARNING,
  USER_MESSAGE_GUIDANCE,
  repeatingPrompt,
  stalledPrompt,
  stuckPrompt,
} from "./prompts.js";

// Prompt-hygiene filters live in shared/sanitize.ts so skills/ can sanitize
// without importing agent code; re-exported here for agent-side importers.
export { sanitizeSkillContent, stripInjectionPatterns } from "../shared/sanitize.js";
import { stripInjectionPatterns } from "../shared/sanitize.js";

const PAGE_SKETCH_PROMPT_CAP = 3000;

function cleanPromptText(value: string): string {
  return stripInjectionPatterns(redactSecrets(value));
}

function renderPageSketch(sketch: PageSketchSummary): string {
  const lines = ["Page sketch:"];
  for (const section of sketch.sections) {
    const label = section.heading || section.label || section.textPreview || "";
    const title = label ? `: ${cleanPromptText(label)}` : "";
    lines.push(`- ${section.kind} ${cleanPromptText(section.selectorHint)}${title}`);
    if (section.controls.length > 0) {
      const controls = section.controls
        .map((control) => {
          const bits = [
            control.label ? `"${cleanPromptText(control.label)}"` : control.tag,
            control.role ? `role=${cleanPromptText(control.role)}` : "",
            control.type ? `type=${cleanPromptText(control.type)}` : "",
            cleanPromptText(control.selectorHint),
          ].filter(Boolean);
          return bits.join(" ");
        })
        .join(", ");
      lines.push(`  Controls: ${controls}`);
    }
  }
  if (sketch.truncated) {
    lines.push("(Page sketch truncated.)");
  }
  const rendered = lines.join("\n");
  if (rendered.length <= PAGE_SKETCH_PROMPT_CAP) return rendered;
  return `${rendered.slice(0, PAGE_SKETCH_PROMPT_CAP - 40).trimEnd()}\n...(Page sketch truncated.)`;
}

function renderPageSketchReuse(reuse: PageSketchReuseSummary): string {
  const template = `${reuse.host}${reuse.routeShape}`;
  const pageCount = reuse.similarPages === 1 ? "1 page" : `${reuse.similarPages} pages`;
  return [
    "Page sketch reuse:",
    `- Similar page template: ${cleanPromptText(template)} seen on ${pageCount} in this run.`,
    "- Reuse the same selectors and value/label interpretation from prior pages with this layout; for repeated-entity tasks, preserve one keyed progress entry per entity before navigating away.",
  ].join("\n");
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
    // Titles and headings are page-authored text — run them through the same
    // injection filter as extracted evidence before they enter the prompt.
    const obsParts = [`Current page: ${obs.url}`];
    if (obs.title) {
      obsParts.push(`Title: ${stripInjectionPatterns(obs.title)}`);
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
      const headings = obs.headings
        .map((heading) => stripInjectionPatterns(heading))
        .filter((heading) => heading.trim().length > 0);
      if (headings.length > 0) {
        obsParts.push(`Headings: ${headings.join(" | ")}`);
      }
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

  if (context.pageSketch && context.pageSketch.sections.length > 0) {
    sections.push(renderPageSketch(context.pageSketch));
  }

  if (context.pageSketchReuse) {
    sections.push(renderPageSketchReuse(context.pageSketchReuse));
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
    ...actionGuidanceTexts({
      skillsLoaded: context.skills.length > 0,
      ...(context.queryEchoDetected === true ? { queryEchoDetected: true } : {}),
    }),
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

  if (context.budget && context.budget.remaining <= 3 && context.budget.remaining > 0) {
    lines.push(
      `Budget almost exhausted (${context.budget.remaining} ${context.budget.unit} left). Do not navigate to new pages. If you have completed repeated units, use one final exec to return {progress:[...]} / {progressLedger:[...]} / {ledger:[...]} from already collected evidence, then finish.`,
    );
  }

  return lines.join("\n");
}
