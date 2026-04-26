import type {
  LoadedSkill,
  ActionId,
  ApprovalRequest,
  JsonObject,
  ProposedAction,
  Run,
  RunId,
  SessionId,
  Task,
  TaskMode,
  TraceEvent,
} from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";

import type { BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { PolicyAction } from "../policy/rules.js";
import { createApprovalRequest } from "../policy/approvals.js";
import { stableJsonStringify } from "../shared/ids.js";

import { observeBrowser, toObservationPayload } from "../browser/observe.js";
import { execCode, isLikelyNavigationCode } from "../browser/exec.js";
import { execRaw } from "../browser/raw.js";
import { classifyRun, generateOutcomeSummary } from "./classify.js";
import { detectAuthWall } from "../profiles/auth.js";
import { redactJsonObject } from "../shared/redact.js";
import { countConsecutiveUnchanged } from "./state-helpers.js";

// ---------------------------------------------------------------------------
// Loop state — decomposed by time scale
// ---------------------------------------------------------------------------

/** Static input: task identity and browser session. */
interface TaskContext {
  task: Task;
  sessionId: SessionId;
  sessionLiveUrl?: string;
  loadedSkills: LoadedSkill[];
}

/** Accumulating trace: run metadata, events, timing. */
interface RunTrace {
  run: Run;
  events: TraceEvent[];
  startedAt: string;
}

/** Step counter: volatile budget tracking. */
interface StepCounter {
  stepCount: number;
}

/** Full loop state — composed from sub-interfaces. */
export interface LoopState extends TaskContext, RunTrace, StepCounter {
  /** Ephemeral screenshot from the latest observation — not persisted in traces. */
  latestScreenshotBase64?: string;
}

// ---------------------------------------------------------------------------
// Loop result
// ---------------------------------------------------------------------------

export interface LoopResult {
  run: Run;
  events: TraceEvent[];
  classification: ReturnType<typeof classifyRun>;
  outcomeSummary: string;
  sessionId: SessionId;
  sessionLiveUrl?: string;
  stepCount: number;
  startedAt: string;
  pendingApproval?: ApprovalRequest;
  pendingAction?: ProposedAction;
}

// ---------------------------------------------------------------------------
// Proposed action type (mirrors SPECS section 19.2)
// ---------------------------------------------------------------------------

export { type ProposedAction } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Agent turn function signature
// ---------------------------------------------------------------------------

export type AgentTurnFn = (
  state: LoopState,
  provider: BrowserProvider,
) => Promise<ProposedAction>;

// ---------------------------------------------------------------------------
// Create loop state
// ---------------------------------------------------------------------------

export function createLoopState(task: Task, sessionId: SessionId, sessionLiveUrl?: string): LoopState {
  const run: Run = {
    id: createId("run"),
    taskId: task.id,
    status: "running",
    startedAt: nowIsoUtc(),
  };

  const state: LoopState = {
    task,
    run,
    sessionId,
    loadedSkills: [],
    events: [],
    stepCount: 0,
    startedAt: nowIsoUtc(),
  };

  if (sessionLiveUrl !== undefined) {
    state.sessionLiveUrl = sessionLiveUrl;
  }

  return state;
}

// ---------------------------------------------------------------------------
// Stopping conditions
// ---------------------------------------------------------------------------

export interface StopConditions {
  maxSteps: number;
  budgetExhausted: boolean;
  policyDenied: boolean;
  authWallHit: boolean;
  userCancelled: boolean;
}

export function shouldStop(
  state: LoopState,
  conditions: StopConditions,
): { stop: boolean; reason?: string } {
  if (conditions.userCancelled) {
    return { stop: true, reason: "User cancelled" };
  }

  if (conditions.policyDenied) {
    return { stop: true, reason: "Policy denied further progress" };
  }

  if (conditions.authWallHit) {
    return { stop: true, reason: "Auth wall requires user assistance" };
  }

  if (conditions.budgetExhausted) {
    return { stop: true, reason: "Budget exhausted" };
  }

  if (state.stepCount >= conditions.maxSteps) {
    return { stop: true, reason: "Maximum steps reached" };
  }

  return { stop: false };
}

// ---------------------------------------------------------------------------
// Execute a single loop step
// ---------------------------------------------------------------------------

export async function executeStep(
  state: LoopState,
  action: ProposedAction,
  provider: BrowserProvider,
  policyEngine: PolicyEngine,
  options: { skipPolicyCheck?: boolean } = {},
): Promise<{
  state: LoopState;
  policyDenied: boolean;
  authWallHit: boolean;
  pendingApproval?: ApprovalRequest;
  pendingAction?: ProposedAction;
}> {
  let policyDenied = false;
  let authWallHit = false;

  const actionId = createId("action");

  // Policy check for non-trivial actions (everything except observe/finish)
  if (action.kind !== "observe" && action.kind !== "finish" && !options.skipPolicyCheck) {
    const policyKind = typeof action.payload?.policyKind === "string"
      ? action.payload.policyKind
      : action.kind;
    const policyAction: PolicyAction = {
      kind: policyKind,
      summary: action.summary,
    };
    if (action.payload) {
      policyAction.payload = action.payload as Record<string, unknown>;
    }
    const decision = policyEngine.check(actionId, policyAction);

    // Record policy check event
    const policyPayload: JsonObject = { actionKind: action.kind, result: decision.result };
    if (decision.reason) {
      policyPayload.reason = decision.reason;
    }
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "policy-check",
      payload: policyPayload,
    });

    if (decision.result === "deny") {
      policyDenied = true;
      return { state, policyDenied, authWallHit };
    }

    if (decision.result === "require-approval") {
      const approvalRequest = createApprovalRequest(
        state.run.id,
        actionId,
        action.summary,
        [`Execute action kind "${policyKind}"`],
      );

      // Record approval request event
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "approval-request",
        payload: {
          actionId,
          approvalId: approvalRequest.id,
          summary: action.summary,
          consequences: approvalRequest.consequences,
        },
      });

      return {
        state,
        policyDenied,
        authWallHit,
        pendingApproval: approvalRequest,
        pendingAction: action,
      };
    }
  }

  // Execute the action
  switch (action.kind) {
    case "observe": {
      const observeOptions: { provider: BrowserProvider; sessionId: SessionId; targetId?: string } = {
        provider,
        sessionId: state.sessionId,
      };
      const tid = action.payload?.targetId as string | undefined;
      if (tid) {
        observeOptions.targetId = tid;
      }

      const observation = await observeBrowser(observeOptions);

      const obsPayload = toObservationPayload(observation, { includeScreenshotArtifactId: true });

      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "observation",
        payload: redactJsonObject(obsPayload),
      });

      // Store screenshot ephemerally for multimodal LLM context
      if (observation.screenshotBase64) {
        state.latestScreenshotBase64 = observation.screenshotBase64;
      }

      authWallHit = detectAuthWall(observation).detected;
      break;
    }

    case "exec": {
      const code = action.payload?.code as string;
      if (code) {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "code-exec",
          payload: redactJsonObject({ code }),
        });

        const result = await execCode({
          provider,
          sessionId: state.sessionId,
          code,
        });

        const resultPayload: JsonObject = {
          ok: result.ok,
          durationMs: result.durationMs,
        };
        if (result.stdout) {
          resultPayload.stdout = result.stdout;
        }
        if (result.stderr) {
          resultPayload.stderr = result.stderr;
        }
        if (result.returnValue !== undefined) {
          resultPayload.returnValue = result.returnValue;
        }
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "code-result",
          payload: redactJsonObject(resultPayload),
        });

        // Check for wireActions: exec code returning CDP commands to execute
        if (result.ok && result.returnValue !== undefined) {
          try {
            const parsed = typeof result.returnValue === "string"
              ? JSON.parse(result.returnValue)
              : result.returnValue;
            if (parsed && Array.isArray(parsed.wireActions)) {
              const commands = parsed.wireActions.filter(
                (a: unknown) => typeof (a as Record<string, unknown>)?.method === "string",
              );
              if (commands.length > 0) {
                const steelProvider = provider as unknown as {
                  rawBatch?(sessionId: SessionId, commands: Array<{ method: string; params?: Record<string, unknown> }>): Promise<unknown>;
                };
                let cdpOk = true;
                let cdpResult: unknown;
                const cdpStart = Date.now();
                if (steelProvider.rawBatch) {
                  try {
                    cdpResult = await steelProvider.rawBatch(state.sessionId, commands);
                  } catch (err) {
                    cdpOk = false;
                    cdpResult = err instanceof Error ? err.message : String(err);
                  }
                } else {
                  for (const cmd of commands) {
                    try {
                      const execRawOpts: { provider: BrowserProvider; sessionId: SessionId; method: string; params?: JsonObject } = {
                        provider,
                        sessionId: state.sessionId,
                        method: (cmd as { method: string }).method,
                      };
                      const cmdParams = (cmd as { params?: JsonObject }).params;
                      if (cmdParams) execRawOpts.params = cmdParams;
                      cdpResult = await execRaw(execRawOpts);
                    } catch (err) {
                      cdpOk = false;
                      cdpResult = err instanceof Error ? err.message : String(err);
                      break;
                    }
                  }
                }
                state.events.push({
                  id: createId("event"),
                  runId: state.run.id,
                  ts: nowIsoUtc(),
                  kind: "code-result",
                  payload: {
                    ok: cdpOk,
                    durationMs: Date.now() - cdpStart,
                    source: "wireActions",
                    commandsExecuted: commands.length,
                    returnValue: cdpResult as import("../shared/types.js").JsonValue,
                  },
                });
              }
            }
          } catch { /* returnValue wasn't valid JSON — ignore */ }
        }

        // Auto-observe after navigation: when exec code navigates the page
        // (location.href/assign/replace), the code-result has no output and
        // the agent needs an observation of the new page before its next turn.
        const isNavigation = isLikelyNavigationCode(code);
        const producedOutput = result.ok && (
          (typeof result.stdout === "string" && result.stdout.length > 0) ||
          result.returnValue !== undefined
        );
        if (isNavigation && !producedOutput) {
          const observation = await observeBrowser({ provider, sessionId: state.sessionId });
          const obsPayload = toObservationPayload(observation);
          state.events.push({
            id: createId("event"),
            runId: state.run.id,
            ts: nowIsoUtc(),
            kind: "observation",
            payload: redactJsonObject(obsPayload),
          });
          if (observation.screenshotBase64) {
            state.latestScreenshotBase64 = observation.screenshotBase64;
          }
          authWallHit = detectAuthWall(observation).detected;
        }
      }
      break;
    }

    case "raw": {
      // Support both single command (method/params) and batch (commands array)
      const commands: Array<{ method: string; params?: JsonObject }> = [];
      const singleMethod = action.payload?.method as string | undefined;
      if (singleMethod) {
        const entry: { method: string; params?: JsonObject } = { method: singleMethod };
        const params = action.payload?.params as JsonObject | undefined;
        if (params) entry.params = params;
        commands.push(entry);
      }
      const batch = action.payload?.commands as Array<{ method: string; params?: JsonObject }> | undefined;
      if (Array.isArray(batch)) {
        for (const cmd of batch) {
          if (typeof cmd.method === "string") {
            const entry: { method: string; params?: JsonObject } = { method: cmd.method };
            if (cmd.params) entry.params = cmd.params;
            commands.push(entry);
          }
        }
      }

      if (commands.length > 0) {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "code-exec",
          payload: redactJsonObject({ rawCommands: commands.length, methods: commands.map((c) => c.method) }),
        });

        let lastResult: unknown;
        let ok = true;
        const startedAt = Date.now();

        // Use batch method if provider supports it (single connection for all commands)
        const steelProvider = provider as unknown as { rawBatch?(sessionId: SessionId, commands: Array<{ method: string; params?: Record<string, unknown> }>): Promise<unknown> };
        if (commands.length > 1 && steelProvider.rawBatch) {
          try {
            lastResult = await steelProvider.rawBatch(state.sessionId, commands);
          } catch (err) {
            ok = false;
            lastResult = err instanceof Error ? err.message : String(err);
          }
        } else {
          for (const cmd of commands) {
            try {
              const rawOpts: { provider: BrowserProvider; sessionId: SessionId; method: string; params?: JsonObject } = {
                provider,
                sessionId: state.sessionId,
                method: cmd.method,
              };
              if (cmd.params) rawOpts.params = cmd.params;
              lastResult = await execRaw(rawOpts);
            } catch (err) {
              ok = false;
              lastResult = err instanceof Error ? err.message : String(err);
              break;
            }
          }
        }

        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "code-result",
          payload: {
            ok,
            durationMs: Date.now() - startedAt,
            ...(ok ? { commandsExecuted: commands.length } : {}),
            returnValue: lastResult as unknown as import("../shared/types.js").JsonValue,
          },
        });
      }
      break;
    }

    case "finish": {
      // Terminal action - nothing to execute
      break;
    }

    default: {
      // Record thought summary or other actions
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "thought-summary",
        payload: { summary: action.summary, kind: action.kind },
      });
    }
  }

  state.stepCount++;
  return { state, policyDenied, authWallHit };
}

