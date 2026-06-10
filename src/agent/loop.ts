import type {
  LoadedSkill,
  ActionId,
  ApprovalRequest,
  JsonObject,
  LlmUsage,
  ProgressLedgerEntry,
  ProposedAction,
  ProposedActionDetail,
  Run,
  RunId,
  ScreenshotCapturePolicy,
  SessionId,
  SessionConfig,
  ProfileId,
  Task,
  TraceEvent,
} from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";

import type { BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { PolicyAction } from "../policy/rules.js";
import { createApprovalRequest } from "../policy/approvals.js";

import { execCode, isLikelyNavigationCode } from "../browser/exec.js";
import {
  createHelperDiff,
  DEFAULT_HELPER_SOURCE,
  prependHelpers,
  validateHelperSource,
} from "../browser/helpers.js";
import { classifyRun } from "./classify.js";
import { redactJsonObject } from "../shared/redact.js";
import { latestObservation, reconfigureJustified } from "./state-helpers.js";
import type { ActionExecutionContext } from "./actions.js";
import { createTaskContract, type TaskContract } from "./contract.js";
import type { CriticalPoint } from "./critical-points.js";
import type { RunScore } from "./scoring.js";
import {
  collectCdpMethods,
  commandsIncludeInput,
  commandsIncludeNavigation,
  executeRawActionCommands,
  executeWireActionsEnvelope,
  isLikelyInteractionCode,
  wireActionsSignal,
} from "./action-dispatch.js";
import { appendProgressLedgerEntries, progressEntriesFromExecResult } from "./progress-ledger.js";
import { observeAndRecord } from "./observation.js";
import { captureStepScreenshotArtifact } from "./screenshots.js";

const DEFAULT_EXEC_TIMEOUT_MS = 12_000;
const APPROVAL_CODE_EXCERPT_MAX = 2000;

function observationEventCount(state: LoopState): number {
  return state.events.filter((event) => event.kind === "observation").length;
}

function buildProposedActionDetail(
  action: ProposedAction,
  policyKind: string,
  execRiskKind: string | undefined,
  reason: string | undefined,
): ProposedActionDetail {
  const detail: ProposedActionDetail = { kind: action.kind };
  if (execRiskKind && execRiskKind !== action.kind) detail.riskKind = execRiskKind;
  else if (policyKind !== action.kind) detail.riskKind = policyKind;
  if (reason) detail.reason = reason;
  const code = action.payload?.code;
  if (typeof code === "string" && code.length > 0) {
    const redacted = redactJsonObject({ code }).code as string;
    if (redacted.length > APPROVAL_CODE_EXCERPT_MAX) {
      detail.codeExcerpt = redacted.slice(0, APPROVAL_CODE_EXCERPT_MAX);
      detail.truncated = true;
    } else {
      detail.codeExcerpt = redacted;
    }
  }
  const methods = collectCdpMethods(action.payload as Record<string, unknown> | undefined);
  if (methods.length > 0) detail.cdpMethods = methods;
  return detail;
}

/** Static input: task identity and browser session. */
interface TaskContext {
  task: Task;
  sessionId: SessionId;
  sessionLiveUrl?: string;
  sessionConfig?: SessionConfig;
  profileId?: ProfileId;
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
  /** Task-local browser helper module source used as the exec preamble. */
  helperSource: string;
  helperVersion: number;
  /** Minimal task-derived completion contract. */
  contract: TaskContract;
  /** How many times the artifact reviewer has rejected so far this run. */
  reviewFailureCount: number;
  /** Run-scoped model-authored task evidence. In-memory for now; snapshots are
   *  emitted as trace events so a future durable store can replay the same data. */
  progressLedger: ProgressLedgerEntry[];
  /**
   * How many times the loop has nudged the agent to replace Wire's generic
   * verification capture with a task-specific extraction. Bounded so the nudge
   * can't loop. Ephemeral — re-initialized on resume.
   */
  extractionRepromptCount: number;
  /**
   * How many times the loop has rejected a finish for failing the configured
   * `outputSchema` and reprompted the agent to fix its output. Bounded so the
   * rejection can't loop. Ephemeral — re-initialized on resume.
   */
  schemaRepromptCount: number;
  /**
   * Set when the run produced a result that never satisfied the configured
   * `outputSchema` after exhausting the reprompt budget. Drives the `ambiguous`
   * classification. Ephemeral.
   */
  schemaUnmet?: boolean;
  /**
   * LLM-authored critical-point checklist, proposed once and cached for the
   * run so retried reviews don't re-propose it. `undefined` = not yet
   * proposed; `[]` = proposed and the objective has no verifiable points.
   * Ephemeral — re-derived on resume rather than persisted.
   */
  criticalPoints?: CriticalPoint[];
}

export interface LoopResult {
  run: Run;
  events: TraceEvent[];
  classification: ReturnType<typeof classifyRun>;
  outcomeSummary: string;
  sessionId: SessionId;
  sessionLiveUrl?: string;
  stepCount: number;
  startedAt: string;
  helperSource: string;
  helperVersion: number;
  /** Reviewer-retry counter at the moment the run paused/finished. Persisted
   *  through checkpoint so resume can't silently restart the cap. */
  reviewFailureCount: number;
  pendingApproval?: ApprovalRequest;
  pendingAction?: ProposedAction;
  usage?: LlmUsage;
  // Total + per-component evaluation score (classification, contract,
  // evidence, efficiency, policy). Same shape as `wire export` and
  // `wire review`, surfaced here so programmatic consumers don't have to
  // re-run scoreRun against persisted events.
  score?: RunScore;
}

export { type ProposedAction } from "../shared/types.js";

export type AgentTurnFn = (
  state: LoopState,
  provider: BrowserProvider,
) => Promise<ProposedAction>;

export function createLoopState(
  task: Task,
  sessionId: SessionId,
  sessionLiveUrl?: string,
  options?: { sessionConfig?: SessionConfig; profileId?: ProfileId },
): LoopState {
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
    helperSource: DEFAULT_HELPER_SOURCE,
    helperVersion: 0,
    contract: createTaskContract(task),
    reviewFailureCount: 0,
    progressLedger: [],
    extractionRepromptCount: 0,
    schemaRepromptCount: 0,
  };

  if (sessionLiveUrl !== undefined) {
    state.sessionLiveUrl = sessionLiveUrl;
  }

  if (options?.sessionConfig) {
    state.sessionConfig = options.sessionConfig;
  }

  if (options?.profileId) {
    state.profileId = options.profileId;
  }

  return state;
}

