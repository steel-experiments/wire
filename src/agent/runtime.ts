import type {
  ArtifactId,
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  JsonValue,
  LoadedSkill,
  ProfileId,
  ProposedAction,
  RunCheckpoint,
  SessionConfig,
  SessionId,
  Task,
  TraceBlobKind,
  TraceBlobRef,
  TraceEvent,
} from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { defaultSkillDir } from "../shared/paths.js";
import { basename } from "node:path";

import type { BrowserProvider } from "../browser/bridge.js";
import { DEFAULT_HELPER_SOURCE } from "../browser/helpers.js";
import { createBrowserSession, stopBrowserSession } from "../browser/session.js";

import type { PolicyEngine } from "../policy/engine.js";

import type { LLMProvider, ChatMessage, ContentPart } from "../providers/llm/openai.js";

import {
  createLoopState,
  deriveRunResult,
  executeStep,
  finalizeRun,
  shouldStop,
  type LoopState,
  type LoopResult,
  type AgentTurnFn,
} from "./loop.js";
import { assembleSystemPrompt, assembleUserPrompt, buildActionGuidance, stripInjectionPatterns, type ContextBundle } from "./context.js";
import { createPlan, planToContext, advancePlanBy, type TaskPlan } from "./planning.js";
import { observeBrowser, toObservationPayload } from "../browser/observe.js";
import { redactSecrets } from "../shared/redact.js";
import { detectAuthWall } from "../profiles/auth.js";
import { llmProposeSkill, generateSkillProposal, manageSkillPromotion } from "../skills/promote.js";
import { findMatchingSkillDocMatches, loadSkillDocsFromDir } from "../skills/loader.js";
import { extractFirstJsonObject, parseActionFromLlm, registerActionKind } from "./llm-parse.js";
import {
  latestObservation,
  latestError,
  latestCodeResult,
  hasRecordedTaskArtifact,
  hasExtractedTaskResult,
  hasAttemptedExtraction,
  hasMeaningfulProgress,
  hasObjectiveCardinalityEvidence,
  buildFailureSummary,
  isRecoverableStepError,
  computeObservationDiff,
  countConsecutiveUnchanged,
  hasPostNavigationExtraction,
  appendExtractedResultArtifact,
  appendTaskNoteArtifact,
  buildVerificationAction,
  execActionSignature,
  codeResultDigest,
  computeRepeatStreak,
  computeNoProgressStreak,
  isNoProgressResult,
} from "./state-helpers.js";
import { ActionRegistry, type ActionHandler } from "./actions.js";
import { updateSkillStatsFromRun } from "../skills/stats.js";
import {
  contractCreatedPayload,
  contractToPrompt,
  contractValidationPayload,
  createTaskContract,
  validateTaskContract,
} from "./contract.js";

export interface PauseToken {
  isPaused(): boolean;
  waitWhilePaused(): Promise<void>;
}

// One-way channel for delivering user messages into a running task. The loop
// drains messages at the top of each iteration; messages become `user-message`
// trace events visible to the next planner step. Implementations are
// caller-owned — a typical implementation is a mutable array exposed via pop().
export interface UserMessageInbox {
  pop(): string | null;
}

export interface RuntimeConfig {
  provider: BrowserProvider;
  policyEngine: PolicyEngine;
  llmProvider?: LLMProvider;
  maxSteps: number;
  skillDir?: string;
  sessionInput?: CreateSessionInput;
  onSessionCreated?: (session: BrowserSession) => Promise<void> | void;
  onSessionReconfigured?: (
    details: { oldSessionId: SessionId; newSession: BrowserSession; summary: string },
  ) => Promise<void> | void;
  traceSink?: TraceSink;
  traceLlmMessages?: boolean;
  saveTraceBlob?: (
    runId: TraceEvent["runId"],
    kind: TraceBlobKind,
    value: JsonValue,
    contentType?: string,
  ) => Promise<TraceBlobRef>;
  actionHandlers?: ActionHandler[];
  keepSessionOpen?: boolean;
  cancelSignal?: AbortSignal;
  pauseToken?: PauseToken;
  userMessageInbox?: UserMessageInbox;
  existingSession?: BrowserSession;
  releaseExistingSessionOnExit?: boolean;
}

function chatMessageToJson(message: ChatMessage): JsonObject {
  return {
    role: message.role,
    content: message.content as JsonValue,
  };
}

export interface TraceSink {
  onEvent?: (event: TraceEvent) => Promise<void> | void;
  onArtifactEvent?: (event: TraceEvent) => Promise<void> | void;
}

function isCancelled(config: RuntimeConfig): boolean {
  return config.cancelSignal?.aborted ?? false;
}

// Programmatic callers (supervisor's WireRuntimeAdapter, embedded SDKs) build
// a RuntimeConfig without setting skillDir. Without this fallback every such
// caller silently runs with zero domain knowledge even when ~/.wire/skills is
// populated. The CLI used to apply this default in its own layer; lifting it
// into the runtime makes the default uniform across entry points.
function withResolvedSkillDir(config: RuntimeConfig): RuntimeConfig {
  if (config.skillDir !== undefined) return config;
  return { ...config, skillDir: defaultSkillDir() };
}

function createCancelledState(task: Task, config: RuntimeConfig): LoopState {
  const session = config.existingSession;
  const loopOptions: { sessionConfig?: SessionConfig; profileId?: ProfileId } = {};
  if (config.sessionInput?.sessionConfig) {
    loopOptions.sessionConfig = config.sessionInput.sessionConfig;
  }
  if (session?.profileId) {
    loopOptions.profileId = session.profileId;
  } else if (config.sessionInput?.profileId) {
    loopOptions.profileId = config.sessionInput.profileId;
  }

  return createLoopState(
    task,
    session?.id ?? createId("session"),
    session?.debugUrl ?? session?.liveUrl,
    loopOptions,
  );
}

