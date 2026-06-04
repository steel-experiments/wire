import { createId, nowIsoUtc } from "../shared/ids.js";
import type { ProposedAction } from "../shared/types.js";
import {
  artifactReviewPayload,
  hasUnfixedArtifactReviewFailure,
  hasUnrecordedLatestTaskResult,
  reviewArtifacts,
  shouldReviewArtifacts,
  taskArtifactEvents,
} from "./artifact-review.js";
import {
  contractValidationPayload,
  validateTaskContract,
} from "./contract.js";
import { deriveRunResult, type LoopResult, type LoopState } from "./loop.js";
import {
  appendExtractedResultArtifact,
  appendTaskNoteArtifact,
  buildVerificationAction,
  hasAttemptedExtraction,
  hasExtractedTaskResult,
  hasPostNavigationExtraction,
  hasRecordedTaskArtifact,
  latestExtractionIsVerificationProbe,
} from "./state-helpers.js";
import type { RuntimeConfig } from "./runtime.js";

export interface FinishFlowSignals {
  policyDenied: boolean;
  authWallHit: boolean;
  antiBotRecoveryAttempted: boolean;
  maxStepsReached: boolean;
  awaitingApproval: boolean;
  userCancelled: boolean;
  pendingApproval: LoopResult["pendingApproval"];
  pendingAction: LoopResult["pendingAction"];
  flushedEvents: number;
}

type FlushTraceSink = (
  state: LoopState,
  config: RuntimeConfig,
  signals: FinishFlowSignals,
) => Promise<void>;

export type FinishFlowResult =
  | { kind: "execute"; action: ProposedAction }
  | { kind: "continue" }
  | { kind: "break" };

function finishEvent(state: LoopState, action: ProposedAction): void {
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "thought-summary",
    payload: { summary: action.summary, kind: "finish" },
  });
}

export async function handleFinishAction(
  state: LoopState,
  action: ProposedAction,
  config: RuntimeConfig,
  signals: FinishFlowSignals,
  flushTraceSink: FlushTraceSink,
): Promise<FinishFlowResult> {
  if (
    state.stepCount < 3 &&
    state.task.mode === "task" &&
    !hasRecordedTaskArtifact(state) &&
    !hasExtractedTaskResult(state) &&
    state.stepCount < config.maxSteps
  ) {
    return { kind: "execute", action: buildVerificationAction() };
  }

  if (
    state.task.mode === "task" &&
    !hasExtractedTaskResult(state) &&
    !hasRecordedTaskArtifact(state) &&
    !hasAttemptedExtraction(state) &&
    state.stepCount < config.maxSteps
  ) {
    return { kind: "execute", action: buildVerificationAction() };
  }

  if (
    state.task.mode === "task" &&
    hasExtractedTaskResult(state) &&
    !hasPostNavigationExtraction(state) &&
    !hasRecordedTaskArtifact(state) &&
    state.stepCount < config.maxSteps
  ) {
    return { kind: "execute", action: buildVerificationAction() };
  }

  if (state.task.mode !== "task") {
    finishEvent(state, action);
    await flushTraceSink(state, config, signals);
    return { kind: "break" };
  }

  if (
    latestExtractionIsVerificationProbe(state) &&
    state.extractionRepromptCount < 1 &&
    state.stepCount < config.maxSteps
  ) {
    state.extractionRepromptCount++;
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "thought-summary",
      payload: {
        reason: "A generic page snapshot was captured for verification. Now return the specific values the objective asks for as clean output fields (not the raw page text), then finish.",
      },
    });
    state.stepCount++;
    await flushTraceSink(state, config, signals);
    return { kind: "continue" };
  }

  if (
    hasExtractedTaskResult(state) &&
    (!hasRecordedTaskArtifact(state) || hasUnrecordedLatestTaskResult(state))
  ) {
    appendExtractedResultArtifact(state);
  } else if (!hasRecordedTaskArtifact(state)) {
    appendTaskNoteArtifact(state, action.summary);
  }

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
  if (!validation.passed && state.stepCount < config.maxSteps) {
    state.stepCount++;
    await flushTraceSink(state, config, signals);
    return { kind: "continue" };
  }

  if (hasUnfixedArtifactReviewFailure(state)) {
    if (state.stepCount < config.maxSteps) {
      state.stepCount++;
      await flushTraceSink(state, config, signals);
      return { kind: "continue" };
    }
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "thought-summary",
      payload: { reason: "Artifact review failed and no corrected artifact was produced" },
    });
    await flushTraceSink(state, config, signals);
    return { kind: "break" };
  }

  if (shouldReviewArtifacts(state, config)) {
    const artifactCount = taskArtifactEvents(state).length;
    const review = await reviewArtifacts(state, config);
    const payload = artifactReviewPayload(review, artifactCount);
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "artifact-review",
      payload,
    });
    if (payload.passed === false) {
      state.reviewFailureCount++;
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "thought-summary",
        payload: {
          kind: "artifact-repair-required",
          reason: "Artifact review failed; next action must repair the artifact using the listed problems.",
          problems: Array.isArray(payload.problems) ? payload.problems : [],
        },
      });
      if (state.reviewFailureCount <= 1 && state.stepCount < config.maxSteps) {
        state.stepCount++;
        await flushTraceSink(state, config, signals);
        return { kind: "continue" };
      }
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "thought-summary",
        payload: {
          reason: "Artifact review failed after retry budget",
          problems: Array.isArray(payload.problems) ? payload.problems : [],
        },
      });
      await flushTraceSink(state, config, signals);
      return { kind: "break" };
    }
  }

  finishEvent(state, action);
  await flushTraceSink(state, config, signals);
  return { kind: "break" };
}
