import type { BrowserProvider } from "../browser/bridge.js";
import type { LLMProvider, ChatMessage, ContentPart } from "../providers/llm/openai.js";
import type { JsonObject, ProposedAction, TraceEvent } from "../shared/types.js";
import { assembleSystemPrompt, assembleUserPrompt, buildActionGuidance, type ContextBundle } from "./context.js";
import { contractToPrompt } from "./contract.js";
import { latestExtractionsPerUrl } from "./evidence.js";
import { type AgentTurnFn, type LoopState } from "./loop.js";
import { parseActionFromLlm } from "./llm-parse.js";
import { recordLlmCall, type LlmTraceOptions } from "./llm-trace.js";
import { createPlan, planToContext, advancePlanBy, type TaskPlan } from "./planning.js";
import { skillGuidance } from "./skill-context.js";
import {
  computeNoProgressStreak,
  computeObservationDiff,
  computeRepeatStreak,
  countConsecutiveUnchanged,
} from "./state-helpers.js";
import { ActionRegistry } from "./actions.js";

const PROMPT_CAP_BYTES = 1500;

function capForPrompt(text: string): string {
  if (text.length <= PROMPT_CAP_BYTES) return text;
  const head = text.slice(0, Math.floor(PROMPT_CAP_BYTES * 0.7));
  const tail = text.slice(text.length - Math.floor(PROMPT_CAP_BYTES * 0.2));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n…[truncated ${omitted} chars]…\n${tail}`;
}

function observationTabs(payload: TraceEvent["payload"]): Array<{ id: string; url: string; title: string }> {
  const tabs = payload.tabs;
  if (!Array.isArray(tabs)) return [];
  return tabs.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const tab = item as JsonObject;
    if (typeof tab.id !== "string") return [];
    return [{
      id: tab.id,
      url: typeof tab.url === "string" ? tab.url : "",
      title: typeof tab.title === "string" ? tab.title : "",
    }];
  });
}

function observationDriftMessage(payload: TraceEvent["payload"]): string | undefined {
  const drift = payload.tabDrift;
  if (!drift || typeof drift !== "object" || Array.isArray(drift)) return undefined;
  const message = (drift as JsonObject).message;
  return typeof message === "string" ? message : undefined;
}

export type UserIntent = "assist" | "redirect" | "cancel";

const CANCEL_PATTERN = /^(stop|cancel|abort|kill|end task|quit|give up|never mind|nvm)\b/iu;
const REDIRECT_PATTERNS: RegExp[] = [
  /^(?:actually|instead|no[,-]\s*|wait[,-]?\s*|never mind.*(?:do|find|go|search|look|check|navigate|open|visit)\b)/iu,
  /^(?:forget\s+(?:about\s+)?(?:that|the\s+above|previous))[,.\s]+/iu,
  /^(?:new\s+(?:task|objective|goal|target)[:]\s*)/iu,
  /^(?:change\s+(?:the\s+)?(?:task|objective|goal|target)\s+to\s*)/iu,
  /^(?:now\s+(?:do|find|search|look|go|check|navigate|open|visit)\b)/iu,
  /^(?:I\s+(?:want|need)\s+(?:you\s+)?to\s+(?:do|find|search|look|go|check|navigate|open|visit)\b)/iu,
  /^(?:switch\s+to\s*)/iu,
  /^(?:go\s+(?:to|find|search)\s+(?!.*(?:same|current|this)\b))/iu,
];

export function classifyUserIntent(message: string, _currentObjective: string): UserIntent {
  const lower = message.toLowerCase().trim();

  if (CANCEL_PATTERN.test(lower)) return "cancel";

  for (const pattern of REDIRECT_PATTERNS) {
    if (pattern.test(lower)) return "redirect";
  }

  return "assist";
}

function estimatePlanSignals(state: LoopState): number {
  const successfulExecs = state.events.filter((event) =>
    event.kind === "code-result" && event.payload.ok === true
  ).length;
  const observations = state.events.filter((event) => event.kind === "observation").length;
  const additionalObservations = Math.max(0, observations - 1);
  return successfulExecs + additionalObservations;
}

function planForState(state: LoopState): TaskPlan {
  const basePlan = createPlan(state.task);
  return advancePlanBy(basePlan, estimatePlanSignals(state));
}

function metacognitionTraces(events: TraceEvent[]): Array<{ kind: string; summary: string }> {
  const traces: Array<{ kind: string; summary: string }> = [];
  const execs = events.filter((e) => e.kind === "code-exec" && typeof e.payload.code === "string");
  const lastCode = execs.at(-1)?.payload.code;
  if (lastCode) {
    let count = 0;
    for (let i = execs.length - 1; i >= 0 && execs[i]?.payload.code === lastCode; i--) count++;
    if (count >= 2) traces.push({ kind: "thought-summary", summary: `WARNING: identical exec code was tried ${count} times; change strategy before retrying.` });
  }
  const recentExecs = execs.slice(-5);
  const recentResults = events
    .filter((e) => e.kind === "code-result")
    .slice(-5)
    .map((e) => String(e.payload.stderr ?? e.payload.error ?? e.payload.result ?? ""));
  if (
    recentExecs.some((e) => /\bwire\.goto\s*\(/u.test(String(e.payload.code ?? ""))) ||
    recentResults.some((text) => /\bwire\.goto\b/u.test(text))
  ) {
    traces.push({
      kind: "error",
      summary:
        "Reactive constraint: wire.goto does not exist. Navigate with window.location.href in a navigation-only exec, or raw Page.navigate when needed, then wait for Wire's auto-observe before interacting.",
    });
  }
  if (
    recentExecs.some((e) => /(?:location\.href|location\.assign|window\.location)\s*=?\s*['"]data:/u.test(String(e.payload.code ?? ""))) &&
    recentResults.some((text) => /not found within \d+ms|Cannot read properties of null|about:blank/u.test(text))
  ) {
    traces.push({
      kind: "error",
      summary:
        'Reactive constraint: data: URL navigation from exec did not load the page. Next action must be raw Page.navigate with the full data: URL only; wait for Wire auto-observe before wire.click or extraction.',
    });
  }
  const error = [...events].reverse().find((e) => e.kind === "error");
  const message = String(error?.payload.message ?? error?.payload.stderr ?? JSON.stringify(error?.payload ?? ""));
  if (/timed?\s*out|timeout|Execution context was destroyed|WebSocket error/iu.test(message)) {
    traces.push({ kind: "error", summary: `Reactive constraint: last browser error was "${message}". Use shorter execs, avoid sleeps/reloads, and re-observe before continuing.` });
  }
  const cdp = [...events].reverse().find((e) => e.kind === "code-result" && e.payload.source === "wireActions" && e.payload.truncated === true);
  if (cdp) traces.push({ kind: "code-result", summary: "Reactive constraint: last wireActions batch was filtered/truncated; keep batches under 80 and do not use Runtime.evaluate there." });
  return traces;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function extractDataNavigationUrl(code: string): string | undefined {
  const direct =
    code.match(/(?:window\.)?location(?:\.href)?\s*=\s*(['"])(data:[\s\S]*?)\1/u) ??
    code.match(/(?:window\.)?location\.assign\(\s*(['"])(data:[\s\S]*?)\1/u);
  if (direct?.[2]) return direct[2];

  const assigned = code.match(/(?:window\.)?location(?:\.href)?\s*=\s*([A-Za-z_$][\w$]*)/u);
  const name = assigned?.[1];
  if (!name) return undefined;
  const declaration = new RegExp(`(?:const|let|var)\\s+${escapeRegExp(name)}\\s*=\\s*(['"])(data:[\\s\\S]*?)\\1`, "u");
  return code.match(declaration)?.[2];
}

function normalizeProposedAction(action: ProposedAction): ProposedAction {
  if (action.kind !== "exec" || typeof action.payload?.code !== "string") return action;
  const url = extractDataNavigationUrl(action.payload.code);
  if (!url) return action;
  return {
    kind: "raw",
    summary: "Navigate to data URL",
    payload: {
      method: "Page.navigate",
      params: { url },
    },
  };
}

export function defaultAgentTurn(
  llmProvider?: LLMProvider,
  maxSteps?: number,
  actionRegistry?: ActionRegistry,
  traceOptions?: LlmTraceOptions,
): AgentTurnFn {
  return async (state: LoopState, provider: BrowserProvider): Promise<ProposedAction> => {
    const taskPlan = planForState(state);

    const observations = state.events
      .filter((e) => e.kind === "observation")
      .slice(-3)
      .map((e) => {
        const ps = e.payload.pageSummary as Record<string, unknown> | undefined;
        const headings = Array.isArray(ps?.headings) ? ps!.headings as string[] : undefined;
        const obs: {
          url: string;
          title: string;
          forms: number;
          buttons: number;
          dialogs: number;
          headings?: string[];
          targetId?: string;
          tabs?: Array<{ id: string; url: string; title: string }>;
          tabDrift?: string;
        } = {
          url: String(e.payload.url ?? ""),
          title: String(e.payload.title ?? ""),
          forms: typeof ps?.forms === "number" ? ps.forms : 0,
          buttons: typeof ps?.buttons === "number" ? ps.buttons : 0,
          dialogs: typeof ps?.dialogs === "number" ? ps.dialogs : 0,
        };
        if (typeof e.payload.targetId === "string") obs.targetId = e.payload.targetId;
        const tabs = observationTabs(e.payload);
        if (tabs.length > 0) obs.tabs = tabs;
        const tabDrift = observationDriftMessage(e.payload);
        if (tabDrift) obs.tabDrift = tabDrift;
        if (headings) {
          obs.headings = headings;
        }
        return obs;
      });

    const recentTraces = state.events.slice(-5).map((e) => {
      let summary: string;
      switch (e.kind) {
        case "code-exec":
          summary = capForPrompt(String(e.payload.code ?? e.kind));
          break;
        case "code-result":
          summary = e.payload.ok
            ? `ok: ${capForPrompt(String(e.payload.stdout ?? "no output"))}`
            : `error: ${capForPrompt(String(e.payload.stderr ?? "unknown"))}`;
          break;
        case "observation":
          summary = `page: ${String(e.payload.url ?? "?")} title="${String(e.payload.title ?? "")}"`;
          {
            const tabs = observationTabs(e.payload);
            const drift = observationDriftMessage(e.payload);
            if (e.payload.targetId || tabs.length > 0) {
              summary += ` target=${String(e.payload.targetId ?? "?")} tabs=${tabs.length}`;
            }
            if (drift) summary += ` ${drift}`;
          }
          break;
        case "error":
          summary = `${String(e.payload.code ?? "error")}: ${String(e.payload.message ?? "")}`;
          break;
        case "user-message":
          summary = `user said: ${String(e.payload.message ?? "")}`;
          break;
        case "contract-check":
          if (e.payload.phase === "created") {
            summary = `completion contract: ${String(e.payload.summary ?? "")}`;
          } else {
            summary = e.payload.passed === true
              ? "completion contract passed"
              : `completion contract failed: ${
                Array.isArray(e.payload.missing) ? e.payload.missing.slice(0, 3).join("; ") : "missing evidence"
              }`;
          }
          break;
        case "artifact-review":
          summary = e.payload.passed === true
            ? "artifact review passed"
            : `artifact review failed: ${
              Array.isArray(e.payload.problems) ? e.payload.problems.slice(0, 3).join("; ") : "quality issue"
            }`;
          break;
        case "thought-summary":
          summary = `note: ${String(e.payload.reason ?? e.payload.summary ?? "")}`;
          break;
        default:
          summary = String(e.payload.summary ?? e.kind);
      }
      return { kind: e.kind, summary };
    });

    const context: ContextBundle = {
      task: {
        mode: state.task.mode,
        objective: state.task.objective,
        constraints: state.task.constraints,
        successCriteria: state.task.successCriteria,
        ...(state.task.branchDirective ? { branchDirective: state.task.branchDirective } : {}),
      },
      skills: state.loadedSkills.map((skill) => ({
        id: skill.id,
        scope: skill.scope,
        matchReason: skill.hostnamePatterns?.length
          ? `Matched current site and task tags`
          : "Matched task tags",
        guidance: skillGuidance(skill),
      })),
      observations,
      recentTraces: [...recentTraces, ...metacognitionTraces(state.events)],
      policyNotes: [],
      plan: planToContext(taskPlan),
      contract: contractToPrompt(state.contract),
    };

    const evidence = latestExtractionsPerUrl(state.events);
    if (evidence.length > 0) {
      context.evidence = evidence;
    }

    if (state.sessionConfig) {
      context.sessionCapabilities = { ...state.sessionConfig };
    }

    if (actionRegistry) {
      context.providerActions = actionRegistry.descriptions();
    }

    const recentUserMessages = state.events
      .filter((e) => e.kind === "user-message")
      .slice(-3)
      .reverse()
      .map((e) => String(e.payload.message ?? ""));
    if (recentUserMessages.length > 0) {
      context.userMessages = recentUserMessages;

      const latestMessage = recentUserMessages[0]!;
      const intent = classifyUserIntent(latestMessage, state.task.objective);
      if (intent === "redirect") {
        context.objectiveOverride = {
          newObjective: latestMessage,
          originalObjective: state.task.objective,
        };
      }
    }

    const allObservations = state.events.filter((e) => e.kind === "observation");
    if (allObservations.length >= 1) {
      const latest = allObservations[allObservations.length - 1]!;
      const previous = allObservations.length >= 2 ? allObservations[allObservations.length - 2] : undefined;
      const diff = computeObservationDiff(previous, latest);
      const consecutiveUnchanged = countConsecutiveUnchanged(state.events);
      context.stateDiff = { summary: diff.summary, consecutiveUnchanged };
    }

    const streak = computeRepeatStreak(state.events);
    const noProgress = computeNoProgressStreak(state.events);
    if (streak.sameSig >= 2 || noProgress >= 2) {
      context.repeatSignal = { ...streak, noProgress };
    }

    if (!context.budget && maxSteps !== undefined) {
      context.budget = { remaining: Math.max(0, maxSteps - state.stepCount), max: maxSteps, unit: "steps" };
    }

    if (llmProvider) {
      const actionInstructions = buildActionGuidance(context);

      const systemPrompt = assembleSystemPrompt(context);
      const userPrompt = `${assembleUserPrompt(context)}\n\n${actionInstructions}`;

      let userContent: string | ContentPart[];
      if (state.latestScreenshotBase64) {
        userContent = [
          { type: "text", text: userPrompt },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${state.latestScreenshotBase64}` } },
        ];
      } else {
        userContent = userPrompt;
      }

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ];

      const response = await llmProvider.chat(messages);

      await recordLlmCall(state, traceOptions, "agent", messages, response);

      return normalizeProposedAction(parseActionFromLlm(response.content, state));
    }

    const hasRecentObservation = state.events.some(
      (e) => e.kind === "observation" && state.events.indexOf(e) === state.events.length - 1,
    );

    if (!hasRecentObservation) {
      return {
        kind: "observe",
        summary: "Observe current browser state",
      };
    }

    return {
      kind: "finish",
      summary: `Task step complete: ${state.task.objective}`,
    };
  };
}