function hostnameFromState(state: LoopState): string | undefined {
  const observation = latestObservation(state);
  const url = typeof observation?.payload.url === "string" ? observation.payload.url : undefined;
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/**
 * Cap any single stdout/stderr/code summary that goes into the prompt.
 * A 20 KB localStorage dump or a wireActions array with hundreds of entries
 * adds no signal but eats most of the model's reasoning budget. Keep ~1.5 KB
 * (head + tail) and tell the model it was truncated.
 */
const PROMPT_CAP_BYTES = 1500;
function capForPrompt(text: string): string {
  if (text.length <= PROMPT_CAP_BYTES) return text;
  const head = text.slice(0, Math.floor(PROMPT_CAP_BYTES * 0.7));
  const tail = text.slice(text.length - Math.floor(PROMPT_CAP_BYTES * 0.2));
  const omitted = text.length - head.length - tail.length;
  return `${head}\n…[truncated ${omitted} chars]…\n${tail}`;
}

// Per-URL evidence bounds. Each URL keeps a head slice of the latest
// substantive extraction so the agent can reuse it instead of re-navigating.
// Hard slice with no ellipsis marker — the marker is what the reviewer
// previously misread as a content defect, and we want models to treat this
// section as real evidence, not a redacted summary.
const EVIDENCE_HEAD_BYTES = 8000;
const EVIDENCE_MAX_URLS = 5;
// Lower-bound to filter out navigation acks; tight substantive answers
// (e.g. `{price:'$0/month'}` at ~30 bytes) still count if they aren't
// structurally a nav ack — see isNavigationAck.
const EVIDENCE_MIN_BYTES = 40;

function evidenceHead(text: string): string {
  return text.length <= EVIDENCE_HEAD_BYTES ? text : text.slice(0, EVIDENCE_HEAD_BYTES);
}

// A "navigation ack" is a small object whose keys are all control-plane
// signals — {navigated:true}, {navigated:true,finalUrl:"…"}, {ok:true,…}.
// These shouldn't shadow a real extraction recorded for the same URL.
const NAV_ACK_KEYS = new Set([
  "navigated", "ok", "saved", "finalUrl", "url", "redirected", "status",
]);
function isNavigationAck(returnValue: unknown): boolean {
  if (!returnValue || typeof returnValue !== "object" || Array.isArray(returnValue)) return false;
  const keys = Object.keys(returnValue as Record<string, unknown>);
  if (keys.length === 0 || keys.length > NAV_ACK_KEYS.size) return false;
  return keys.every((k) => NAV_ACK_KEYS.has(k));
}

// Serialize a code-result payload to the substantive text the agent would
// want to reuse. Extractions typically come back as a JSON returnValue
// ({site, text, plans, ...}); navigations come back as small acks. Prefer
// returnValue (typed) over stdout, but ALWAYS fall back to stdout if the
// returnValue can't be serialized — never return undefined.
function codeResultContent(payload: TraceEvent["payload"]): string {
  const rv = payload.returnValue;
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  if (rv !== undefined && rv !== null) {
    if (typeof rv === "string") return rv;
    try {
      const serialized = JSON.stringify(rv);
      // JSON.stringify returns undefined for Symbols, functions, and
      // top-level undefined without throwing. Fall back to stdout in that
      // case rather than propagate undefined into downstream .trim() calls.
      if (typeof serialized === "string") return serialized;
    } catch {
      // fall through to stdout
    }
  }
  return stdout;
}

// Find the URL the agent ENDS UP on after an exec at events[execIdx]. If the
// exec navigated mid-step, the next observation in the trace will reflect the
// new URL; the extracted content belongs to that destination URL, not the
// pre-navigation one. If no later observation exists yet, fall back to the
// pre-exec URL.
function urlForCodeResult(events: TraceEvent[], execIdx: number, preExecUrl: string): string {
  for (let i = execIdx + 1; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind === "observation") {
      const url = typeof event.payload.url === "string" ? event.payload.url : undefined;
      return url || preExecUrl;
    }
    if (event.kind === "code-result") break;
  }
  return preExecUrl;
}

// Walk events in order; for each URL we observed, record the most recent
// successful code-result whose payload looks like an extraction (not a
// navigation acknowledgement). Returns latest-per-URL, with the most-recently
// updated URL LAST in the array (which is what slice(-N) below keeps).
export function latestExtractionsPerUrl(events: TraceEvent[]): Array<{ url: string; content: string }> {
  let currentUrl: string | undefined;
  const latest = new Map<string, string>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind === "observation") {
      const url = typeof event.payload.url === "string" ? event.payload.url : undefined;
      if (url) currentUrl = url;
      continue;
    }
    if (event.kind !== "code-result") continue;
    if (event.payload.ok !== true) continue;
    if (!currentUrl) continue;
    if (isNavigationAck(event.payload.returnValue)) continue;
    const content = codeResultContent(event.payload);
    if (content.trim().length < EVIDENCE_MIN_BYTES) continue;
    // Attribute to the URL the page is on AFTER the exec, in case the exec
    // navigated mid-step (e.g. `location.href=…; return body.innerText`).
    const url = urlForCodeResult(events, i, currentUrl);
    // Delete-then-set so map order reflects most-recent-extraction, which
    // matters when slice(-N) drops entries below.
    latest.delete(url);
    latest.set(url, content);
  }
  // Redact + strip-injection BEFORE slicing. A secret that straddles the
  // 8 KB boundary would otherwise be cut into a too-short prefix that no
  // SECRET_PATTERNS regex matches; an injection token cut in half would
  // similarly escape stripInjectionPatterns.
  const entries = [...latest.entries()].map(([url, content]) => ({
    url,
    content: evidenceHead(stripInjectionPatterns(redactSecrets(content))),
  }));
  return entries.slice(-EVIDENCE_MAX_URLS);
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

function deriveSkillTags(task: Task): string[] {
  const words = `${task.title} ${task.objective} ${task.successCriteria.join(" ")}`.match(/[a-z0-9-]{4,}/giu) ?? [];
  const tags = new Set<string>();
  for (const word of words) {
    tags.add(word.toLowerCase());
    if (tags.size >= 12) {
      break;
    }
  }
  tags.add(task.mode);
  return [...tags];
}

const SKILL_GUIDANCE_MAX = 1000;
const SECTION_BUDGETS = [400, 300, 200];

export function skillGuidance(skill: LoadedSkill): string {
  const preferredSections = ["Known Traps", "Traps", "Workflow", "Wait Patterns", "Facts", "Routes", "Selectors"];
  const snippets: string[] = [];
  let totalChars = 0;
  let sectionIdx = 0;

  for (const sectionName of preferredSections) {
    const raw = skill.sections[sectionName];
    if (!raw || raw.trim().length === 0) continue;

    const body = stripInjectionPatterns(raw.trim()).replace(/\s+/gu, " ");
    const entry = `${sectionName}: ${body}`;
    const budget = sectionIdx < SECTION_BUDGETS.length
      ? SECTION_BUDGETS[sectionIdx]!
      : Math.max(50, SKILL_GUIDANCE_MAX - totalChars - 50);
    const remaining = SKILL_GUIDANCE_MAX - totalChars;
    if (remaining <= 0) break;

    const snippet = entry.length > budget
      ? entry.slice(0, budget) + "..."
      : entry;
    snippets.push(snippet);
    totalChars += snippet.length + 3;
    sectionIdx++;
  }

  if (snippets.length === 0) {
    return skill.body.replace(/\s+/gu, " ").trim().slice(0, SKILL_GUIDANCE_MAX);
  }

  return snippets.join(" | ").slice(0, SKILL_GUIDANCE_MAX);
}

