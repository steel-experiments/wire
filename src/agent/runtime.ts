import type {
  ArtifactId,
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  LoadedSkill,
  ProfileId,
  ProposedAction,
  RunCheckpoint,
  SessionConfig,
  SessionId,
  Task,
  TraceEvent,
} from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { basename } from "node:path";

import type { BrowserProvider } from "../browser/bridge.js";
import { createBrowserSession, stopBrowserSession } from "../browser/session.js";

import type { PolicyEngine } from "../policy/engine.js";

import type { LLMProvider, ChatMessage, ContentPart } from "../providers/llm/openai.js";

import {
  createLoopState,
  executeStep,
  finalizeRun,
  shouldStop,
  type LoopState,
  type LoopResult,
  type AgentTurnFn,
} from "./loop.js";
import { assembleSystemPrompt, assembleUserPrompt, buildActionGuidance, type ContextBundle } from "./context.js";
import { createPlan, planToContext, advancePlanBy, type TaskPlan } from "./planning.js";
import { observeBrowser, toObservationPayload } from "../browser/observe.js";
import { detectAuthWall } from "../profiles/auth.js";
import { llmProposeSkill, generateSkillProposal, manageSkillPromotion } from "../skills/promote.js";
import { findMatchingSkillDocs } from "../skills/loader.js";
import { parseActionFromLlm, registerActionKind } from "./llm-parse.js";
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
  actionHandlers?: ActionHandler[];
  keepSessionOpen?: boolean;
  cancelSignal?: AbortSignal;
  pauseToken?: PauseToken;
  userMessageInbox?: UserMessageInbox;
  existingSession?: BrowserSession;
  releaseExistingSessionOnExit?: boolean;
}

export interface TraceSink {
  onEvent?: (event: TraceEvent) => Promise<void> | void;
  onArtifactEvent?: (event: TraceEvent) => Promise<void> | void;
}

function isCancelled(config: RuntimeConfig): boolean {
  return config.cancelSignal?.aborted ?? false;
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

function skillGuidance(skill: LoadedSkill): string {
  // Prioritize actionable sections over static reference data
  const preferredSections = ["Workflow", "Traps", "Facts", "Routes", "Selectors", "Notes"];
  const snippets: string[] = [];

  for (const section of preferredSections) {
    const body = skill.sections[section];
    if (body && body.trim().length > 0) {
      snippets.push(`${section}: ${body.trim().replace(/\s+/gu, " ")}`);
    }
    if (snippets.length >= 4) {
      break;
    }
  }

  if (snippets.length === 0) {
    const fallback = skill.body.replace(/\s+/gu, " ").trim();
    return fallback;
  }

  return snippets.join(" | ");
}

async function syncMatchedSkills(state: LoopState, skillDir?: string): Promise<void> {
  if (!skillDir) {
    state.loadedSkills = [];
    return;
  }

  const hostname = hostnameFromState(state);
  const tags = deriveSkillTags(state.task);
  const matched = await findMatchingSkillDocs(skillDir, hostname, tags);
  const previousIds = state.loadedSkills.map((skill) => skill.id).join(",");
  const nextIds = matched.map((skill) => skill.id).join(",");
  state.loadedSkills = matched;

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
  const error = [...events].reverse().find((e) => e.kind === "error");
  const message = String(error?.payload.message ?? error?.payload.stderr ?? JSON.stringify(error?.payload ?? ""));
  if (/timed?\s*out|timeout|Execution context was destroyed|WebSocket error/iu.test(message)) {
    traces.push({ kind: "error", summary: `Reactive constraint: last browser error was "${message}". Use shorter execs, avoid sleeps/reloads, and re-observe before continuing.` });
  }
  const cdp = [...events].reverse().find((e) => e.kind === "code-result" && e.payload.source === "wireActions" && e.payload.truncated === true);
  if (cdp) traces.push({ kind: "code-result", summary: "Reactive constraint: last wireActions batch was filtered/truncated; keep batches under 80 and do not use Runtime.evaluate there." });
  return traces;
}

export function defaultAgentTurn(llmProvider?: LLMProvider, maxSteps?: number, actionRegistry?: ActionRegistry): AgentTurnFn {
  return async (state: LoopState, provider: BrowserProvider): Promise<ProposedAction> => {
    const taskPlan = planForState(state);

    // Build a minimal context bundle from the loop state
    const observations = state.events
      .filter((e) => e.kind === "observation")
      .slice(-3)
      .map((e) => {
        const ps = e.payload.pageSummary as Record<string, unknown> | undefined;
        const headings = Array.isArray(ps?.headings) ? ps!.headings as string[] : undefined;
        const obs: { url: string; title: string; forms: number; buttons: number; dialogs: number; headings?: string[] } = {
          url: String(e.payload.url ?? ""),
          title: String(e.payload.title ?? ""),
          forms: typeof ps?.forms === "number" ? ps.forms : 0,
          buttons: typeof ps?.buttons === "number" ? ps.buttons : 0,
          dialogs: typeof ps?.dialogs === "number" ? ps.dialogs : 0,
        };
        if (headings) {
          obs.headings = headings;
        }
        return obs;
      });

    const recentTraces = state.events.slice(-5).map((e) => {
      let summary: string;
      switch (e.kind) {
        case "code-exec":
          summary = String(e.payload.code ?? e.kind);
          break;
        case "code-result":
          summary = e.payload.ok
            ? `ok: ${String(e.payload.stdout ?? "no output")}`
            : `error: ${String(e.payload.stderr ?? "unknown")}`;
          break;
        case "observation":
          summary = `page: ${String(e.payload.url ?? "?")} title="${String(e.payload.title ?? "")}"`;
          break;
        case "error":
          summary = `${String(e.payload.code ?? "error")}: ${String(e.payload.message ?? "")}`;
          break;
        case "user-message":
          summary = `user said: ${String(e.payload.message ?? "")}`;
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
    };

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
      return parseActionFromLlm(response.content, state);
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
  const registry = buildActionRegistry(config);
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider, config.maxSteps, registry);

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
  const registry = buildActionRegistry(config);
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider, config.maxSteps, registry);
  const state: LoopState = {
    task: checkpoint.task,
    run: checkpoint.run,
    sessionId: checkpoint.sessionId,
    loadedSkills: [],
    events: checkpoint.events,
    stepCount: checkpoint.stepCount,
    startedAt: checkpoint.startedAt,
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

// ---------------------------------------------------------------------------
// initializeState — setup, initial observation, skill sync, approval resume
// ---------------------------------------------------------------------------

interface LoopSignals {
  policyDenied: boolean;
  authWallHit: boolean;
  maxStepsReached: boolean;
  awaitingApproval: boolean;
  userCancelled: boolean;
  pendingApproval: LoopResult["pendingApproval"];
  pendingAction: LoopResult["pendingAction"];
  flushedEvents: number;
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

// ---------------------------------------------------------------------------
// runMainLoop — the while(true) agent loop
// ---------------------------------------------------------------------------

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
        if (hasExtractedTaskResult(state) && !hasRecordedTaskArtifact(state)) {
          appendExtractedResultArtifact(state);
        } else if (!hasRecordedTaskArtifact(state)) {
          appendTaskNoteArtifact(state, action.summary);
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

// ---------------------------------------------------------------------------
// finalizeExecution — artifact persistence, skill proposals, finalization
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// executeWithState — orchestrator
// ---------------------------------------------------------------------------

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
