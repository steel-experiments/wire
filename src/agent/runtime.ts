import type {
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  ProposedAction,
  RunCheckpoint,
  Task,
  TraceEvent,
} from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";

import type { BrowserProvider } from "../browser/bridge.js";
import { createBrowserSession, stopBrowserSession } from "../browser/session.js";

import type { PolicyEngine } from "../policy/engine.js";

import type { LLMProvider, ChatMessage } from "../providers/llm/openai.js";

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
import { createPlan, planToContext, advanceStep, isPlanComplete, type TaskPlan } from "./planning.js";
import { observeBrowser } from "../browser/observe.js";
import { detectAuthWall } from "../profiles/auth.js";
import { detectPromotionCandidates, generateSkillProposal, promoteSkill } from "../skills/promote.js";

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

// ---------------------------------------------------------------------------
// defaultAgentTurn — uses LLM if available, falls back to observe+finish
// ---------------------------------------------------------------------------

export function defaultAgentTurn(llmProvider?: LLMProvider): AgentTurnFn {
  return async (state: LoopState, provider: BrowserProvider): Promise<ProposedAction> => {
    // Build a minimal context bundle from the loop state
    const observations = state.events
      .filter((e) => e.kind === "observation")
      .slice(-3)
      .map((e) => {
        const ps = e.payload.pageSummary as Record<string, unknown> | undefined;
        const texts = Array.isArray(ps?.visibleTexts) ? ps!.visibleTexts as string[] : undefined;
        return {
          url: String(e.payload.url ?? ""),
          title: String(e.payload.title ?? ""),
          forms: typeof ps?.forms === "number" ? ps.forms : 0,
          buttons: typeof ps?.buttons === "number" ? ps.buttons : 0,
          dialogs: typeof ps?.dialogs === "number" ? ps.dialogs : 0,
          visibleTexts: texts,
        };
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
      skills: [],
      observations,
      recentTraces,
      policyNotes: [],
    };

    // If an LLM provider is available, use it to decide the next action
    if (llmProvider) {
      const actionInstructions = [
        "Return exactly one next action as JSON.",
        'Use this shape: {"kind":"observe|exec|finish","summary":"short text","payload":{...}}.',
        'For "observe", omit payload unless you need {"targetId":"..."}',
        'For "exec", set payload.code to JavaScript that runs in the browser.',
        "Prefer direct URL patterns before brittle DOM hunting when the destination is obvious, such as /pricing or /docs.",
        "After navigating or running code, use 'observe' once to verify the result.",
        "For information retrieval tasks, extract the answer in a final successful exec as JSON or plain text so the trace contains the result.",
        "Use reusable routes, selectors, waits, and traps you discover in executable code; Wire will propose durable skill files after the run from trace evidence.",
        "Only use 'finish' after the latest observation or latest successful exec contains evidence that satisfies the objective.",
        "Do not wrap the JSON in prose.",
      ].join("\n");

      const systemPrompt = assembleSystemPrompt(context);
      const userPrompt = `${assembleUserPrompt(context)}\n\n${actionInstructions}`;

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
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

// ---------------------------------------------------------------------------
// parseActionFromLlm — extract a ProposedAction from LLM text output
// ---------------------------------------------------------------------------

function parseActionFromLlm(content: string, state: LoopState): ProposedAction {
  // Try to find a JSON action block in the response
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/u);
  const candidates = [
    jsonMatch?.[1],
    content.trim(),
    extractFirstJsonObject(content),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const parsed = tryParseAction(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const hasObservation = state.events.some((event) => event.kind === "observation");

  // Bias toward gathering evidence instead of silently finishing on malformed output.
  if (!hasObservation) {
    return {
      kind: "observe",
      summary: "Observe current browser state",
    };
  }

  return {
    kind: "finish",
    summary: `Model returned an invalid action payload: ${content.slice(0, 400)}`,
  };
}

function tryParseAction(content: string): ProposedAction | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (typeof parsed.kind === "string" && typeof parsed.summary === "string") {
      const action: ProposedAction = {
        kind: parsed.kind,
        summary: parsed.summary,
      };
      if (parsed.payload && typeof parsed.payload === "object" && parsed.payload !== null) {
        action.payload = parsed.payload as JsonObject;
      }
      return action;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractFirstJsonObject(content: string): string | undefined {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return content.slice(start, end + 1);
}

async function appendSkillProposalEvents(state: LoopState, skillDir?: string): Promise<void> {
  const alreadyProposed = state.events.some((event) => event.kind === "skill-proposal");
  if (alreadyProposed) {
    return;
  }

  const candidates = detectPromotionCandidates(state.events, state.run.id);
  for (const candidate of candidates) {
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
        payload.path = await promoteSkill(candidate, skillDir);
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
}

// ---------------------------------------------------------------------------
// executeTask — run an agent loop to completion
// ---------------------------------------------------------------------------

export async function executeTask(
  task: Task,
  config: RuntimeConfig,
  agentTurn?: AgentTurnFn,
): Promise<LoopResult> {
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider);

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
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider);
  const state: LoopState = {
    task: checkpoint.task,
    run: checkpoint.run,
    sessionId: checkpoint.sessionId,
    events: checkpoint.events,
    stepCount: checkpoint.stepCount,
    startedAt: checkpoint.startedAt,
  };

  return executeWithState(checkpoint.task, config, turn, undefined, state, checkpoint.pendingAction);
}

async function executeWithState(
  task: Task,
  config: RuntimeConfig,
  turn: AgentTurnFn,
  session?: BrowserSession,
  initialState?: LoopState,
  approvedPendingAction?: ProposedAction,
): Promise<LoopResult> {
  let state = initialState ?? createLoopState(task, session!.id);

  // Track stop signal sources across steps
  let policyDenied = false;
  let authWallHit = false;
  let awaitingApproval = false;
  let pendingApproval: LoopResult["pendingApproval"];
  let pendingAction: LoopResult["pendingAction"];

  try {
    if (approvedPendingAction) {
      const resumedStep = await executeStep(
        state,
        approvedPendingAction,
        config.provider,
        config.policyEngine,
        { skipPolicyCheck: true },
      );
      state = resumedStep.state;
      authWallHit = resumedStep.authWallHit;
    } else if (!initialState) {
      // SPECS §15.4: every run must trace "loaded skills".
      // For now, record the skill-load attempt (no skill loading yet).
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: new Date().toISOString(),
        kind: "skill-load",
        payload: { skills: [], source: config.skillDir ?? "none" },
      });

      // Fresh start: observe the current browser state before the first agent turn.
      // SPECS §19.1 step 5, §28 — "observation before first action".
      // This is setup, not an agent step — do not count against the step budget.
      const observation = await observeBrowser({
        provider: config.provider,
        sessionId: state.sessionId,
      });
      const obsPayload: JsonObject = {
        url: observation.url,
        title: observation.title,
      };
      if (observation.targetId) obsPayload.targetId = observation.targetId;
      if (observation.tabs.length > 0) obsPayload.tabs = observation.tabs;
      if (observation.focusedElement) obsPayload.focusedElement = observation.focusedElement as unknown as JsonObject;
      if (observation.pageSummary) obsPayload.pageSummary = observation.pageSummary as unknown as JsonObject;

      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "observation",
        payload: obsPayload,
      } as TraceEvent);
      authWallHit = detectAuthWall(observation).detected;
    }

    while (true) {
      // Check stopping conditions
      const stopResult = shouldStop(state, {
        maxSteps: config.maxSteps,
        budgetExhausted: false,
        policyDenied,
        authWallHit,
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
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: new Date().toISOString(),
          kind: "thought-summary",
          payload: { summary: action.summary, kind: "finish" },
        });
        break;
      }

      // Execute the step
      try {
        const stepResult = await executeStep(state, action, config.provider, config.policyEngine);
        state = stepResult.state;
        policyDenied = stepResult.policyDenied;
        authWallHit = stepResult.authWallHit;

        if (stepResult.pendingApproval) {
          awaitingApproval = true;
          pendingApproval = stepResult.pendingApproval;
          pendingAction = stepResult.pendingAction;
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
        break;
      }
    }
  } finally {
    // Always clean up the browser session
    if (!awaitingApproval) {
      try {
        await stopBrowserSession(config.provider, state.sessionId);
      } catch {
        // Best-effort cleanup — don't mask the real result
      }
    }
  }

  const finalizeOptions = {
    authWallHit,
    policyDenied,
    budgetExhausted: false,
    awaitingApproval,
  } as const;

  if (pendingApproval) {
    const approvalOptions: {
      authWallHit: boolean;
      policyDenied: boolean;
      budgetExhausted: false;
      awaitingApproval: boolean;
      pendingApproval: NonNullable<typeof pendingApproval>;
      pendingAction?: ProposedAction;
    } = {
      ...finalizeOptions,
      pendingApproval,
    };
    if (pendingAction) {
      approvalOptions.pendingAction = pendingAction;
    }
    return finalizeRun(state, approvalOptions);
  }

  await appendSkillProposalEvents(state, config.skillDir);

  return finalizeRun(state, finalizeOptions);
}

// Re-export planning types for convenience
export { type TaskPlan, createPlan, advanceStep, isPlanComplete, planToContext } from "./planning.js";