// User message intent classification

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

async function syncMatchedSkills(state: LoopState, skillDir?: string): Promise<void> {
  if (!skillDir) {
    state.loadedSkills = [];
    return;
  }

  const hostname = hostnameFromState(state);
  const tags = deriveSkillTags(state.task);
  const matches = await findMatchingSkillDocMatches(skillDir, hostname, tags);
  const matched = matches.map((entry) => entry.skill);
  const previousIds = state.loadedSkills.map((skill) => skill.id).join(",");
  const nextIds = matched.map((skill) => skill.id).join(",");
  state.loadedSkills = matched;

  // One-shot empty-directory warning: if the configured skillDir loads zero
  // skill files at all, emit a single visible event so the silent-failure
  // mode (supervisor spawns wire from a cwd without ./skills, ensureDir
  // creates an empty one, no warning ever surfaces) becomes loud failure.
  const alreadyWarned = state.events.some((e) => e.kind === "skill-empty");
  if (!alreadyWarned) {
    const all = await loadSkillDocsFromDir(skillDir);
    if (all.length === 0) {
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "skill-empty",
        payload: {
          skillDir,
          message: "Skill directory has no loadable .md files. Set --skill-dir or $WIRE_SKILLS to point at your skills repo, or accept that no domain knowledge will be applied.",
        },
      });
    }
  }

  if (previousIds === nextIds) {
    return;
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "skill-load",
    payload: {
      skills: matched.map((skill) => skill.id),
      labels: matched.map(skillDisplayLabel),
      matches: matches.map((entry) => ({
        skillId: entry.skill.id,
        score: entry.score,
        reasons: entry.reasons,
      })),
      hostname: hostname ?? "",
      source: skillDir,
    },
  });
}

function skillDisplayLabel(skill: LoadedSkill): string {
  const file = basename(skill.path).replace(/\.md$/u, "");
  if (file.length > 0) return file;
  if (skill.hostnamePatterns && skill.hostnamePatterns.length > 0) {
    return skill.hostnamePatterns[0]!;
  }
  return skill.id;
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
  traceOptions?: Pick<RuntimeConfig, "traceLlmMessages" | "saveTraceBlob">,
): AgentTurnFn {
  return async (state: LoopState, provider: BrowserProvider): Promise<ProposedAction> => {
    const taskPlan = planForState(state);

    // Build a minimal context bundle from the loop state
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

    // Compute state diff for progress detection
    const allObservations = state.events.filter((e) => e.kind === "observation");
    if (allObservations.length >= 1) {
      const latest = allObservations[allObservations.length - 1]!;
      const previous = allObservations.length >= 2 ? allObservations[allObservations.length - 2] : undefined;
      const diff = computeObservationDiff(previous, latest);
      const consecutiveUnchanged = countConsecutiveUnchanged(state.events);
      context.stateDiff = { summary: diff.summary, consecutiveUnchanged };
    }

    // Repeat-streak signal: lets the LLM see what our stuck-loop guards see.
    const streak = computeRepeatStreak(state.events);
    const noProgress = computeNoProgressStreak(state.events);
    if (streak.sameSig >= 2 || noProgress >= 2) {
      context.repeatSignal = { ...streak, noProgress };
    }

    // Populate budget info
    if (!context.budget && maxSteps !== undefined) {
      context.budget = { remaining: Math.max(0, maxSteps - state.stepCount), max: maxSteps, unit: "steps" };
    }

    // If an LLM provider is available, use it to decide the next action
    if (llmProvider) {
      const actionInstructions = buildActionGuidance(context);

      const systemPrompt = assembleSystemPrompt(context);
      const userPrompt = `${assembleUserPrompt(context)}\n\n${actionInstructions}`;

      // Build user message — include screenshot if available
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

      if (traceOptions?.traceLlmMessages === true && traceOptions.saveTraceBlob) {
        const messageRefs: JsonObject[] = [];
        for (const message of messages) {
          const ref = await traceOptions.saveTraceBlob(state.run.id, "llm-message", chatMessageToJson(message), "application/json");
          messageRefs.push({ hash: ref.hash, size: ref.size, kind: ref.kind, role: message.role });
        }
        const responseRef = await traceOptions.saveTraceBlob(state.run.id, "llm-response", response.content, "text/plain");
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "llm-call",
          payload: {
            callIndex: state.stepCount + 1,
            model: response.model,
            messageRefs,
            responseRef: { hash: responseRef.hash, size: responseRef.size, kind: responseRef.kind },
          },
        });
      }

      if (response.usage) {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "llm-usage",
          payload: {
            callIndex: state.stepCount + 1,
            model: response.model,
            usage: response.usage,
          },
        });
      }

      // Parse the LLM response as a proposed action
      return normalizeProposedAction(parseActionFromLlm(response.content, state));
    }

    // Fallback: observe the browser, then finish
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

async function appendSkillProposalEvents(
  state: LoopState,
  skillDir?: string,
  llmProvider?: LLMProvider,
): Promise<void> {
  if (!llmProvider) {
    return;
  }

  const alreadyProposed = state.events.some((event) => event.kind === "skill-proposal");
  if (alreadyProposed) {
    return;
  }

  const candidate = await llmProposeSkill(state.events, state.run.id, llmProvider);
  if (!candidate) {
    return;
  }

  const payload: JsonObject = {
    skillId: candidate.skillId,
    scope: "domain",
    hostname: candidate.hostname,
    confidence: candidate.confidence,
    rationale: `Reusable browser knowledge detected for ${candidate.hostname}`,
    proposal: generateSkillProposal(candidate),
  };

  if (skillDir) {
    try {
      const result = await manageSkillPromotion(candidate, skillDir);
      if (result.proposalPath) payload.proposalPath = result.proposalPath;
      if (result.activePath) payload.path = result.activePath;
      if (!result.activePath && result.proposalPath) payload.path = result.proposalPath;
      payload.promoted = result.promoted;
      payload.promotionReason = result.reason;
    } catch (err) {
      payload.writeError = err instanceof Error ? err.message : String(err);
    }
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "skill-proposal",
    payload,
  });
}

