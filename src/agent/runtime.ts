import type { ZodTypeAny } from "zod";
import type {
  ArtifactId,
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  JsonValue,
  ProfileId,
  ProposedAction,
  RunCheckpoint,
  ScreenshotCapturePolicy,
  SessionConfig,
  SessionId,
  Task,
  TraceBlobKind,
  TraceBlobRef,
  TraceEvent,
} from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { redactJsonObject } from "../shared/redact.js";
import { defaultSkillDir } from "../shared/paths.js";

import type { BrowserProvider } from "../browser/bridge.js";
import { DEFAULT_HELPER_SOURCE } from "../browser/helpers.js";
import { createBrowserSession, stopBrowserSession } from "../browser/session.js";

import type { PolicyEngine } from "../policy/engine.js";

import type { LLMProvider } from "../providers/llm/types.js";

import {
  applyAuthWallSignal,
  createLoopState,
  executeStep,
  shouldStop,
  type LoopState,
  type LoopResult,
  type AgentTurnFn,
} from "./loop.js";
import { observeBrowser, toObservationPayload } from "../browser/observe.js";
import { detectAuthWall } from "../profiles/auth.js";
import { registerActionKind } from "./llm-parse.js";
import {
  latestError,
  latestCodeResult,
  isRecoverableStepError,
  appendExtractedResultArtifact,
  execActionSignature,
  codeResultDigest,
  codeResultShape,
  isNoProgressResultWithRecovery,
} from "./state-helpers.js";
import { ActionRegistry, type ActionHandler } from "./actions.js";
import {
  contractCreatedPayload,
  createTaskContract,
} from "./contract.js";
import { tracingProvider, type LlmTraceOptions } from "./llm-trace.js";
import { syncMatchedSkills } from "./skill-context.js";
import { defaultAgentTurn } from "./turn.js";
import {
  artifactReviewPrompt,
  dedupeArtifactEvents,
  reviewWithCriticalPoints,
} from "./artifact-review.js";
import { tryAntiBotRecovery } from "./recovery.js";
import { handleFinishAction } from "./finish-flow.js";
import { progressLedgerFromEvents } from "./progress-ledger.js";
import { countSearchesSinceExtraction } from "./search-loop.js";
import { createStartupFailureResult } from "./startup-failure.js";
import { withApprovalResolution, withWallClockTimeout } from "./run-limits.js";
import { finalizeExecution } from "./finalize.js";

export { skillGuidance } from "./skill-context.js";
export { latestExtractionsPerUrl } from "./evidence.js";
export { classifyUserIntent, defaultAgentTurn } from "./turn.js";
export {
  artifactReviewPrompt,
  dedupeArtifactEvents,
  reviewWithCriticalPoints,
} from "./artifact-review.js";

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
  onSessionEnded?: (
    details: { sessionId: SessionId; status: "stopped" | "failed"; reason?: string },
  ) => Promise<void> | void;
  traceSink?: TraceSink;
  traceLlmMessages?: boolean;
  // Opt-in: have the model author an explicit critical-point checklist and
  // judge the run against each point, instead of one all-or-nothing artifact
  // verdict. Off by default; falls back to the default reviewer when the
  // objective yields no verifiable points.
  criticalPointReview?: boolean;
  saveTraceBlob?: (
    runId: TraceEvent["runId"],
    kind: TraceBlobKind,
    value: JsonValue,
    contentType?: string,
  ) => Promise<TraceBlobRef>;
  actionHandlers?: ActionHandler[];
  keepSessionOpen?: boolean;
  cancelSignal?: AbortSignal;
  // How to resolve an action the policy engine gates with `require-approval`
  // when no human is present. "pause" (default) breaks the run with
  // `awaiting-approval` for a caller to approve+resume — correct for the
  // attended CLI. "deny" ends the run with a terminal `blocked-policy`
  // classification instead of pausing — correct for unattended/embedded
  // callers. "allow" auto-grants the gate (equivalent to CLI `--yes`).
  onApprovalRequired?: "pause" | "deny" | "allow";
  // Hard wall-clock deadline for the whole run, in milliseconds. When the
  // deadline passes the run is aborted through the same path as
  // `cancelSignal`; the outcome is classified as a partial-success (if a
  // usable result exists) or infra-error. Independent of `maxSteps`.
  maxWallClockMs?: number;
  // Whether a successful run may write skill proposals/promotions to
  // `skillDir`. "auto" (default) keeps the current behavior. "off" disables
  // all skill writes while leaving skill *loading* intact — required for
  // unattended/concurrent callers that must not mutate a shared skill store.
  skillPromotion?: "auto" | "off";
  // Optional schema the final result must satisfy. When set, a finish whose
  // derived result doesn't validate is rejected and the agent is reprompted
  // with the validation error (bounded); a run that never conforms is
  // classified `ambiguous`. Validation is enforced for `task` mode.
  outputSchema?: ZodTypeAny;
  // Runtime-owned screenshot evidence policy. The default captures after
  // observe-producing steps only; use "every-step" for full audit trails or
  // "off" for high-volume embedded runs.
  screenshotCapture?: ScreenshotCapturePolicy;
  // Opt-in structured page-region sketches for observations; disabled by default.
  pageSketch?: boolean;
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

  return createLoopState(
    task,
    session?.id ?? createId("session"),
    session?.debugUrl ?? session?.liveUrl,
    loopOptionsForConfig(config, session),
  );
}