// ---------------------------------------------------------------------------
// Finalize a run
// ---------------------------------------------------------------------------

export interface FinalizeOptions {
  authWallHit?: boolean;
  policyDenied?: boolean;
  budgetExhausted?: boolean;
  awaitingApproval?: boolean;
  stopReason?: string;
  pendingApproval?: ApprovalRequest;
  pendingAction?: ProposedAction;
}

export function deriveRunResult(events: TraceEvent[], mode: TaskMode): string | undefined {
  const latestAnswerEvent = [...events].reverse().find((event) =>
    event.kind === "code-result" &&
    event.payload.ok === true &&
    (
      typeof event.payload.stdout === "string" ||
      event.payload.returnValue !== undefined
    )
  );

  if (latestAnswerEvent) {
    const stdout = latestAnswerEvent.payload.stdout;
    if (typeof stdout === "string" && stdout.trim().length > 0) {
      return stdout;
    }

    const returnValue = latestAnswerEvent.payload.returnValue;
    if (returnValue !== undefined) {
      return typeof returnValue === "string"
        ? returnValue
        : stableJsonStringify(returnValue);
    }
  }

  if (mode === "task") {
    const latestNoteArtifact = [...events].reverse().find((event) =>
      event.kind === "artifact" &&
      event.payload.kind === "note" &&
      typeof event.payload.content === "string" &&
      event.payload.content.trim().length > 0
    );

    if (latestNoteArtifact && typeof latestNoteArtifact.payload.content === "string") {
      return latestNoteArtifact.payload.content;
    }

    return undefined;
  }

  const latestFinishSummary = [...events].reverse().find((event) =>
    event.kind === "thought-summary" &&
    event.payload.kind === "finish" &&
    typeof event.payload.summary === "string" &&
    event.payload.summary.trim().length > 0
  );

  if (latestFinishSummary && typeof latestFinishSummary.payload.summary === "string") {
    return latestFinishSummary.payload.summary;
  }

  return undefined;
}