export async function executeTask(
  task: Task,
  config: RuntimeConfig,
  agentTurn?: AgentTurnFn,
): Promise<LoopResult> {
  config = withResolvedSkillDir(config);
  const registry = buildActionRegistry(config);
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider, config.maxSteps, registry, config);

  if (isCancelled(config)) {
    return executeWithState(task, config, turn, undefined, createCancelledState(task, config), undefined, registry);
  }

  let session: BrowserSession;
  if (config.existingSession) {
    session = config.existingSession;
  } else {
    session = await createBrowserSession(config.provider, config.sessionInput);
    await config.onSessionCreated?.(session);
  }

  return executeWithState(task, config, turn, session, undefined, undefined, registry);
}

export async function resumeTask(
  checkpoint: RunCheckpoint,
  config: RuntimeConfig,
  agentTurn?: AgentTurnFn,
): Promise<LoopResult> {
  config = withResolvedSkillDir(config);
  const registry = buildActionRegistry(config);
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider, config.maxSteps, registry, config);
  const state: LoopState = {
    task: checkpoint.task,
    run: checkpoint.run,
    sessionId: checkpoint.sessionId,
    loadedSkills: [],
    events: checkpoint.events,
    stepCount: checkpoint.stepCount,
    startedAt: checkpoint.startedAt,
    helperSource: checkpoint.helperSource ?? DEFAULT_HELPER_SOURCE,
    helperVersion: checkpoint.helperVersion ?? 0,
    contract: createTaskContract(checkpoint.task),
    // Restore reviewer-retry counter from checkpoint so a run that already
    // burned its cap can't silently get fresh retries on every resume.
    reviewFailureCount: checkpoint.reviewFailureCount ?? 0,
  };

  return executeWithState(checkpoint.task, config, turn, undefined, state, checkpoint.pendingAction, registry);
}

function buildActionRegistry(config: RuntimeConfig): ActionRegistry {
  const registry = new ActionRegistry();
  if (config.actionHandlers) {
    for (const handler of config.actionHandlers) {
      registry.register(handler);
      registerActionKind(handler.kind);
    }
  }
  return registry;
}

// initializeState — setup, initial observation, skill sync, approval resume

interface LoopSignals {
  policyDenied: boolean;
  authWallHit: boolean;
  antiBotRecoveryAttempted: boolean;
  maxStepsReached: boolean;
  awaitingApproval: boolean;
  userCancelled: boolean;
  pendingApproval: LoopResult["pendingApproval"];
  pendingAction: LoopResult["pendingAction"];
  flushedEvents: number;
}

interface ArtifactReviewResult {
  passed: boolean;
  problems: string[];
}

function taskArtifactEvents(state: LoopState): TraceEvent[] {
  return state.events.filter((event) =>
    event.kind === "artifact" &&
    event.payload.source !== "task-summary" &&
    typeof event.payload.content === "string" &&
    event.payload.content.trim().length > 0
  );
}

function hasUnrecordedLatestTaskResult(state: LoopState): boolean {
  if (!hasExtractedTaskResult(state)) return false;
  const latestResultIndex = state.events.findLastIndex((event) => event.kind === "code-result");
  const latestArtifactIndex = state.events.findLastIndex((event) =>
    event.kind === "artifact" &&
    event.payload.source !== "task-summary"
  );
  return latestResultIndex > latestArtifactIndex;
}

function latestReviewedArtifactCount(state: LoopState): number {
  const review = [...state.events].reverse().find((event) =>
    event.kind === "artifact-review" &&
    typeof event.payload.artifactCount === "number"
  );
  return typeof review?.payload.artifactCount === "number" ? review.payload.artifactCount : 0;
}

function hasReviewableContract(state: LoopState): boolean {
  return state.contract.mustVisit.length > 0 ||
    state.contract.mustMention.length > 0 ||
    state.contract.mustProduce !== undefined ||
    state.contract.mustReach.length > 0 ||
    state.contract.mustNotContain.length > 0;
}

function shouldReviewArtifacts(state: LoopState, config: RuntimeConfig): boolean {
  if (!config.llmProvider) return false;
  if (state.task.mode !== "task") return false;
  if (!hasReviewableContract(state)) return false;
  // Use raw count so that the agent rewriting an artifact in response to
  // reviewer feedback re-triggers the reviewer (the legitimate fix path).
  // Wasted re-reviews on byte-identical rewrites are bounded by Change D's
  // retry cap, so this can't loop unboundedly.
  return taskArtifactEvents(state).length > latestReviewedArtifactCount(state);
}

// The reviewer needs the actual artifact text to judge it; `capForPrompt`'s
// `…[truncated N chars]…` marker is the prompt-summarizer's, not the
// artifact's, and the reviewer treats the marker itself as a content defect.
// Use a hard slice with a much higher bound here so the judge sees real bytes.
const REVIEWER_ARTIFACT_BYTES = 50_000;
const REVIEWER_MAX_ARTIFACTS = 3;

function capForReviewer(text: string): string {
  return text.length <= REVIEWER_ARTIFACT_BYTES ? text : text.slice(0, REVIEWER_ARTIFACT_BYTES);
}

// Dedupe key for an artifact event. Auto-extracted JSON/note artifacts have
// no filename and use a unique-artifactId path, so falling back to `path`
// would never collapse them. Fall back to `kind` first (json-output, note,
// markdown, helper-diff, …) so repeated auto-extractions of the same kind
// dedupe to one entry per kind, then to path (still unique per emission),
// then to a literal label as a last resort.
function artifactDedupeKey(event: TraceEvent): string {
  const filename = typeof event.payload.filename === "string" && event.payload.filename.length > 0
    ? event.payload.filename
    : undefined;
  if (filename) return filename;
  const kind = typeof event.payload.kind === "string" && event.payload.kind.length > 0
    ? event.payload.kind
    : undefined;
  if (kind) return `kind:${kind}`;
  const path = typeof event.payload.path === "string" && event.payload.path.length > 0
    ? event.payload.path
    : undefined;
  if (path) return path;
  return "artifact";
}

function artifactDisplayName(event: TraceEvent): string {
  const filename = typeof event.payload.filename === "string" && event.payload.filename.length > 0
    ? event.payload.filename
    : undefined;
  if (filename) return filename;
  const path = typeof event.payload.path === "string" && event.payload.path.length > 0
    ? event.payload.path
    : undefined;
  if (path) return path;
  return "artifact";
}

// Multiple artifact events with the same dedupe key are the agent rewriting
// the same logical artifact across retries, not separate deliverables. Keep
// the latest per key so the reviewer doesn't read its own retry trail as
// duplication. Delete-then-set so map iteration order reflects
// most-recent-update — important when slice(-N) below drops entries.
export function dedupeArtifactEvents(events: TraceEvent[]): TraceEvent[] {
  const latest = new Map<string, TraceEvent>();
  for (const event of events) {
    const key = artifactDedupeKey(event);
    latest.delete(key);
    latest.set(key, event);
  }
  return [...latest.values()].slice(-REVIEWER_MAX_ARTIFACTS);
}