export async function executeTask(
  task: Task,
  config: RuntimeConfig,
  agentTurn?: AgentTurnFn,
): Promise<LoopResult> {
  config = withApprovalResolution(withResolvedSkillDir(config));
  const timeout = withWallClockTimeout(config);
  config = timeout.config;
  try {
    const registry = buildActionRegistry(config);
    const turn = agentTurn ?? defaultAgentTurn(config.llmProvider, config.maxSteps, registry, config);

    if (isCancelled(config)) {
      return await executeWithState(task, config, turn, undefined, createCancelledState(task, config), undefined, registry);
    }

    let session: BrowserSession;
    if (config.existingSession) {
      session = config.existingSession;
    } else {
      // Only a session this function created may be stopped on failure — a
      // caller-supplied existingSession is the caller's to manage.
      let createdSession: BrowserSession | undefined;
      try {
        createdSession = await createBrowserSession(config.provider, config.sessionInput);
        await config.onSessionCreated?.(createdSession);
        session = createdSession;
      } catch (err) {
        if (createdSession) {
          // The hook failed after the session opened; without this stop the
          // cloud browser stays up until server-side timeout, holding a paid
          // concurrent-session slot. A stop failure must not mask the cause.
          try {
            await stopBrowserSession(config.provider, createdSession.id);
          } catch { /* best effort */ }
        }
        return await createStartupFailureResult(task, config, err);
      }
    }

    return await executeWithState(task, config, turn, session, undefined, undefined, registry);
  } finally {
    timeout.cleanup();
  }
}

export async function resumeTask(
  checkpoint: RunCheckpoint,
  config: RuntimeConfig,
  agentTurn?: AgentTurnFn,
): Promise<LoopResult> {
  config = withApprovalResolution(withResolvedSkillDir(config));
  const timeout = withWallClockTimeout(config);
  config = timeout.config;
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
    progressLedger: progressLedgerFromEvents(checkpoint.events),
    extractionRepromptCount: 0,
    schemaRepromptCount: 0,
    contractRepromptCount: 0,
  };

  try {
    return await executeWithState(checkpoint.task, config, turn, undefined, state, checkpoint.pendingAction, registry);
  } finally {
    timeout.cleanup();
  }
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

export interface LoopSignals {
  policyDenied: boolean;
  authWallHit: boolean;
  authWallStreak: number;
  authWallHost: string | undefined;
  antiBotRecoveryAttempted: boolean;
  maxStepsReached: boolean;
  awaitingApproval: boolean;
  blockedByPolicy: boolean;
  userCancelled: boolean;
  stopReason?: string;
  pendingApproval: LoopResult["pendingApproval"];
  pendingAction: LoopResult["pendingAction"];
  flushedEvents: number;
}

