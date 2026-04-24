import type {
  ActionId,
  ApprovalRequest,
  JsonObject,
  ProposedAction,
  Run,
  RunId,
  SessionId,
  Task,
  TraceEvent,
} from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";

import type { BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { PolicyAction } from "../policy/rules.js";
import { createApprovalRequest } from "../policy/approvals.js";

import { observeBrowser } from "../browser/observe.js";
import { execCode } from "../browser/exec.js";
import { classifyRun, generateOutcomeSummary } from "./classify.js";
import { detectAuthWall } from "../profiles/auth.js";

// ---------------------------------------------------------------------------
// Loop state
// ---------------------------------------------------------------------------

export interface LoopState {
  task: Task;
  run: Run;
  sessionId: SessionId;
  events: TraceEvent[];
  stepCount: number;
  startedAt: string;
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

export function createLoopState(task: Task, sessionId: SessionId): LoopState {
  const run: Run = {
    id: createId("run"),
    taskId: task.id,
    status: "running",
    startedAt: nowIsoUtc(),
  };

  return {
    task,
    run,
    sessionId,
    events: [],
    stepCount: 0,
    startedAt: nowIsoUtc(),
  };
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

  // Policy check for exec actions
  if (action.kind === "exec" && !options.skipPolicyCheck) {
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
    const policyPayload: JsonObject = { actionKind: "exec", result: decision.result };
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

      const obsPayload: JsonObject = {
        url: observation.url,
        title: observation.title,
      };
      if (observation.targetId) {
        obsPayload.targetId = observation.targetId;
      }
      if (observation.tabs.length > 0) {
        obsPayload.tabs = observation.tabs;
      }
      if (observation.focusedElement) {
        obsPayload.focusedElement = observation.focusedElement as unknown as JsonObject;
      }
      if (observation.pageSummary) {
        obsPayload.pageSummary = observation.pageSummary as unknown as JsonObject;
      }
      if (observation.screenshotArtifactId) {
        obsPayload.screenshotArtifactId = observation.screenshotArtifactId;
      }

      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "observation",
        payload: obsPayload,
      });

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
          payload: { code },
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
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "code-result",
          payload: resultPayload,
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

export function finalizeRun(state: LoopState, options: FinalizeOptions = {}): LoopResult {
  const errorCount = state.events.filter((e) => e.kind === "error").length;

  const classification = classifyRun({
    events: state.events,
    successCriteria: state.task.successCriteria,
    errorCount,
    authWallHit: options.authWallHit ?? false,
    policyDenied: options.policyDenied ?? false,
    budgetExhausted: options.budgetExhausted ?? false,
    awaitingApproval: options.awaitingApproval ?? false,
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

  if (options.pendingApproval) {
    result.pendingApproval = options.pendingApproval;
  }
  if (options.pendingAction) {
    result.pendingAction = options.pendingAction;
  }

  return result;
}