export function artifactReviewPrompt(state: LoopState): string {
  // Sanitize artifact content before showing it to the reviewer LLM: a hostile
  // page scraped into an artifact can contain "ignore previous instructions"
  // or <system> tags that would flip the verdict, and any credentials that
  // bled into the content should be redacted before they leave the process.
  const sanitize = (text: string): string =>
    capForReviewer(stripInjectionPatterns(redactSecrets(text)));
  const artifacts = dedupeArtifactEvents(taskArtifactEvents(state)).map((event) => {
    const label = artifactDisplayName(event);
    const content = typeof event.payload.content === "string" ? event.payload.content : "";
    return `Artifact: ${label}\n${sanitize(content)}`;
  }).join("\n\n");
  const result = deriveRunResult(state.events, state.task.mode);
  const evidence = result ? sanitize(result) : "(none)";
  return [
    "Review the final artifact against the objective and completion contract.",
    "Return strict JSON only: {\"passed\": boolean, \"problems\": string[]}.",
    "Flag concrete artifact quality problems, wrong-field values, obvious misplaced text, placeholders, missing requested data, or tables that do not answer the task.",
    "Do not require perfection or external browsing. Do not invent facts. Use only the artifact and trace evidence below.",
    "",
    `Objective: ${state.task.objective}`,
    `Completion contract:\n${contractToPrompt(state.contract)}`,
    `Recent extracted evidence:\n${evidence}`,
    `Final artifact content:\n${artifacts}`,
  ].join("\n");
}

function parseArtifactReview(content: string): ArtifactReviewResult | undefined {
  const candidates = [content.trim(), extractFirstJsonObject(content)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.passed !== "boolean") continue;
      const problems = Array.isArray(obj.problems)
        ? obj.problems.map(String).filter((item) => item.trim().length > 0).slice(0, 8)
        : [];
      return { passed: obj.passed, problems };
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

async function reviewArtifacts(state: LoopState, config: RuntimeConfig): Promise<ArtifactReviewResult | undefined> {
  if (!config.llmProvider) return undefined;
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are a terse artifact reviewer for a browser agent. Return only strict JSON.",
    },
    { role: "user", content: artifactReviewPrompt(state) },
  ];
  const response = await config.llmProvider.chat(messages, { maxTokens: 700 });
  return parseArtifactReview(response.content);
}

function artifactReviewPayload(
  review: ArtifactReviewResult | undefined,
  artifactCount: number,
): JsonObject {
  if (!review) {
    return {
      passed: true,
      problems: [],
      artifactCount,
      skipped: true,
      reason: "Artifact review response could not be parsed",
    };
  }
  return {
    passed: review.passed,
    problems: review.problems,
    artifactCount,
  };
}

async function flushTraceSink(
  state: LoopState,
  config: RuntimeConfig,
  signals: LoopSignals,
): Promise<void> {
  if (!config.traceSink?.onEvent && !config.traceSink?.onArtifactEvent) {
    signals.flushedEvents = state.events.length;
    return;
  }

  while (signals.flushedEvents < state.events.length) {
    const event = state.events[signals.flushedEvents]!;
    await config.traceSink.onEvent?.(event);
    if (event.kind === "artifact") {
      await config.traceSink.onArtifactEvent?.(event);
    }
    signals.flushedEvents++;
  }
}

async function initializeState(
  state: LoopState,
  config: RuntimeConfig,
  initialState: LoopState | undefined,
  approvedPendingAction: ProposedAction | undefined,
  actionRegistry?: ActionRegistry,
): Promise<LoopSignals> {
  const signals: LoopSignals = {
    policyDenied: false,
    authWallHit: false,
    antiBotRecoveryAttempted: false,
    maxStepsReached: false,
    awaitingApproval: false,
    userCancelled: false,
    pendingApproval: undefined,
    pendingAction: undefined,
    flushedEvents: 0,
  };

  if (isCancelled(config)) {
    return signals;
  }

  if (!initialState) {
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "contract-check",
      payload: contractCreatedPayload(state.contract),
    });
  }

  if (approvedPendingAction) {
    const resumeOpts: {
      skipPolicyCheck: boolean;
      actionRegistry?: ActionRegistry;
      actionContext?: { onSessionReconfigured: NonNullable<RuntimeConfig["onSessionReconfigured"]> };
    } = { skipPolicyCheck: true };
    if (actionRegistry) resumeOpts.actionRegistry = actionRegistry;
    if (config.onSessionReconfigured) {
      resumeOpts.actionContext = { onSessionReconfigured: config.onSessionReconfigured };
    }
    const resumedStep = await executeStep(
      state,
      approvedPendingAction,
      config.provider,
      config.policyEngine,
      resumeOpts,
    );
    Object.assign(state, resumedStep.state);
    signals.policyDenied = resumedStep.policyDenied;
    signals.authWallHit = resumedStep.authWallHit;

    if (signals.policyDenied) {
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "error",
        payload: {
          message: "Previously approved action is now denied by current policy",
          code: "EPOLICYCHANGED",
        },
      });
    }

    await syncMatchedSkills(state, config.skillDir);
  } else if (!initialState) {
    // Fresh start: observe the current browser state before the first agent turn.
    // SPECS §19.1 step 5, §28 — "observation before first action".
    // This is setup, not an agent step — do not count against the step budget.
    const observation = await observeBrowser({
      provider: config.provider,
      sessionId: state.sessionId,
    });
    const obsPayload = toObservationPayload(observation);

    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "observation",
      payload: obsPayload,
    } as TraceEvent);
    if (observation.screenshotBase64) {
      state.latestScreenshotBase64 = observation.screenshotBase64;
    }
    signals.authWallHit = detectAuthWall(observation).detected;
    await syncMatchedSkills(state, config.skillDir);
  } else {
    await syncMatchedSkills(state, config.skillDir);
  }

  await flushTraceSink(state, config, signals);
  return signals;
}

// runMainLoop — the while(true) agent loop

function pathEvidenceFromUrl(rawUrl: unknown): string[] {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return [];
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname
      .split("/")
      .filter((part) => part.length >= 4)
      .map((part) => `/${part.toLowerCase()}`);
    return [url.hostname.toLowerCase(), url.pathname.toLowerCase(), ...parts];
  } catch {
    return [rawUrl.toLowerCase()];
  }
}