export interface StopConditions {
  maxSteps: number;
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

  if (state.stepCount >= conditions.maxSteps) {
    return { stop: true, reason: "Maximum steps reached" };
  }

  return { stop: false };
}

// How many consecutive observations must land on the same auth-walled host
// before the run stops for user assistance. SPECS §22.3 forbids improvising
// credential entry, not trying a different source — so the first hit nudges
// the agent to route around the wall, and only still being on the same wall
// after that turn ends the run.
export const AUTH_WALL_STOP_STREAK = 2;

/** Auth-wall accounting carried in the loop signals. */
export interface AuthWallSignals {
  /** True only when the wall has persisted long enough to end the run. */
  authWallHit: boolean;
  /** Consecutive auth-wall observations on the same host. */
  authWallStreak: number;
  /** Host of the wall the streak is counting. */
  authWallHost: string | undefined;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Fold one observation's auth-wall detection into the loop signals.
 *
 * An auth wall on a single candidate source is a dead end to route around,
 * not a task blocker: the first hit records a nudge the agent sees on its
 * next turn and leaves `authWallHit` false. Only when the following
 * observation is still an auth wall on the same host does `authWallHit`
 * become true and stop the run for user assistance. A wall on a different
 * host starts a fresh streak — two paywalled sources in a row do not prove
 * the task itself is auth-blocked.
 */
export function applyAuthWallSignal(
  state: LoopState,
  signals: AuthWallSignals,
  detected: boolean,
): void {
  if (!detected) {
    signals.authWallHit = false;
    signals.authWallStreak = 0;
    signals.authWallHost = undefined;
    return;
  }

  const observation = latestObservation(state);
  const url = typeof observation?.payload.url === "string" ? observation.payload.url : "";
  const host = hostnameOf(url);
  signals.authWallStreak = host === signals.authWallHost ? signals.authWallStreak + 1 : 1;
  signals.authWallHost = host;
  signals.authWallHit = signals.authWallStreak >= AUTH_WALL_STOP_STREAK;

  if (signals.authWallStreak === 1) {
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "thought-summary",
      payload: {
        kind: "auth-wall-detected",
        reason:
          `Auth wall detected at ${url || "the current page"}. Do not enter credentials. ` +
          "If the objective can be met from another source, go back and continue there; " +
          "staying on this sign-in page will end the run for user assistance.",
      },
    });
  }
}