function createLoopSignals(): LoopSignals {
  return {
    policyDenied: false,
    authWallHit: false,
    authWallStreak: 0,
    authWallHost: undefined,
    antiBotRecoveryAttempted: false,
    maxStepsReached: false,
    awaitingApproval: false,
    blockedByPolicy: false,
    userCancelled: false,
    pendingApproval: undefined,
    pendingAction: undefined,
    flushedEvents: 0,
  };
}

function loopOptionsForConfig(config: RuntimeConfig, session?: BrowserSession): { sessionConfig?: SessionConfig; profileId?: ProfileId } {
  const loopOptions: { sessionConfig?: SessionConfig; profileId?: ProfileId } = {};
  if (config.sessionInput?.sessionConfig) {
    loopOptions.sessionConfig = config.sessionInput.sessionConfig;
  }
  if (session?.profileId) {
    loopOptions.profileId = session.profileId;
  } else if (config.sessionInput?.profileId) {
    loopOptions.profileId = config.sessionInput.profileId;
  }
  return loopOptions;
}

type StepOptions = NonNullable<Parameters<typeof executeStep>[4]>;

function stepOptionsForConfig(config: RuntimeConfig, actionRegistry?: ActionRegistry, base: StepOptions = {}): StepOptions {
  const options: StepOptions = { ...base };
  if (config.screenshotCapture !== undefined) options.screenshotCapture = config.screenshotCapture;
  if (actionRegistry) options.actionRegistry = actionRegistry;
  if (config.pageSketch === true) {
    options.pageSketch = true;
    options.actionContext = { ...options.actionContext, includePageSketch: true };
  }
  if (config.onSessionReconfigured) {
    options.actionContext = { ...options.actionContext, onSessionReconfigured: config.onSessionReconfigured };
  }
  return options;
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
  const signals = createLoopSignals();

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
    const resumedStep = await executeStep(
      state,
      approvedPendingAction,
      config.provider,
      config.policyEngine,
      stepOptionsForConfig(config, actionRegistry, { skipPolicyCheck: true }),
    );
    Object.assign(state, resumedStep.state);
    signals.policyDenied = resumedStep.policyDenied;
    applyAuthWallSignal(state, signals, resumedStep.authWallHit);

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
      ...(config.pageSketch === true ? { includePageSketch: true } : {}),
    });
    const obsPayload = redactJsonObject(toObservationPayload(observation));

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
    applyAuthWallSignal(state, signals, detectAuthWall(observation).detected);
    await syncMatchedSkills(state, config.skillDir);
  } else {
    await syncMatchedSkills(state, config.skillDir);
  }

  await flushTraceSink(state, config, signals);
  return signals;
}