function skillDescribesRecoverableBarrier(skill: LoadedSkill, evidence: string[]): boolean {
  const text = [
    skill.sections["Known Traps"],
    skill.sections["Traps"],
    skill.sections["Workflow"],
    skill.sections["Facts"],
  ].filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
  if (text.length === 0) return false;

  const mentionsBarrier = /captcha|anti-bot|bot detection|verification|verify|interstitial|challenge/u.test(text);
  if (!mentionsBarrier) return false;
  return evidence.some((item) => item.length > 0 && text.includes(item));
}

function latestObservationMatchesRecoverableSkillBarrier(state: LoopState): boolean {
  const observation = latestObservation(state);
  if (!observation) return false;
  const evidence = pathEvidenceFromUrl(observation.payload.url);
  if (evidence.length === 0) return false;
  return state.loadedSkills.some((skill) => skillDescribesRecoverableBarrier(skill, evidence));
}

async function tryAntiBotRecovery(
  state: LoopState,
  config: RuntimeConfig,
  signals: LoopSignals,
  actionRegistry?: ActionRegistry,
): Promise<boolean> {
  if (signals.policyDenied || isCancelled(config)) return false;
  if (signals.antiBotRecoveryAttempted) return false;
  if (!latestObservationMatchesRecoverableSkillBarrier(state)) return false;
  if (!actionRegistry?.get("reconfigure")) return false;

  signals.antiBotRecoveryAttempted = true;
  const action: ProposedAction = {
    kind: "reconfigure",
    summary: "Recover from anti-bot challenge with proxy and captcha support",
    payload: { useProxy: true, solveCaptcha: true },
  };
  const stepOpts: {
    actionRegistry: ActionRegistry;
    actionContext?: { onSessionReconfigured: NonNullable<RuntimeConfig["onSessionReconfigured"]> };
  } = { actionRegistry };
  if (config.onSessionReconfigured) {
    stepOpts.actionContext = { onSessionReconfigured: config.onSessionReconfigured };
  }

  try {
    const stepResult = await executeStep(state, action, config.provider, config.policyEngine, stepOpts);
    Object.assign(state, stepResult.state);
    signals.policyDenied = stepResult.policyDenied;
    signals.authWallHit = stepResult.authWallHit;
    if (stepResult.pendingApproval) {
      signals.awaitingApproval = true;
      signals.pendingApproval = stepResult.pendingApproval;
      signals.pendingAction = stepResult.pendingAction;
    }
    await syncMatchedSkills(state, config.skillDir);
    await flushTraceSink(state, config, signals);
    return true;
  } catch (err) {
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "error",
      payload: {
        message: err instanceof Error ? err.message : String(err),
        code: "ERECONFIGURE",
      },
    });
    await flushTraceSink(state, config, signals);
    return false;
  }
}

