import type {
  LoadedSkill,
  ActionId,
  ApprovalRequest,
  JsonObject,
  LlmUsage,
  ProposedAction,
  ProposedActionDetail,
  Run,
  RunId,
  SessionId,
  SessionConfig,
  ProfileId,
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
import {
  createHelperDiff,
  DEFAULT_HELPER_SOURCE,
  prependHelpers,
  validateHelperSource,
} from "../browser/helpers.js";
import { execRaw } from "../browser/raw.js";
import { classifyRun, generateOutcomeSummary } from "./classify.js";
import { detectAuthWall } from "../profiles/auth.js";
import { redactJsonObject } from "../shared/redact.js";
import { countConsecutiveUnchanged } from "./state-helpers.js";
import type { ActionExecutionContext } from "./actions.js";
import { createTaskContract, type TaskContract } from "./contract.js";
import type { CriticalPoint } from "./critical-points.js";
import { scoreRun, type RunScore } from "../eval/scoring.js";

const MAX_CDP_BATCH_COMMANDS = 80;
const DEFAULT_EXEC_TIMEOUT_MS = 12_000;
const APPROVAL_CODE_EXCERPT_MAX = 2000;
const NAVIGATION_CDP_METHODS = new Set(["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"]);
const INPUT_CDP_METHODS = new Set([
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.dispatchTouchEvent",
  "Input.dispatchDragEvent",
  "Input.insertText",
]);

function commandsIncludeNavigation(
  commands: ReadonlyArray<{ method?: unknown }>,
): boolean {
  return commands.some((c) => typeof c?.method === "string" && NAVIGATION_CDP_METHODS.has(c.method));
}

function commandsIncludeInput(commands: ReadonlyArray<{ method?: unknown }>): boolean {
  return commands.some((c) => typeof c?.method === "string" && INPUT_CDP_METHODS.has(c.method));
}

function isLikelyInteractionCode(code: string): boolean {
  return /\b(clickVisibleText|fillByLabel|dispatchEvent|MouseEvent|KeyboardEvent|PointerEvent|window\.open)\b|\.click\s*\(|\.submit\s*\(/u.test(code);
}

function summarizeRawCommand(cmd: { method: string; params?: JsonObject }): string {
  const p = cmd.params ?? {};
  if (cmd.method === "Input.dispatchMouseEvent") {
    const type = typeof p.type === "string" ? p.type : "mouse";
    const x = typeof p.x === "number" ? p.x : "?";
    const y = typeof p.y === "number" ? p.y : "?";
    const button = typeof p.button === "string" && p.button !== "none" ? ` ${p.button}` : "";
    return `${cmd.method} ${type}${button} @ ${x},${y}`;
  }
  if (cmd.method === "Input.dispatchKeyEvent") {
    const key = typeof p.key === "string" ? p.key : typeof p.code === "string" ? p.code : "key";
    const type = typeof p.type === "string" ? p.type : "dispatch";
    return `${cmd.method} ${type} ${key}`;
  }
  if (cmd.method === "Page.navigate") {
    const url = typeof p.url === "string" ? redactJsonObject({ url: p.url }).url : undefined;
    return url ? `${cmd.method} ${url}` : cmd.method;
  }
  return cmd.method;
}

function summarizeRawCommands(commands: Array<{ method: string; params?: JsonObject }>): string[] {
  return commands.slice(0, 6).map(summarizeRawCommand);
}

type TabSnapshot = { id: string; url: string; title: string };

function latestObservationPayload(state: LoopState): JsonObject | undefined {
  return [...state.events].reverse().find((e) => e.kind === "observation")?.payload;
}

function tabsFromPayload(payload: JsonObject | undefined): TabSnapshot[] {
  const raw = payload?.tabs;
  if (!Array.isArray(raw)) return [];
  const tabs: TabSnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const tab = item as JsonObject;
    if (typeof tab.id !== "string") continue;
    tabs.push({
      id: tab.id,
      url: typeof tab.url === "string" ? tab.url : "",
      title: typeof tab.title === "string" ? tab.title : "",
    });
  }
  return tabs;
}

function buildTabDrift(previous: JsonObject | undefined, current: JsonObject): JsonObject | undefined {
  if (!previous) return undefined;
  const previousTargetId = typeof previous.targetId === "string" ? previous.targetId : "";
  const currentTargetId = typeof current.targetId === "string" ? current.targetId : "";
  const previousTabs = tabsFromPayload(previous);
  const currentTabs = tabsFromPayload(current);
  const previousById = new Map(previousTabs.map((tab) => [tab.id, tab]));
  const currentById = new Map(currentTabs.map((tab) => [tab.id, tab]));
  const newTabs = currentTabs.filter((tab) => !previousById.has(tab.id));
  const closedTabs = previousTabs.filter((tab) => !currentById.has(tab.id));
  const targetChanged = !!previousTargetId && !!currentTargetId && previousTargetId !== currentTargetId;
  const countChanged = previousTabs.length !== currentTabs.length;
  if (!targetChanged && !countChanged && newTabs.length === 0 && closedTabs.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  if (targetChanged) parts.push(`selected tab changed ${previousTargetId} -> ${currentTargetId}`);
  if (countChanged) parts.push(`tab count ${previousTabs.length} -> ${currentTabs.length}`);
  if (newTabs.length > 0) parts.push(`new tab: ${newTabs.map((t) => t.url || t.title || t.id).join(", ")}`);
  if (closedTabs.length > 0) parts.push(`closed tab: ${closedTabs.map((t) => t.url || t.title || t.id).join(", ")}`);
  return {
    previousTargetId,
    currentTargetId,
    previousTabCount: previousTabs.length,
    currentTabCount: currentTabs.length,
    targetChanged,
    newTabs: newTabs as unknown as import("../shared/types.js").JsonValue,
    closedTabs: closedTabs as unknown as import("../shared/types.js").JsonValue,
    message: `Tab drift detected: ${parts.join("; ")}`,
  };
}

function withTabDrift(state: LoopState, payload: JsonObject): JsonObject {
  const tabDrift = buildTabDrift(latestObservationPayload(state), payload);
  if (!tabDrift) return payload;
  return { ...payload, tabDrift };
}

async function observeAndRecord(
  state: LoopState,
  provider: BrowserProvider,
  options: { targetId?: string; includeScreenshotArtifactId?: boolean } = {},
): Promise<{ authWallHit: boolean }> {
  const observeOptions: { provider: BrowserProvider; sessionId: SessionId; targetId?: string } = {
    provider,
    sessionId: state.sessionId,
  };
  if (options.targetId) observeOptions.targetId = options.targetId;
  const observation = await observeBrowser(observeOptions);
  const payloadOptions: { includeScreenshotArtifactId?: boolean } = {};
  if (options.includeScreenshotArtifactId !== undefined) {
    payloadOptions.includeScreenshotArtifactId = options.includeScreenshotArtifactId;
  }
  const payload = withTabDrift(
    state,
    toObservationPayload(observation, payloadOptions),
  );
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "observation",
    payload: redactJsonObject(payload),
  });
  if (observation.screenshotBase64) {
    state.latestScreenshotBase64 = observation.screenshotBase64;
  }
  return { authWallHit: detectAuthWall(observation).detected };
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
  const methods: string[] = [];
  const single = action.payload?.method;
  if (typeof single === "string") methods.push(single);
  const batch = action.payload?.commands;
  if (Array.isArray(batch)) {
    for (const cmd of batch) {
      const m = (cmd as { method?: unknown })?.method;
      if (typeof m === "string") methods.push(m);
    }
  }
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

export async function executeStep(
  state: LoopState,
  action: ProposedAction,
  provider: BrowserProvider,
  policyEngine: PolicyEngine,
  options: {
    skipPolicyCheck?: boolean;
    actionRegistry?: import("./actions.js").ActionRegistry;
    actionContext?: ActionExecutionContext;
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

  const actionId = createId("action");

  if (action.kind !== "observe" && action.kind !== "finish" && !options.skipPolicyCheck) {
    const execRisk = action.kind === "exec" && typeof action.payload?.code === "string"
      ? (await import("../policy/rules.js")).classifyExecRisk(action.payload.code)
      : undefined;
    const policyKind = typeof action.payload?.policyKind === "string"
      ? action.payload.policyKind
      : execRisk?.kind ?? action.kind;
    const policyAction: PolicyAction = {
      kind: policyKind,
      summary: action.summary,
    };
    if (action.payload) {
      policyAction.payload = action.payload as Record<string, unknown>;
    }
    const decision = policyEngine.check(actionId, policyAction);

    const policyPayload: JsonObject = { actionKind: action.kind, policyKind, result: decision.result };
    if (execRisk) {
      policyPayload.execRisk = {
        kind: execRisk.kind,
        reasons: execRisk.reasons,
      };
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

        if (result.ok && result.returnValue !== undefined) {
          try {
            const parsed = typeof result.returnValue === "string"
              ? JSON.parse(result.returnValue)
              : result.returnValue;
            if (parsed && Array.isArray(parsed.wireActions)) {
              const commands = parsed.wireActions.filter(
                (a: unknown) => typeof (a as Record<string, unknown>)?.method === "string" &&
                  (a as Record<string, unknown>).method !== "Runtime.evaluate",
              ).slice(0, MAX_CDP_BATCH_COMMANDS);
              if (commands.length > 0) {
                const commandsRequested = parsed.wireActions.length;
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
                    commandsRequested,
                    truncated: commandsRequested > commands.length,
                    returnValue: cdpResult as import("../shared/types.js").JsonValue,
                  },
                });
              }
            }
          } catch { /* returnValue wasn't valid JSON — ignore */ }
        }

        const wireActionsSignal = (() => {
          if (!result.ok || result.returnValue === undefined) return false;
          try {
            const parsed = typeof result.returnValue === "string"
              ? JSON.parse(result.returnValue)
              : result.returnValue;
            return Array.isArray(parsed?.wireActions) &&
              (commandsIncludeNavigation(parsed.wireActions) || commandsIncludeInput(parsed.wireActions));
          } catch { return false; }
        })();
        const wireBindingSignal = result.ok && result.wireEvents?.some((event) => event.action === "click");
        if (isLikelyNavigationCode(code) || wireActionsSignal || wireBindingSignal || (result.ok && isLikelyInteractionCode(code))) {
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
        const commandsRequested = commands.length;
        const commandsToRun = commands.slice(0, MAX_CDP_BATCH_COMMANDS);
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "code-exec",
          payload: redactJsonObject({
            rawCommands: commandsToRun.length,
            methods: commandsToRun.map((c) => c.method),
            summaries: summarizeRawCommands(commandsToRun),
          }),
        });

        let lastResult: unknown;
        let ok = true;
        const startedAt = Date.now();

        const steelProvider = provider as unknown as { rawBatch?(sessionId: SessionId, commands: Array<{ method: string; params?: Record<string, unknown> }>): Promise<unknown> };
        if (commandsToRun.length > 1 && steelProvider.rawBatch) {
          try {
            lastResult = await steelProvider.rawBatch(state.sessionId, commandsToRun);
          } catch (err) {
            ok = false;
            lastResult = err instanceof Error ? err.message : String(err);
          }
        } else {
          for (const cmd of commandsToRun) {
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
            source: "raw",
            commandsRequested,
            truncated: commandsRequested > commandsToRun.length,
            ...(ok ? { commandsExecuted: commandsToRun.length } : {}),
            returnValue: lastResult as unknown as import("../shared/types.js").JsonValue,
          },
        });

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
  return { state, policyDenied, authWallHit };
}

