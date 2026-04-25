import type {
  ArtifactId,
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  LoadedSkill,
  ProposedAction,
  RunCheckpoint,
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
import { assembleSystemPrompt, assembleUserPrompt, type ContextBundle } from "./context.js";
import { createPlan, planToContext, advancePlanBy, type TaskPlan } from "./planning.js";
import { observeBrowser, toObservationPayload } from "../browser/observe.js";
import { detectAuthWall } from "../profiles/auth.js";
import { llmProposeSkill, generateSkillProposal, promoteSkill } from "../skills/promote.js";
import { findMatchingSkillDocs } from "../skills/loader.js";
import { parseActionFromLlm } from "./llm-parse.js";
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
  buildGenericExtractionAction,
  computeObservationDiff,
  countConsecutiveUnchanged,
} from "./state-helpers.js";

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
  const preferredSections = ["Facts", "Routes", "Selectors", "Traps", "Workflow", "Notes"];
  const snippets: string[] = [];

  for (const section of preferredSections) {
    const body = skill.sections[section];
    if (body && body.trim().length > 0) {
      snippets.push(`${section}: ${body.trim().replace(/\s+/gu, " ").slice(0, 180)}`);
    }
    if (snippets.length >= 2) {
      break;
    }
  }

  if (snippets.length === 0) {
    const fallback = skill.body.replace(/\s+/gu, " ").trim();
    return fallback.slice(0, 220);
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

export function defaultAgentTurn(llmProvider?: LLMProvider, maxSteps?: number): AgentTurnFn {
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
      const actionInstructions = [
        "Return exactly one next action as JSON.",
        'Use this shape: {"kind":"observe|exec|raw|finish","summary":"short text","payload":{...}}.',
        'For "observe", omit payload unless you need {"targetId":"..."}',
        'For "exec", set payload.code to JavaScript that runs in the browser.',
        'For "raw", set payload.method to a CDP method and payload.params to its parameters. Example: {"kind":"raw","summary":"Press arrow key","payload":{"method":"Input.dispatchKeyEvent","params":{"type":"keyDown","key":"ArrowUp","windowsVirtualKeyCode":38}}} sends a trusted keypress that pages cannot ignore. Always pair keyDown + keyUp. Use for keyboard input, mouse events, or any low-level browser control that exec cannot achieve.',
        "Prefer direct URL patterns before brittle DOM hunting when the destination is obvious, such as /pricing or /docs.",
        "Wire auto-observes after navigation code (location.href etc). Do NOT emit a separate observe after navigating.",
        "CRITICAL: navigation alone is NOT task completion. After reaching the target page, you MUST emit a final exec that EXTRACTS the answer as a JSON object or plain text string.",
        "Example: after navigating to a pricing page, emit exec with code like `return JSON.stringify({plans: [...extracted data...]})` or use `document.querySelectorAll` to collect the data and return it.",
        "Use reusable routes, selectors, waits, and traps you discover in executable code; Wire will propose durable skill files after the run from trace evidence.",
        "Only use 'finish' after a successful exec has produced output containing the answer to the objective. Never finish after only navigation and observation.",
        "Do not wrap the JSON in prose.",
      ].join("\n");

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

function appendExtractedResultArtifact(state: LoopState): void {
  const result = latestCodeResult(state);
  if (!result || result.payload.ok !== true) {
    return;
  }

  const artifactId = createId("artifact") as ArtifactId;
  let kind: "json-output" | "note" = "note";
  let mimeType = "text/plain";
  let extension = "txt";
  let content: string | undefined;

  if (result.payload.returnValue !== undefined) {
    kind = "json-output";
    mimeType = "application/json";
    extension = "json";
    content = JSON.stringify(result.payload.returnValue, null, 2);
  } else if (typeof result.payload.stdout === "string" && result.payload.stdout.trim().length > 0) {
    const stdout = result.payload.stdout.trim();
    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        kind = "json-output";
        mimeType = "application/json";
        extension = "json";
        content = JSON.stringify(parsed, null, 2);
      } else {
        content = stdout;
      }
    } catch {
      content = stdout;
    }
  }

  if (!content) {
    return;
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      kind,
      mimeType,
      path: `artifacts/${artifactId}.${extension}`,
      content,
    },
  });
}

