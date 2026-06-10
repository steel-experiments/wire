// ABOUTME: Run finalization — final contract check, skill proposals, and
// ABOUTME: building the classified LoopResult from accumulated trace events.
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { ProposedAction, TraceEvent } from "../shared/types.js";
import { updateSkillStatsFromRun } from "../skills/stats.js";
import {
  contractValidationPayload,
  validateTaskContract,
} from "./contract.js";
import {
  computeFinalClassification,
  deriveRunResult,
  finalizeRun,
  type LoopResult,
  type LoopState,
} from "./loop.js";
import { isWallClockTimeout } from "./run-limits.js";
import type { LoopSignals, RuntimeConfig } from "./runtime.js";
import { appendSkillProposalEvents } from "./skill-proposals.js";
import {
  appendTaskNoteArtifact,
  buildFailureSummary,
  hasRecordedTaskArtifact,
} from "./state-helpers.js";

type FlushTraceSink = (state: LoopState, config: RuntimeConfig, signals: LoopSignals) => Promise<void>;

function contractHasChecks(state: LoopState): boolean {
  return state.contract.mustVisit.length > 0 ||
    state.contract.mustMention.length > 0 ||
    state.contract.mustAnswer === true ||
    state.contract.mustProduce !== undefined ||
    state.contract.mustNotContain.length > 0;
}

function latestEventIndex(state: LoopState, predicate: (event: TraceEvent) => boolean): number {
  for (let i = state.events.length - 1; i >= 0; i--) {
    if (predicate(state.events[i]!)) return i;
  }
  return -1;
}

function recordFinalContractCheckIfNeeded(state: LoopState): void {
  if (state.task.mode !== "task" || !contractHasChecks(state)) return;

  const latestValidation = latestEventIndex(
    state,
    (event) => event.kind === "contract-check" && event.payload.phase === "validated",
  );
  const latestEvidence = latestEventIndex(
    state,
    (event) => event.kind === "code-result" || event.kind === "artifact" || event.kind === "observation",
  );
  if (latestValidation >= latestEvidence && latestValidation !== -1) return;

  const validation = validateTaskContract(
    state.contract,
    state.events,
    deriveRunResult(state.events, state.task.mode),
  );
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "contract-check",
    payload: contractValidationPayload(validation),
  });
}

export async function finalizeExecution(
  state: LoopState,
  config: RuntimeConfig,
  signals: LoopSignals,
  flushTraceSink: FlushTraceSink,
): Promise<LoopResult> {
  const finalizeOptions: {
    authWallHit: boolean;
    policyDenied: boolean;
    maxStepsReached: boolean;
    awaitingApproval: boolean;
    blockedByPolicy: boolean;
    userCancelled: boolean;
    timedOut?: boolean;
    schemaUnmet?: boolean;
    stopReason?: string;
  } = {
    authWallHit: signals.authWallHit,
    policyDenied: signals.policyDenied,
    maxStepsReached: signals.maxStepsReached,
    awaitingApproval: signals.awaitingApproval,
    blockedByPolicy: signals.blockedByPolicy,
    userCancelled: signals.userCancelled,
  };
  if (isWallClockTimeout(config.cancelSignal)) {
    finalizeOptions.timedOut = true;
  }
  if (state.schemaUnmet === true) {
    finalizeOptions.schemaUnmet = true;
  }
  if (signals.stopReason !== undefined) {
    finalizeOptions.stopReason = signals.stopReason;
  }

  if (signals.pendingApproval) {
    const approvalOptions: {
      authWallHit: boolean;
      policyDenied: boolean;
        maxStepsReached: boolean;
      awaitingApproval: boolean;
      pendingApproval: NonNullable<typeof signals.pendingApproval>;
      stopReason?: string;
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

  recordFinalContractCheckIfNeeded(state);

  // Only mint a skill from a run that verifiably completed its objective. A
  // skill captures durable, working browser knowledge; proposing one from any
  // lesser classification — errors and dead-ends, but also partial-success,
  // whose trajectory by definition did not fully work (live case: a query-echo
  // SERP dump classified partial-success and minted a skill teaching circular
  // SERP "verification") — would bake a broken trajectory into a reusable skill.
  const finalClassification = computeFinalClassification(state, finalizeOptions);
  if (
    config.skillPromotion !== "off" &&
    finalClassification.kind === "task-complete"
  ) {
    await appendSkillProposalEvents(state, config.skillDir, config.llmProvider, {
      completed: true,
    });
  }
  await flushTraceSink(state, config, signals);

  const result = finalizeRun(state, finalizeOptions);

  // Stats updates are skill-store WRITES (and can retire skills), so they are
  // gated like promotion: skillPromotion "off" promises a read-only store —
  // concurrent embedded runs must never race on shared stats files.
  if (config.skillDir && config.skillPromotion !== "off") {
    try {
      await updateSkillStatsFromRun(config.skillDir, result);
    } catch { /* best-effort — stats loss must never affect run outcome */ }
  }

  return result;
}