async function runMainLoop(
  state: LoopState,
  config: RuntimeConfig,
  turn: AgentTurnFn,
  signals: LoopSignals,
  actionRegistry?: ActionRegistry,
): Promise<void> {
  let consecutiveRecoverableErrors = 0;
  let totalCodeFailures = 0;
  let lastFailedSig: string | undefined;
  let repeatFailCount = 0;
  const REPEAT_FAIL_THRESHOLD = 2;
  let lastActionSig: string | undefined;
  let lastResultDigest: string | undefined;
  let stuckCount = 0;
  // Bail when the same action returned the same result this many times in a
  // row. Threshold of 3 means 5 identical attempts before bailing — tight
  // enough to catch slow probe-without-progress loops, generous enough to
  // tolerate legitimate brief retries.
  const STUCK_THRESHOLD = 3;
  let lastSigOnly: string | undefined;
  let sigOnlyCount = 0;
  // Safety net for the cosmetic-variation case: same action, slightly
  // different result each time. Threshold of 6 means 7 identical-signature
  // attempts before bailing — looser so it doesn't false-positive on
  // legitimate sequential work, but still bounds the worst case.
  const SIG_ONLY_THRESHOLD = 6;
  // Cross-signature stall: consecutive no-progress results (nav-only,
  // empty payload, error-shaped) regardless of which code produced them.
  // Catches the grants.gov-shaped failure where the agent walks across
  // different dead URLs and signature/digest-based guards never fire.
  let noProgressCount = 0;
  const NO_PROGRESS_THRESHOLD = 4;

  while (true) {
    if (config.pauseToken?.isPaused()) {
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "thought-summary",
        payload: { reason: "Paused for user takeover" },
      });
      await flushTraceSink(state, config, signals);
      await Promise.race([
        config.pauseToken.waitWhilePaused(),
        new Promise<void>((resolve) => {
          if (isCancelled(config)) return resolve();
          config.cancelSignal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      if (!isCancelled(config)) {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "thought-summary",
          payload: { reason: "Resumed after user takeover" },
        });
        await flushTraceSink(state, config, signals);
      }
    }

    // Drain pending user messages into the trace stream so the next planner
    // step sees them as recent traces.
    if (config.userMessageInbox) {
      let msg: string | null;
      while ((msg = config.userMessageInbox.pop()) !== null) {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "user-message",
          payload: { message: msg },
        });
      }
      await flushTraceSink(state, config, signals);
    }

    const recoveredFromAntiBot = await tryAntiBotRecovery(state, config, signals, actionRegistry);
    if (recoveredFromAntiBot || signals.awaitingApproval) {
      if (signals.awaitingApproval) break;
      continue;
    }

    // Check stopping conditions
    const stopResult = shouldStop(state, {
      maxSteps: config.maxSteps,
      budgetExhausted: false,
      policyDenied: signals.policyDenied,
      authWallHit: signals.authWallHit,
      userCancelled: isCancelled(config),
    });

    if (stopResult.stop) {
      if (stopResult.reason === "Maximum steps reached") {
        signals.maxStepsReached = true;
      }
      if (stopResult.reason === "User cancelled") {
        signals.userCancelled = true;
      }
      // Record the stop reason as a trace event
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: new Date().toISOString(),
        kind: "thought-summary",
        payload: { reason: stopResult.reason ?? "Unknown stop condition" },
      });
      await flushTraceSink(state, config, signals);
      break;
    }

    let action: ProposedAction;
    try {
      action = await turn(state, config.provider);
    } catch (err) {
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: new Date().toISOString(),
        kind: "error",
        payload: { message: (err as Error).message, code: "EAGENT" },
      });
      await flushTraceSink(state, config, signals);
      break;
    }

    // If the agent wants to finish, record and break
    if (action.kind === "finish") {
      // Prevent finish when step count is too low for real progress
      if (
        state.task.mode === "task" &&
        !hasObjectiveCardinalityEvidence(state) &&
        state.stepCount < config.maxSteps
      ) {
        action = buildVerificationAction();
      } else if (
        state.stepCount < 3 &&
        state.task.mode === "task" &&
        !hasRecordedTaskArtifact(state) &&
        !hasExtractedTaskResult(state) &&
        state.stepCount < config.maxSteps
      ) {
        action = buildVerificationAction();
      } else if (
        state.task.mode === "task" &&
        !hasExtractedTaskResult(state) &&
        !hasRecordedTaskArtifact(state) &&
        !hasAttemptedExtraction(state) &&
        state.stepCount < config.maxSteps
      ) {
        action = buildVerificationAction();
      } else if (
        state.task.mode === "task" &&
        hasExtractedTaskResult(state) &&
        !hasPostNavigationExtraction(state) &&
        !hasRecordedTaskArtifact(state) &&
        state.stepCount < config.maxSteps
      ) {
        // Agent extracted a navigation-only result but no real content — force extraction
        action = buildVerificationAction();
      } else if (state.task.mode === "task") {
        if (
          hasExtractedTaskResult(state) &&
          (!hasRecordedTaskArtifact(state) || hasUnrecordedLatestTaskResult(state))
        ) {
          appendExtractedResultArtifact(state);
        } else if (!hasRecordedTaskArtifact(state)) {
          appendTaskNoteArtifact(state, action.summary);
        }
        const validation = validateTaskContract(
          state.contract,
          state.events,
          deriveRunResult(state.events, state.task.mode),
        );
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "contract-check",
          payload: contractValidationPayload(validation),
        });
        if (!validation.passed && state.stepCount < config.maxSteps) {
          state.stepCount++;
          await flushTraceSink(state, config, signals);
          continue;
        }
        if (shouldReviewArtifacts(state, config)) {
          const artifactCount = taskArtifactEvents(state).length;
          const review = await reviewArtifacts(state, config);
          const payload = artifactReviewPayload(review, artifactCount);
          state.events.push({
            id: createId("event"),
            runId: state.run.id,
            ts: nowIsoUtc(),
            kind: "artifact-review",
            payload,
          });
          // Bound reviewer retries. The reviewer is an LLM judge in a tight
          // loop — without a cap, a flaky verdict can consume the whole step
          // budget. After one retry, accept and let classification carry the
          // notes as partial-success evidence.
          if (payload.passed === false) {
            state.reviewFailureCount++;
            if (state.reviewFailureCount <= 1 && state.stepCount < config.maxSteps) {
              state.stepCount++;
              await flushTraceSink(state, config, signals);
              continue;
            }
          }
        }
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: new Date().toISOString(),
          kind: "thought-summary",
          payload: { summary: action.summary, kind: "finish" },
        });
        await flushTraceSink(state, config, signals);
        break;
      } else {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: new Date().toISOString(),
          kind: "thought-summary",
          payload: { summary: action.summary, kind: "finish" },
        });
        await flushTraceSink(state, config, signals);
        break;
      }
    }

    // Execute the step
    try {
      const stepOpts: {
        actionRegistry?: ActionRegistry;
        actionContext?: { onSessionReconfigured: NonNullable<RuntimeConfig["onSessionReconfigured"]> };
      } = {};
      if (actionRegistry) stepOpts.actionRegistry = actionRegistry;
      if (config.onSessionReconfigured) {
        stepOpts.actionContext = { onSessionReconfigured: config.onSessionReconfigured };
      }
      const stepResult = await executeStep(state, action, config.provider, config.policyEngine, stepOpts);
      Object.assign(state, stepResult.state);
      signals.policyDenied = stepResult.policyDenied;
      signals.authWallHit = stepResult.authWallHit;
      consecutiveRecoverableErrors = 0;
      await syncMatchedSkills(state, config.skillDir);

      if (
        state.task.mode === "task" &&
        action.kind === "exec" &&
        typeof action.payload?.code === "string" &&
        action.payload.code.includes("wire:extract")
      ) {
        appendExtractedResultArtifact(state);
      }

      // Cross-signature no-progress stall — fires regardless of action sig.
      // Counts consecutive successful execs that produced nothing usable
      // (empty/nav-only/error-shaped). Resets on any meaningful result.
      const lastResultForProgress = latestCodeResult(state);
      if (lastResultForProgress) {
        if (lastResultForProgress.payload.ok === true && isNoProgressResult(lastResultForProgress)) {
          noProgressCount += 1;
          if (noProgressCount > NO_PROGRESS_THRESHOLD) {
            state.events.push({
              id: createId("event"),
              runId: state.run.id,
              ts: nowIsoUtc(),
              kind: "thought-summary",
              payload: {
                reason: `${noProgressCount} consecutive no-progress results — aborting to force re-plan`,
              },
            });
            await flushTraceSink(state, config, signals);
            break;
          }
        } else if (lastResultForProgress.payload.ok === true) {
          noProgressCount = 0;
        }
      }

      // Stuck-loop guards. Three layered failure modes:
      //   (a) same code keeps erroring → repeatFailCount, tight threshold
      //   (b) same code + same result keeps repeating → stuckCount, mid threshold
      //   (c) same code regardless of result → sigOnlyCount, generous backstop
      //       (catches the cosmetic-variation case where (b) keeps resetting
      //       on minor field changes that aren't real progress).
      const sig = execActionSignature(action);
      if (sig) {
        const lastResult = latestCodeResult(state);
        const failed = lastResult?.payload["ok"] === false;
        const digest = codeResultDigest(lastResult);

        if (sig === lastSigOnly) {
          sigOnlyCount += 1;
        } else {
          lastSigOnly = sig;
          sigOnlyCount = 0;
        }
        if (sigOnlyCount > SIG_ONLY_THRESHOLD) {
          state.events.push({
            id: createId("event"),
            runId: state.run.id,
            ts: nowIsoUtc(),
            kind: "thought-summary",
            payload: {
              reason: `Same action attempted ${sigOnlyCount + 1} times in a row — aborting to force re-plan`,
            },
          });
          await flushTraceSink(state, config, signals);
          break;
        }

        if (failed) {
          if (sig === lastFailedSig) {
            repeatFailCount += 1;
          } else {
            lastFailedSig = sig;
            repeatFailCount = 1;
          }
          // Errors reset the stuck-on-success tracker — mixed signal.
          lastActionSig = undefined;
          lastResultDigest = undefined;
          stuckCount = 0;

          if (repeatFailCount > REPEAT_FAIL_THRESHOLD) {
            state.events.push({
              id: createId("event"),
              runId: state.run.id,
              ts: nowIsoUtc(),
              kind: "thought-summary",
              payload: {
                reason: `Same code failed ${repeatFailCount} times in a row — aborting to force re-plan`,
              },
            });
            await flushTraceSink(state, config, signals);
            break;
          }
        } else {
          lastFailedSig = undefined;
          repeatFailCount = 0;

          if (sig === lastActionSig && digest !== undefined && digest === lastResultDigest) {
            stuckCount += 1;
            if (stuckCount > STUCK_THRESHOLD) {
              state.events.push({
                id: createId("event"),
                runId: state.run.id,
                ts: nowIsoUtc(),
                kind: "thought-summary",
                payload: {
                  reason: `Same action returned the same result ${stuckCount + 1} times — aborting to force re-plan`,
                },
              });
              await flushTraceSink(state, config, signals);
              break;
            }
          } else {
            lastActionSig = sig;
            lastResultDigest = digest;
            stuckCount = 0;
          }
        }
      }

      await flushTraceSink(state, config, signals);

      if (stepResult.pendingApproval) {
        signals.awaitingApproval = true;
        signals.pendingApproval = stepResult.pendingApproval;
        signals.pendingAction = stepResult.pendingAction;
        break;
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        signals.userCancelled = true;
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: new Date().toISOString(),
          kind: "thought-summary",
          payload: { reason: "User cancelled" },
        });
        await flushTraceSink(state, config, signals);
        break;
      }
      const message = err instanceof Error ? err.message : String(err);
      const code = /network|timeout|ECONN|ETIMEDOUT|ENOTFOUND|fetch/iu.test(message)
        ? "ENETWORK"
        : "EEXEC";
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: new Date().toISOString(),
        kind: "error",
        payload: { message, code },
      });
      await flushTraceSink(state, config, signals);

      totalCodeFailures++;
      if (!isRecoverableStepError(message)) {
        state.stepCount++;
      }

      if (totalCodeFailures >= 10) break;

      if (isRecoverableStepError(message)) {
        consecutiveRecoverableErrors++;
        const budgetRemaining = state.stepCount < config.maxSteps;
        if (budgetRemaining && consecutiveRecoverableErrors < 5) {
          try {
            const observation = await observeBrowser({ provider: config.provider, sessionId: state.sessionId });
            state.events.push({
              id: createId("event"),
              runId: state.run.id,
              ts: nowIsoUtc(),
              kind: "observation",
              payload: toObservationPayload(observation),
            });
            if (observation.screenshotBase64) {
              state.latestScreenshotBase64 = observation.screenshotBase64;
            }
            signals.authWallHit = detectAuthWall(observation).detected;
            await syncMatchedSkills(state, config.skillDir);
            await flushTraceSink(state, config, signals);
          } catch (observeErr) {
            state.events.push({
              id: createId("event"),
              runId: state.run.id,
              ts: nowIsoUtc(),
              kind: "error",
              payload: {
                message: observeErr instanceof Error ? observeErr.message : String(observeErr),
                code: "EOBSERVE",
              },
            });
            await flushTraceSink(state, config, signals);
            break;
          }
          continue;
        }
      }

      break;
    }
  }
}

