import type {
  ArtifactId,
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  JsonValue,
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

import type { BrowserProvider } from "../browser/bridge.js";
import { DEFAULT_HELPER_SOURCE } from "../browser/helpers.js";
import { createBrowserSession, stopBrowserSession } from "../browser/session.js";

import type { PolicyEngine } from "../policy/engine.js";

import type { LLMProvider } from "../providers/llm/openai.js";

import {
  createLoopState,
  executeStep,
  finalizeRun,
  computeFinalClassification,
  shouldStop,
  type LoopState,
  type LoopResult,
  type AgentTurnFn,
} from "./loop.js";
import { observeBrowser, toObservationPayload } from "../browser/observe.js";
import { detectAuthWall } from "../profiles/auth.js";
import { llmProposeSkill, generateSkillProposal, manageSkillPromotion } from "../skills/promote.js";
import { registerActionKind } from "./llm-parse.js";
import {
  latestError,
  latestCodeResult,
  hasRecordedTaskArtifact,
  buildFailureSummary,
  isRecoverableStepError,
  appendExtractedResultArtifact,
  appendTaskNoteArtifact,
  execActionSignature,
  codeResultDigest,
  codeResultShape,
  isNoProgressResult,
} from "./state-helpers.js";
import { ActionRegistry, type ActionHandler } from "./actions.js";
import { updateSkillStatsFromRun } from "../skills/stats.js";
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
    extractionRepromptCount: 0,
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
  /** The agent asked to leave the browser session open after finishing — set
   *  when it emits a finish action with payload.keepSessionOpen. Lets the model
   *  honor a "keep the session open" objective by understanding it, rather than
   *  Wire string-matching the task text. */
  keepSessionOpenRequested: boolean;
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
    antiBotRecoveryAttempted: false,
    maxStepsReached: false,
    awaitingApproval: false,
    userCancelled: false,
    keepSessionOpenRequested: false,
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

    if (action.kind === "finish") {
      const finish = await handleFinishAction(state, action, config, signals, flushTraceSink);
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

  // Only mint a skill from a run that actually accomplished something. A skill
  // captures durable, working browser knowledge; proposing one from a run
  // classified as an error or dead-end (agent-error, site-error, blocked-auth,
  // ambiguous, …) would bake a broken trajectory into a reusable skill.
  const finalClassification = computeFinalClassification(state, finalizeOptions);
  if (
    finalClassification.kind === "task-complete" ||
    finalClassification.kind === "partial-success"
  ) {
    await appendSkillProposalEvents(state, config.skillDir, config.llmProvider);
  }
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
    const keepOpen = config.keepSessionOpen || signals.keepSessionOpenRequested;
    if (!signals.awaitingApproval && !keepOpen && !callerOwnsSession) {
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
