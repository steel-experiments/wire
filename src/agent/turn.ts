import type { BrowserProvider } from "../browser/bridge.js";
import type { LLMProvider, ChatMessage, ContentPart } from "../providers/llm/types.js";
import type { JsonObject, ProposedAction, TraceEvent } from "../shared/types.js";
import {
  assembleSystemPrompt,
  assembleUserPrompt,
  buildActionGuidance,
  type ContextBundle,
  type PageSketchReuseSummary,
  type PageSketchSummary,
} from "./context.js";
import { looksLikeQueryEcho } from "./classify.js";
import { contractToPrompt } from "./contract.js";
import { latestExtractionsPerUrl } from "./evidence.js";
import { type AgentTurnFn, type LoopState } from "./loop.js";
import { isParseFailureFinish, parseActionFromLlm } from "./llm-parse.js";
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
  const { sameSig } = computeRepeatStreak(events);
  if (sameSig >= 2) {
    traces.push({ kind: "thought-summary", summary: `WARNING: identical exec code was tried ${sameSig} times; change strategy before retrying.` });
  }
  const recentExecs = execs.slice(-5);
  const recentResults = events
    .filter((e) => e.kind === "code-result")
    .slice(-5)
    .map((e) => String(
      e.payload.stderr ??
      e.payload.error ??
      e.payload.stdout ??
      (e.payload.returnValue !== undefined ? JSON.stringify(e.payload.returnValue) : ""),
    ));
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

function asRecord(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function pageSketchFromPayload(payload: JsonObject): PageSketchSummary | undefined {
  const sketch = asRecord(payload.pageSketch);
  const rawSections = Array.isArray(sketch?.sections) ? sketch.sections : [];
  const sections: PageSketchSummary["sections"] = [];

  for (const rawSection of rawSections.slice(0, 12)) {
    const section = asRecord(rawSection);
    if (!section) continue;
    const id = stringValue(section.id);
    const kind = stringValue(section.kind);
    const selectorHint = stringValue(section.selectorHint);
    if (!id || !kind || !selectorHint) continue;

    const summarySection: PageSketchSummary["sections"][number] = {
      id,
      kind,
      selectorHint,
      controls: [],
    };
    const label = stringValue(section.label);
    const heading = stringValue(section.heading);
    const textPreview = stringValue(section.textPreview);
    if (label) summarySection.label = label;
    if (heading) summarySection.heading = heading;
    if (textPreview) summarySection.textPreview = textPreview;

    const rawControls = Array.isArray(section.controls) ? section.controls : [];
    for (const rawControl of rawControls.slice(0, 12)) {
      const control = asRecord(rawControl);
      if (!control) continue;
      const tag = stringValue(control.tag);
      const controlSelector = stringValue(control.selectorHint);
      if (!tag || !controlSelector) continue;
      const controlSummary: PageSketchSummary["sections"][number]["controls"][number] = {
        label: stringValue(control.label) ?? "",
        tag,
        selectorHint: controlSelector,
      };
      const role = stringValue(control.role);
      const type = stringValue(control.type);
      if (role) controlSummary.role = role;
      if (type) controlSummary.type = type;
      summarySection.controls.push(controlSummary);
    }
    sections.push(summarySection);
  }

  if (sections.length === 0) return undefined;
  const out: PageSketchSummary = { sections };
  if (sketch?.truncated === true) out.truncated = true;
  return out;
}

interface PageSketchRouteShape {
  host: string;
  routeShape: string;
  urlKey: string;
}

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function shapePathSegment(segment: string, index: number, segmentCount: number): string {
  const decoded = decodePathSegment(segment).replace(/^@/u, "");
  const lower = decoded.toLowerCase();
  if (/^\d+$/u.test(lower)) return ":id";
  if (/^[0-9a-f]{8,}(?:-[0-9a-f]{4,})*$/iu.test(lower)) return ":id";
  if (index === segmentCount - 1 && /^[a-z0-9][a-z0-9_-]{1,38}$/iu.test(lower)) return ":id";
  return lower;
}

function pageSketchRouteShape(rawUrl: unknown): PageSketchRouteShape | undefined {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return undefined;
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/u.test(url.protocol)) return undefined;
    const host = url.hostname.toLowerCase().replace(/^www\./u, "");
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const routeShape = segments.length === 0
      ? "/"
      : `/${segments.map((segment, index) => shapePathSegment(segment, index, segments.length)).join("/")}`;
    const normalizedPath = url.pathname.replace(/\/+$/u, "") || "/";
    return { host, routeShape, urlKey: `${host}${normalizedPath}` };
  } catch {
    return undefined;
  }
}