// finalizeExecution — artifact persistence, skill proposals, finalization

async function finalizeExecution(
  state: LoopState,
  config: RuntimeConfig,
  signals: LoopSignals,
): Promise<LoopResult> {
  const finalizeOptions = {
    authWallHit: signals.authWallHit,
    policyDenied: signals.policyDenied,
    budgetExhausted: false,
    maxStepsReached: signals.maxStepsReached,
    awaitingApproval: signals.awaitingApproval,
    userCancelled: signals.userCancelled,
  } as const;

  if (signals.pendingApproval) {
    const approvalOptions: {
      authWallHit: boolean;
      policyDenied: boolean;
      budgetExhausted: false;
      maxStepsReached: boolean;
      awaitingApproval: boolean;
      pendingApproval: NonNullable<typeof signals.pendingApproval>;
      pendingAction?: ProposedAction;
    } = {
      ...finalizeOptions,
      pendingApproval: signals.pendingApproval,
    };
    if (signals.pendingAction) {
      approvalOptions.pendingAction = signals.pendingAction;
    }
    return finalizeRun(state, approvalOptions);
  }

  if (
    state.task.mode === "task" &&
    !hasRecordedTaskArtifact(state)
  ) {
    const failureSummary = buildFailureSummary(state);
    if (failureSummary) {
      appendTaskNoteArtifact(state, failureSummary);
    }
  }

  await appendSkillProposalEvents(state, config.skillDir, config.llmProvider);
  await flushTraceSink(state, config, signals);

  const result = finalizeRun(state, finalizeOptions);

  if (config.skillDir) {
    try {
      await updateSkillStatsFromRun(config.skillDir, result);
    } catch { /* best-effort — stats loss must never affect run outcome */ }
  }

  return result;
}

// executeWithState — orchestrator

async function executeWithState(
  task: Task,
  config: RuntimeConfig,
  turn: AgentTurnFn,
  session?: BrowserSession,
  initialState?: LoopState,
  approvedPendingAction?: ProposedAction,
  actionRegistry?: ActionRegistry,
): Promise<LoopResult> {
  const callerOwnedSessionId = config.existingSession && !config.releaseExistingSessionOnExit
    ? config.existingSession.id
    : undefined;
  const loopOptions: { sessionConfig?: SessionConfig; profileId?: ProfileId } = {};
  if (config.sessionInput?.sessionConfig) {
    loopOptions.sessionConfig = config.sessionInput.sessionConfig;
  }
  if (session?.profileId) {
    loopOptions.profileId = session.profileId;
  } else if (config.sessionInput?.profileId) {
    loopOptions.profileId = config.sessionInput.profileId;
  }

  const state = initialState ?? createLoopState(
    task,
    session!.id,
    session?.debugUrl ?? session?.liveUrl,
    loopOptions,
  );

  const signals = await initializeState(state, config, initialState, approvedPendingAction, actionRegistry);

  try {
    await runMainLoop(state, config, turn, signals, actionRegistry);
  } finally {
    const callerOwnsSession = callerOwnedSessionId !== undefined && state.sessionId === callerOwnedSessionId;
    if (!signals.awaitingApproval && !config.keepSessionOpen && !callerOwnsSession) {
      try {
        await stopBrowserSession(config.provider, state.sessionId);
      } catch {
        // Best-effort cleanup — don't mask the real result
      }
    }
  }

  return finalizeExecution(state, config, signals);
}

// Re-export planning types for convenience
export { type TaskPlan, createPlan, advanceStep, isPlanComplete, planToContext } from "./planning.js";