export function finalizeRun(state: LoopState, options: FinalizeOptions = {}): LoopResult {
  const errorCount = state.events.filter((e) => e.kind === "error").length;

  const classification = classifyRun({
    mode: state.task.mode,
    events: state.events,
    successCriteria: state.task.successCriteria,
    objective: state.task.objective,
    errorCount,
    authWallHit: options.authWallHit ?? false,
    policyDenied: options.policyDenied ?? false,
    budgetExhausted: options.budgetExhausted ?? false,
    awaitingApproval: options.awaitingApproval ?? false,
    consecutiveUnchanged: countConsecutiveUnchanged(state.events),
  });

  const outcomeSummary = generateOutcomeSummary(classification, state.events);

  let status: Run["status"] = "failed";
  if (options.awaitingApproval) {
    status = "awaiting-approval";
  } else if (classification.kind === "task-complete") {
    status = "succeeded";
  }

  const finishedRun: Run = {
    ...state.run,
    status,
    classification,
    outcomeSummary,
  };

  const derivedResult = deriveRunResult(state.events, state.task.mode);
  if (derivedResult !== undefined) {
    finishedRun.result = derivedResult;
  }

  if (!options.awaitingApproval) {
    finishedRun.finishedAt = nowIsoUtc();
  }

  const result: LoopResult = {
    run: finishedRun,
    events: state.events,
    classification,
    outcomeSummary,
    sessionId: state.sessionId,
    stepCount: state.stepCount,
    startedAt: state.startedAt,
  };

  if (state.sessionLiveUrl !== undefined) {
    result.sessionLiveUrl = state.sessionLiveUrl;
  }

  if (options.pendingApproval) {
    result.pendingApproval = options.pendingApproval;
  }
  if (options.pendingAction) {
    result.pendingAction = options.pendingAction;
  }

  return result;
}