export interface FinalizeOptions {
  authWallHit?: boolean;
  policyDenied?: boolean;
  budgetExhausted?: boolean;
  maxStepsReached?: boolean;
  awaitingApproval?: boolean;
  userCancelled?: boolean;
  stopReason?: string;
  pendingApproval?: ApprovalRequest;
  pendingAction?: ProposedAction;
}

function looksLikeErrorReturn(returnValue: unknown): boolean {
  if (!returnValue || typeof returnValue !== "object" || Array.isArray(returnValue)) {
    return false;
  }
  const obj = returnValue as Record<string, unknown>;
  if (typeof obj["error"] === "string" && obj["error"].length > 0) return true;
  if (obj["clicked"] === false) return true;
  if (obj["success"] === false) return true;
  if (typeof obj["status"] === "string" && /error|fail|notfound/iu.test(obj["status"] as string)) return true;
  return false;
}

function hasMeaningfulPayload(payload: TraceEvent["payload"]): boolean {
  const stdout = payload["stdout"];
  if (typeof stdout === "string" && stdout.trim().length > 0) return true;
  const ret = payload["returnValue"];
  return hasMeaningfulValue(ret);
}

function hasMeaningfulValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(hasMeaningfulValue);
  if (typeof value !== "object") return false;

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return false;
  return entries.some(([key, entryValue]) => {
    if (key === "results" && Array.isArray(entryValue) && entryValue.length === 0) return false;
    if (key === "answer" && typeof entryValue === "string" && entryValue.trim().length === 0) return false;
    return hasMeaningfulValue(entryValue);
  });
}