export async function executeStep(
  state: LoopState,
  action: ProposedAction,
  provider: BrowserProvider,
  policyEngine: PolicyEngine,
  options: {
    skipPolicyCheck?: boolean;
    actionRegistry?: import("./actions.js").ActionRegistry;
    actionContext?: ActionExecutionContext;
    screenshotCapture?: ScreenshotCapturePolicy;
  } = {},
): Promise<{
  state: LoopState;
  policyDenied: boolean;
  authWallHit: boolean;
  pendingApproval?: ApprovalRequest;
  pendingAction?: ProposedAction;
}> {
  let policyDenied = false;
  let authWallHit = false;
  const observationCountBefore = observationEventCount(state);

  const actionId = createId("action");

  if (action.kind !== "observe" && action.kind !== "finish" && !options.skipPolicyCheck) {
    const execRisk = action.kind === "exec" && typeof action.payload?.code === "string"
      ? (await import("../policy/rules.js")).classifyExecRisk(action.payload.code)
      : undefined;
    // The kind the policy engine evaluates is always system-derived; a
    // model-authored payload.policyKind must never relabel the action.
    const policyKind = execRisk?.kind ?? action.kind;
    const policyAction: PolicyAction = {
      kind: policyKind,
      summary: action.summary,
    };
    if (action.payload) {
      policyAction.payload = action.payload as Record<string, unknown>;
    }
    const cdpMethods = collectCdpMethods(policyAction.payload);
    if (execRisk || cdpMethods.length > 0) {
      policyAction.metadata = {};
      if (execRisk) {
        policyAction.metadata.riskKind = execRisk.kind;
        policyAction.metadata.riskReasons = execRisk.reasons;
      }
      if (cdpMethods.length > 0) {
        policyAction.metadata.cdpMethods = cdpMethods;
      }
    }
    const decision = policyEngine.check(actionId, policyAction);

    const policyPayload: JsonObject = { actionKind: action.kind, policyKind, result: decision.result };
    if (execRisk) {
      policyPayload.execRisk = {
        kind: execRisk.kind,
        reasons: execRisk.reasons,
      };
    }
    if (cdpMethods.length > 0) {
      policyPayload.cdpMethods = cdpMethods;
    }
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
      const proposedDetail = buildProposedActionDetail(
        action,
        policyKind,
        execRisk?.kind,
        decision.reason,
      );
      const approvalRequest = createApprovalRequest(
        state.run.id,
        actionId,
        action.summary,
        [`Execute action kind "${policyKind}"`],
        proposedDetail,
      );

      const approvalEventPayload: JsonObject = {
        actionId,
        approvalId: approvalRequest.id,
        summary: action.summary,
        consequences: approvalRequest.consequences,
        proposedAction: proposedDetail as unknown as JsonObject,
      };
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "approval-request",
        payload: approvalEventPayload,
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

  // Reconfigure gate: refuse a session swap when the current page is not
  // actually blocked (pre-nav about:blank, or an already-loaded content page
  // with no anti-bot signal). This is a graceful refusal, NOT a policy denial —
  // it does not set policyDenied (which would stop the run); the agent sees the
  // refusal in the trace and continues by navigating/extracting instead.
  if (action.kind === "reconfigure" && !options.skipPolicyCheck && !reconfigureJustified(latestObservation(state))) {
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "thought-summary",
      payload: {
        kind: "reconfigure-refused",
        summary: action.summary,
        reason:
          "Reconfigure refused: the current page is not blocked (no navigation yet, or it already loaded with no anti-bot signal). Navigate and extract instead of switching the browser session.",
      },
    });
    // The refusal still consumes a step: each one burns an LLM call, and no
    // stuck-loop guard sees non-exec actions — without this a model that
    // keeps proposing reconfigure on an unblocked page loops forever.
    state.stepCount++;
    await captureStepScreenshotArtifact(state, provider, options.screenshotCapture, observationCountBefore);
    return { state, policyDenied, authWallHit };
  }

  switch (action.kind) {
    case "observe": {
      const tid = action.payload?.targetId as string | undefined;
      const obs = await observeAndRecord(state, provider, {
        includeScreenshotArtifactId: true,
        ...(tid ? { targetId: tid } : {}),
      });
      authWallHit = obs.authWallHit;
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
          code: prependHelpers(code, state.helperSource),
          timeoutMs: Math.min(
            DEFAULT_EXEC_TIMEOUT_MS,
            Math.max(
              1,
              Math.floor(
                typeof action.payload?.timeoutMs === "number" && Number.isFinite(action.payload.timeoutMs)
                  ? action.payload.timeoutMs
                  : DEFAULT_EXEC_TIMEOUT_MS,
              ),
            ),
          ),
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
        if (result.wireEvents && result.wireEvents.length > 0) {
          resultPayload.wireEvents = result.wireEvents;
        }
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "code-result",
          payload: redactJsonObject(resultPayload),
        });

        appendProgressLedgerEntries(
          state,
          progressEntriesFromExecResult(result.returnValue, result.stdout),
        );

        if (result.ok && result.returnValue !== undefined) {
          await executeWireActionsEnvelope(state, provider, result.returnValue);
        }

        const hasWireActionsSignal = result.ok && wireActionsSignal(result.returnValue);
        const wireBindingSignal = result.ok && result.wireEvents?.some((event) => event.action === "click");
        if (isLikelyNavigationCode(code) || hasWireActionsSignal || wireBindingSignal || (result.ok && isLikelyInteractionCode(code))) {
          const obs = await observeAndRecord(state, provider);
          if (obs.authWallHit) authWallHit = true;
        }
      }
      break;
    }

    case "edit-helper": {
      const source = typeof action.payload?.source === "string"
        ? action.payload.source
        : typeof action.payload?.code === "string"
          ? action.payload.code
          : "";
      const validation = validateHelperSource(source);
      if (!validation.ok) {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "error",
          payload: {
            message: `Helper edit rejected: ${validation.reason}`,
            code: "EHELPER",
          },
        });
        break;
      }

      const before = state.helperSource;
      state.helperSource = source.trimStart();
      state.helperVersion += 1;
      const artifactId = createId("artifact");
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "artifact",
        payload: {
          artifactId,
          kind: "helper-diff",
          mimeType: "text/x-diff",
          path: `artifacts/${artifactId}.diff`,
          helperVersion: state.helperVersion,
          content: createHelperDiff(before, state.helperSource),
        },
      });
      break;
    }

    case "raw": {
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
        const { ok, commandsToRun } = await executeRawActionCommands(state, provider, commands);
        if (ok && (commandsIncludeNavigation(commandsToRun) || commandsIncludeInput(commandsToRun))) {
          const obs = await observeAndRecord(state, provider);
          if (obs.authWallHit) authWallHit = true;
        }
      }
      break;
    }

    case "finish": {
      // Terminal action - nothing to execute
      break;
    }

    default: {
      const handler = options.actionRegistry?.get(action.kind);
      if (handler) {
        const result = await handler.execute(state, action, provider, options.actionContext);
        if (result.authWallHit) authWallHit = true;
        break;
      }
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
  await captureStepScreenshotArtifact(state, provider, options.screenshotCapture, observationCountBefore);
  return { state, policyDenied, authWallHit };
}

export {
  computeFinalClassification,
  deriveRunResult,
  finalizeRun,
  type FinalizeOptions,
} from "./loop-result.js";