export function pageSketchReuseFromEvents(events: TraceEvent[]): PageSketchReuseSummary | undefined {
  const observations = events.filter((event) => event.kind === "observation");
  const latest = observations.at(-1);
  if (!latest || !pageSketchFromPayload(latest.payload)) return undefined;

  const latestShape = pageSketchRouteShape(latest.payload.url);
  if (!latestShape) return undefined;

  const matchingUrls = new Set<string>();
  for (const event of observations) {
    if (!pageSketchFromPayload(event.payload)) continue;
    const shape = pageSketchRouteShape(event.payload.url);
    if (!shape) continue;
    if (shape.host !== latestShape.host || shape.routeShape !== latestShape.routeShape) continue;
    matchingUrls.add(shape.urlKey);
  }

  if (matchingUrls.size < 2) return undefined;
  return {
    host: latestShape.host,
    routeShape: latestShape.routeShape,
    similarPages: matchingUrls.size,
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
        case "code-result": {
          // Wire's exec idiom is `return {...}` — show the returnValue, not
          // just stdout, or the planner cannot see the answer it extracted
          // and re-extracts until the stuck guards punish it.
          const okOutput = typeof e.payload.stdout === "string" && e.payload.stdout.trim().length > 0
            ? e.payload.stdout
            : e.payload.returnValue !== undefined
              ? typeof e.payload.returnValue === "string"
                ? e.payload.returnValue
                : JSON.stringify(e.payload.returnValue)
              : "no output";
          summary = e.payload.ok
            ? `ok: ${capForPrompt(okOutput)}`
            : `error: ${capForPrompt(String(e.payload.stderr ?? "unknown"))}`;
          break;
        }
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
        matchReason: [
          skill.status === "proposed" ? "Provisional learned proposal" : undefined,
          skill.hostnamePatterns?.length ? "matched current site and task tags" : "matched task tags",
        ].filter(Boolean).join("; "),
        guidance: skillGuidance(skill),
      })),
      observations,
      recentTraces: [...recentTraces, ...metacognitionTraces(state.events)],
      policyNotes: [],
      plan: planToContext(taskPlan),
      contract: contractToPrompt(state.contract),
    };

    const latestObservationEvent = [...state.events].reverse().find((event) => event.kind === "observation");
    if (latestObservationEvent) {
      const pageSketch = pageSketchFromPayload(latestObservationEvent.payload);
      if (pageSketch) {
        context.pageSketch = pageSketch;
      }
    }

    const pageSketchReuse = pageSketchReuseFromEvents(state.events);
    if (pageSketchReuse) {
      context.pageSketchReuse = pageSketchReuse;
    }

    if (state.progressLedger.length > 0) {
      context.progressLedger = state.progressLedger;
    }

    const latestFailedReview = [...state.events].reverse().find((event) =>
      event.kind === "artifact-review" && event.payload.passed === false
    );
    if (latestFailedReview && Array.isArray(latestFailedReview.payload.problems)) {
      context.repairInstructions = latestFailedReview.payload.problems
        .map(String)
        .filter((problem) => problem.trim().length > 0)
        .slice(0, 8);
    }

    const evidence = latestExtractionsPerUrl(state.events);
    if (evidence.length > 0) {
      context.evidence = evidence;
    }

    // In-loop SERP-trap awareness: when the latest result is the agent's own
    // query reflected back, ship the query-echo guidance with the next turn —
    // the after-the-fact classifier check can't stop the agent from chasing it.
    const latestOkResult = [...state.events].reverse().find((event) =>
      event.kind === "code-result" &&
      event.payload.ok === true &&
      (
        (typeof event.payload.stdout === "string" && event.payload.stdout.trim().length > 0) ||
        event.payload.returnValue !== undefined
      )
    );
    if (latestOkResult) {
      const text = typeof latestOkResult.payload.stdout === "string" && latestOkResult.payload.stdout.trim().length > 0
        ? latestOkResult.payload.stdout
        : JSON.stringify(latestOkResult.payload.returnValue);
      if (looksLikeQueryEcho(text)) {
        context.queryEchoDetected = true;
      }
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

      let action = parseActionFromLlm(response.content, state);
      if (isParseFailureFinish(action)) {
        // One corrective reprompt — a single malformed completion must not
        // end the run. If the retry is also unparseable, the failure finish
        // stands and the run ends with a clean summary.
        const retryMessages: ChatMessage[] = [
          ...messages,
          { role: "assistant", content: response.content },
          {
            role: "user",
            content: "Your previous reply was not a valid action. Reply with ONLY one JSON object with fields kind, summary, and optional payload — no prose, no code fences.",
          },
        ];
        const retry = await llmProvider.chat(retryMessages);
        await recordLlmCall(state, traceOptions, "agent-parse-retry", retryMessages, retry);
        action = parseActionFromLlm(retry.content, state);
      }
      return normalizeProposedAction(action);
    }

    const hasRecentObservation = state.events.at(-1)?.kind === "observation";

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