function appendTaskNoteArtifact(state: LoopState, summary: string): void {
  const artifactId = createId("artifact") as ArtifactId;
  const observation = latestObservation(state);
  const lines = [summary.trim()];

  if (observation) {
    const title = typeof observation.payload.title === "string" ? observation.payload.title : undefined;
    const url = typeof observation.payload.url === "string" ? observation.payload.url : undefined;
    if (title) {
      lines.push(`Title: ${title}`);
    }
    if (url) {
      lines.push(`URL: ${url}`);
    }
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      kind: "note",
      mimeType: "text/plain",
      path: `artifacts/${artifactId}.txt`,
      content: lines.join("\n"),
    },
  });
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
      const written = await promoteSkill(candidate, skillDir);
      if (written) {
        payload.path = written;
      } else {
        payload.skipped = true;
        payload.skipReason = "Existing skill with equal or higher confidence";
      }
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
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider, config.maxSteps);

  // Create a browser session for this task
  const session = await createBrowserSession(config.provider, config.sessionInput);
  await config.onSessionCreated?.(session);

  return executeWithState(task, config, turn, session);
}

export async function resumeTask(
  checkpoint: RunCheckpoint,
  config: RuntimeConfig,
  agentTurn?: AgentTurnFn,
): Promise<LoopResult> {
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider, config.maxSteps);
  const state: LoopState = {
    task: checkpoint.task,
    run: checkpoint.run,
    sessionId: checkpoint.sessionId,
    loadedSkills: [],
    events: checkpoint.events,
    stepCount: checkpoint.stepCount,
    startedAt: checkpoint.startedAt,
  };

  return executeWithState(checkpoint.task, config, turn, undefined, state, checkpoint.pendingAction);
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
}

async function initializeState(
  state: LoopState,
  config: RuntimeConfig,
  initialState: LoopState | undefined,
  approvedPendingAction: ProposedAction | undefined,
): Promise<LoopSignals> {
  const signals: LoopSignals = {
    policyDenied: false,
    authWallHit: false,
    awaitingApproval: false,
    pendingApproval: undefined,
    pendingAction: undefined,
  };

  if (approvedPendingAction) {
    const resumedStep = await executeStep(
      state,
      approvedPendingAction,
      config.provider,
      config.policyEngine,
      { skipPolicyCheck: false },
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
): Promise<void> {
  let consecutiveRecoverableErrors = 0;

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
      break;
    }

    // If the agent wants to finish, record and break
    if (action.kind === "finish") {
      if (
        state.task.mode === "task" &&
        !hasExtractedTaskResult(state) &&
        !hasRecordedTaskArtifact(state) &&
        !hasAttemptedExtraction(state) &&
        state.stepCount < config.maxSteps
      ) {
        action = buildGenericExtractionAction();
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
        break;
      } else {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: new Date().toISOString(),
          kind: "thought-summary",
          payload: { summary: action.summary, kind: "finish" },
        });
        break;
      }
    }

    // Execute the step
    try {
      const stepResult = await executeStep(state, action, config.provider, config.policyEngine);
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
      state.stepCount++;

      if (isRecoverableStepError(message)) {
        consecutiveRecoverableErrors++;
        const budgetRemaining = state.stepCount < config.maxSteps;
        if (budgetRemaining && consecutiveRecoverableErrors < 3) {
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
): Promise<LoopResult> {
  const state = initialState ?? createLoopState(task, session!.id, session?.debugUrl ?? session?.liveUrl);

  const signals = await initializeState(state, config, initialState, approvedPendingAction);

  try {
    await runMainLoop(state, config, turn, signals);
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
