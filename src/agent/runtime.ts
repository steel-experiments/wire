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
  buildFailureSummary,
  isRecoverableStepError,
  computeObservationDiff,
  countConsecutiveUnchanged,
  hasPostNavigationExtraction,
  appendExtractedResultArtifact,
  appendTaskNoteArtifact,
  buildVerificationAction,
} from "./state-helpers.js";
import { ActionRegistry, type ActionHandler } from "./actions.js";

// ---------------------------------------------------------------------------
// RuntimeConfig — what the runtime needs to run
// ---------------------------------------------------------------------------

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
}

export interface TraceSink {
  onEvent?: (event: TraceEvent) => Promise<void> | void;
  onArtifactEvent?: (event: TraceEvent) => Promise<void> | void;
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
      hostname: hostname ?? "",
      source: skillDir,
    },
  });
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

// ---------------------------------------------------------------------------
// defaultAgentTurn — uses LLM if available, falls back to observe+finish
// ---------------------------------------------------------------------------

export function defaultAgentTurn(llmProvider?: LLMProvider, maxSteps?: number, actionRegistry?: ActionRegistry): AgentTurnFn {
  return async (state: LoopState, provider: BrowserProvider): Promise<ProposedAction> => {
    const taskPlan = planForState(state);

    // Build a minimal context bundle from the loop state
    const observations = state.events
      .filter((e) => e.kind === "observation")
      .slice(-3)
      .map((e) => {
        const ps = e.payload.pageSummary as Record<string, unknown> | undefined;
        const texts = Array.isArray(ps?.visibleTexts) ? ps!.visibleTexts as string[] : undefined;
        const obs: { url: string; title: string; forms: number; buttons: number; dialogs: number; visibleTexts?: string[] } = {
          url: String(e.payload.url ?? ""),
          title: String(e.payload.title ?? ""),
          forms: typeof ps?.forms === "number" ? ps.forms : 0,
          buttons: typeof ps?.buttons === "number" ? ps.buttons : 0,
          dialogs: typeof ps?.dialogs === "number" ? ps.dialogs : 0,
        };
        if (texts) {
          obs.visibleTexts = texts;
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
      recentTraces,
      policyNotes: [],
      plan: planToContext(taskPlan),
    };

    if (state.sessionConfig) {
      context.sessionCapabilities = { ...state.sessionConfig };
    }

    if (actionRegistry) {
      context.providerActions = actionRegistry.descriptions();
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
    console.error("[skill-promote] No LLM provider configured, skipping skill proposal");
    return;
  }

  const alreadyProposed = state.events.some((event) => event.kind === "skill-proposal");
  if (alreadyProposed) {
    console.error("[skill-promote] Skill already proposed, skipping");
    return;
  }

  const candidate = await llmProposeSkill(state.events, state.run.id, llmProvider);
  if (!candidate) {
    console.error("[skill-promote] No candidate produced from LLM");
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

// ---------------------------------------------------------------------------
// executeTask — run an agent loop to completion
// ---------------------------------------------------------------------------

export async function executeTask(
  task: Task,
  config: RuntimeConfig,
  agentTurn?: AgentTurnFn,
): Promise<LoopResult> {
  const registry = buildActionRegistry(config);
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider, config.maxSteps, registry);

  // Create a browser session for this task
  const session = await createBrowserSession(config.provider, config.sessionInput);
  await config.onSessionCreated?.(session);

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
  awaitingApproval: boolean;
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
    awaitingApproval: false,
    pendingApproval: undefined,
    pendingAction: undefined,
    flushedEvents: 0,
  };

  if (approvedPendingAction) {
    const resumeOpts: {
      skipPolicyCheck: boolean;
      actionRegistry?: ActionRegistry;
      actionContext?: { onSessionReconfigured: NonNullable<RuntimeConfig["onSessionReconfigured"]> };
    } = { skipPolicyCheck: false };
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

  while (true) {
    // Check stopping conditions
    const stopResult = shouldStop(state, {
      maxSteps: config.maxSteps,
      budgetExhausted: false,
      policyDenied: signals.policyDenied,
      authWallHit: signals.authWallHit,
      userCancelled: false,
    });

    if (stopResult.stop) {
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
      await flushTraceSink(state, config, signals);

      if (stepResult.pendingApproval) {
        signals.awaitingApproval = true;
        signals.pendingApproval = stepResult.pendingApproval;
        signals.pendingAction = stepResult.pendingAction;
        break;
      }
    } catch (err) {
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
    awaitingApproval: signals.awaitingApproval,
  } as const;

  if (signals.pendingApproval) {
    const approvalOptions: {
      authWallHit: boolean;
      policyDenied: boolean;
      budgetExhausted: false;
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

  return finalizeRun(state, finalizeOptions);
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
    // Always clean up the browser session
    if (!signals.awaitingApproval) {
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