// runMainLoop — the while(true) agent loop

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
  let lastSigOnlyShape: string | undefined;
  let lastSigOnlyDigest: string | undefined;
  let sigOnlyCount = 0;
  // Safety net for the cosmetic-variation case: same action, slightly
  // different result each time. Threshold of 6 means 7 identical-signature
  // attempts before bailing — looser so it doesn't false-positive on
  // legitimate sequential work, but still bounds the worst case. The counter
  // is progress-aware: a stable result shape whose values keep changing (a
  // probe polling live state, e.g. a climbing game score) resets it, so this
  // backstop only fires on real spinning, not on a legitimate watch loop.
  const SIG_ONLY_THRESHOLD = 6;
  // Cross-signature stall: consecutive no-progress results (nav-only,
  // empty payload, error-shaped) regardless of which code produced them.
  // Catches the grants.gov-shaped failure where the agent walks across
  // different dead URLs and signature/digest-based guards never fire.
  let noProgressCount = 0;
  let lastProgressResultId: string | undefined;
  const NO_PROGRESS_THRESHOLD = 4;
  // Pattern-level stall: search navigations with no meaningful extraction.
  // A semantic search loop (new query, new URL, new dump every turn) defeats
  // every guard above — nothing repeats at the action level. Nudge first so
  // the agent can change source or admit the answer isn't reachable; abort
  // when it keeps searching past the nudge. Live case: run_3383faa5 burned 30
  // steps oscillating between DuckDuckGo and SEO-spam crossword sites.
  let searchLoopNudged = false;
  const SEARCH_LOOP_NUDGE_THRESHOLD = 3;
  const SEARCH_LOOP_ABORT_THRESHOLD = 6;

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

    const recoveredFromAntiBot = await tryAntiBotRecovery(
      state,
      config,
      signals,
      actionRegistry,
      flushTraceSink,
      isCancelled,
    );
    if (recoveredFromAntiBot || signals.awaitingApproval) {
      if (signals.awaitingApproval) break;
      continue;
    }

    // Check stopping conditions
    const stopResult = shouldStop(state, {
      maxSteps: config.maxSteps,
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
      signals.stopReason = stopResult.reason ?? "Unknown stop condition";
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

    if (action.kind === "finish") {
      // The finish flow calls reviewer LLMs; a transient provider error here
      // must end the run classified, not reject out of executeTask.
      let finish: Awaited<ReturnType<typeof handleFinishAction>>;
      try {
        finish = await handleFinishAction(state, action, config, signals, flushTraceSink);
      } catch (err) {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: new Date().toISOString(),
          kind: "error",
          payload: { message: `finish flow failed: ${(err as Error).message}`, code: "EAGENT" },
        });
        await flushTraceSink(state, config, signals);
        break;
      }
      if (finish.kind === "continue") {
        continue;
      }
      if (finish.kind === "break") {
        break;
      }
      action = finish.action;
    }

    // Execute the step
    try {
      const stepResult = await executeStep(state, action, config.provider, config.policyEngine, stepOptionsForConfig(config, actionRegistry));
      Object.assign(state, stepResult.state);
      signals.policyDenied = stepResult.policyDenied;
      applyAuthWallSignal(state, signals, stepResult.authWallHit);
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
      // (empty/nav-only/error-shaped). Resets on meaningful results or when an
      // observation shows that navigation recovered from a not-found page.
      // Only a NEW code-result may count: non-exec steps (observe, refused
      // reconfigure) re-surface the same stale result and must not double it.
      const lastResultForProgress = latestCodeResult(state);
      if (lastResultForProgress && lastResultForProgress.id !== lastProgressResultId) {
        lastProgressResultId = lastResultForProgress.id;
        if (lastResultForProgress.payload.ok === true && isNoProgressResultWithRecovery(lastResultForProgress, state.events)) {
          noProgressCount += 1;
          if (noProgressCount > NO_PROGRESS_THRESHOLD) {
            const reason = `${noProgressCount} consecutive no-progress results — aborting to force re-plan`;
            state.events.push({
              id: createId("event"),
              runId: state.run.id,
              ts: nowIsoUtc(),
              kind: "thought-summary",
              payload: { reason },
            });
            signals.stopReason = reason;
            await flushTraceSink(state, config, signals);
            break;
          }
        } else if (lastResultForProgress.payload.ok === true) {
          noProgressCount = 0;
        }
      }

      // Pattern-level search-loop guard (see constants above for rationale).
      if (state.task.mode === "task") {
        const searchCount = countSearchesSinceExtraction(state.events);
        if (searchCount === 0) {
          searchLoopNudged = false;
        } else if (searchCount >= SEARCH_LOOP_ABORT_THRESHOLD) {
          const reason = `Searched ${searchCount} times without extracting an answer — aborting to force re-plan`;
          state.events.push({
            id: createId("event"),
            runId: state.run.id,
            ts: nowIsoUtc(),
            kind: "thought-summary",
            payload: { reason },
          });
          signals.stopReason = reason;
          await flushTraceSink(state, config, signals);
          break;
        } else if (searchCount >= SEARCH_LOOP_NUDGE_THRESHOLD && !searchLoopNudged) {
          searchLoopNudged = true;
          state.events.push({
            id: createId("event"),
            runId: state.run.id,
            ts: nowIsoUtc(),
            kind: "thought-summary",
            payload: {
              kind: "search-loop",
              reason:
                `You have searched ${searchCount} times without extracting an answer. ` +
                "The sources you are reaching may not contain it — extract what the objective asks for from a page you trust, " +
                "try a fundamentally different source (a direct authoritative site, an archive), " +
                "or finish stating the answer could not be found. Do not run another reworded web search.",
            },
          });
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
        const shape = codeResultShape(lastResult);

        if (sig === lastSigOnly) {
          // Treat this as progress — and reset the backstop — when the result
          // keeps the same shape (key set) but changes its values: a stable
          // probe returning fresh data. A morphing shape, or an unchanged
          // result, still counts toward bailing.
          const stableShape = shape !== undefined && shape === lastSigOnlyShape;
          const valuesChanged = digest !== undefined && digest !== lastSigOnlyDigest;
          if (stableShape && valuesChanged) {
            sigOnlyCount = 0;
          } else {
            sigOnlyCount += 1;
          }
        } else {
          lastSigOnly = sig;
          sigOnlyCount = 0;
        }
        lastSigOnlyShape = shape;
        lastSigOnlyDigest = digest;
        if (sigOnlyCount > SIG_ONLY_THRESHOLD) {
          const reason = `Same action attempted ${sigOnlyCount + 1} times in a row — aborting to force re-plan`;
          state.events.push({
            id: createId("event"),
            runId: state.run.id,
            ts: nowIsoUtc(),
            kind: "thought-summary",
            payload: { reason },
          });
          signals.stopReason = reason;
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
            const reason = `Same code failed ${repeatFailCount} times in a row — aborting to force re-plan`;
            state.events.push({
              id: createId("event"),
              runId: state.run.id,
              ts: nowIsoUtc(),
              kind: "thought-summary",
              payload: { reason },
            });
            signals.stopReason = reason;
            await flushTraceSink(state, config, signals);
            break;
          }
        } else {
          lastFailedSig = undefined;
          repeatFailCount = 0;

          if (sig === lastActionSig && digest !== undefined && digest === lastResultDigest) {
            stuckCount += 1;
            if (stuckCount > STUCK_THRESHOLD) {
              const reason = `Same action returned the same result ${stuckCount + 1} times — aborting to force re-plan`;
              state.events.push({
                id: createId("event"),
                runId: state.run.id,
                ts: nowIsoUtc(),
                kind: "thought-summary",
                payload: { reason },
              });
              signals.stopReason = reason;
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
        // Unattended caller: don't pause for a human that isn't there. End the
        // run with a precise blocked-policy outcome (the approval-request event
        // is already in the trace as evidence of what was gated).
        if (config.onApprovalRequired === "deny") {
          signals.blockedByPolicy = true;
          signals.stopReason = "Action required approval; denied in unattended mode";
          break;
        }
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
            const observation = await observeBrowser({
              provider: config.provider,
              sessionId: state.sessionId,
              ...(config.pageSketch === true ? { includePageSketch: true } : {}),
            });
            state.events.push({
              id: createId("event"),
              runId: state.run.id,
              ts: nowIsoUtc(),
              kind: "observation",
              payload: redactJsonObject(toObservationPayload(observation)),
            });
            if (observation.screenshotBase64) {
              state.latestScreenshotBase64 = observation.screenshotBase64;
            }
            applyAuthWallSignal(state, signals, detectAuthWall(observation).detected);
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

  const state = initialState ?? createLoopState(
    task,
    session!.id,
    session?.debugUrl ?? session?.liveUrl,
    loopOptionsForConfig(config, session),
  );

  const signals = await initializeState(state, config, initialState, approvedPendingAction, actionRegistry);

  try {
    await runMainLoop(state, config, turn, signals, actionRegistry);
  } finally {
    const callerOwnsSession = callerOwnedSessionId !== undefined && state.sessionId === callerOwnedSessionId;
    const keepOpen = config.keepSessionOpen === true;
    if (!signals.awaitingApproval && !keepOpen && !callerOwnsSession) {
      try {
        await stopBrowserSession(config.provider, state.sessionId);
        await config.onSessionEnded?.({ sessionId: state.sessionId, status: "stopped" });
      } catch (err) {
        await config.onSessionEnded?.({
          sessionId: state.sessionId,
          status: "failed",
          reason: err instanceof Error ? err.message : String(err),
        });
        // Best-effort cleanup — don't mask the real result
      }
    }
  }

  return finalizeExecution(state, config, signals, flushTraceSink);
}

// Re-export planning types for convenience
export { type TaskPlan, createPlan, advanceStep, isPlanComplete, planToContext } from "./planning.js";