function hasMeaningfulDerivedResult(result: string | undefined): boolean {
  if (result === undefined) return false;
  const trimmed = result.trim();
  if (trimmed.length === 0) return false;
  try {
    return hasMeaningfulValue(JSON.parse(trimmed) as unknown);
  } catch {
    return true;
  }
}

// Pre-dispatch wireActions envelope returned BY THE AGENT'S OWN CODE
// (e.g. `return {wireActions: [...]}`). Distinct from the post-dispatch
// CDP ack — those are filtered upstream via payload.source ∈ {"wireActions","raw"}.
function looksLikeWireCommand(returnValue: unknown): boolean {
  if (!returnValue || typeof returnValue !== "object" || Array.isArray(returnValue)) {
    return false;
  }
  return Array.isArray((returnValue as Record<string, unknown>)["wireActions"]);
}

export function deriveRunResult(events: TraceEvent[], mode: TaskMode): string | undefined {
  // Exclude wire's CDP-dispatch code-results entirely — those are control-plane
  // events ({frameId, loaderId} etc.), never the agent's answer. The source tag
  // is set by both the wireActions branch and the raw-action branch in executeStep.
  const candidates = [...events].reverse().filter((event) =>
    event.kind === "code-result" &&
    event.payload.ok === true &&
    event.payload.source !== "wireActions" &&
    event.payload.source !== "raw" &&
    (
      typeof event.payload.stdout === "string" ||
      event.payload.returnValue !== undefined
    )
  );

  // Three-tier preference: meaningful + not-error-shaped + not-a-wire-command,
  // then merely meaningful, then anything. Empty payloads ({}, [], "") and
  // agent-emitted wireActions envelopes don't answer the task.
  const nonWireCandidates = candidates.filter(
    (event) => !looksLikeWireCommand(event.payload.returnValue),
  );
  const latestAnswerEvent =
    nonWireCandidates.find((event) =>
      hasMeaningfulPayload(event.payload) &&
      !looksLikeErrorReturn(event.payload.returnValue)
    ) ??
    nonWireCandidates.find((event) => hasMeaningfulPayload(event.payload)) ??
    nonWireCandidates[0];

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

  const derivedResult = deriveRunResult(state.events, state.task.mode);
  let classification = classifyRun({
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

  if (
    options.maxStepsReached === true &&
    !hasMeaningfulDerivedResult(derivedResult) &&
    (
      classification.kind === "task-complete" ||
      classification.kind === "partial-success" ||
      classification.kind === "ambiguous"
    )
  ) {
    classification = {
      kind: "agent-error",
      confidence: 0.9,
      notes: ["Maximum steps reached before producing a meaningful answer"],
    };
  }

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

  const resultBlocked =
    (options.maxStepsReached === true && !hasMeaningfulDerivedResult(derivedResult)) ||
    (options.userCancelled === true && !hasMeaningfulDerivedResult(derivedResult));
  if (derivedResult !== undefined && !resultBlocked) {
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
    helperSource: state.helperSource,
    helperVersion: state.helperVersion,
    reviewFailureCount: state.reviewFailureCount,
    // Pass an empty artifacts list: scoring.ts evidenceScore reads from
    // events via OR-style fallbacks, so artifact-event presence still
    // contributes. The eval/CLI paths that have persisted Artifact records
    // can call scoreRun directly with the richer input.
    score: scoreRun(state.task, finishedRun, state.events, []),
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

  // Aggregate LLM usage from trace events
  const usageEvents = state.events.filter((e) => e.kind === "llm-usage");
  if (usageEvents.length > 0) {
    let promptTokens = 0;
    let completionTokens = 0;
    for (const e of usageEvents) {
      const u = e.payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      if (u) {
        promptTokens += u.inputTokens ?? 0;
        completionTokens += u.outputTokens ?? 0;
      }
    }
    result.usage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
    };
  }

  return result;
}
