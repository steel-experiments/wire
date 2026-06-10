import type { ZodTypeAny } from "zod";
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
import { deriveRunResult, type LoopState } from "./loop.js";
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
import type { LoopSignals, RuntimeConfig } from "./runtime.js";

// One shared shape: the loop, finish flow, and recovery all mutate the same
// run-level signal record (canonical definition: LoopSignals in runtime.ts).
export type FinishFlowSignals = LoopSignals;

type FlushTraceSink = (
  state: LoopState,
  config: RuntimeConfig,
  signals: FinishFlowSignals,
) => Promise<void>;

export type FinishFlowResult =
  | { kind: "execute"; action: ProposedAction }
  | { kind: "continue" }
  | { kind: "break" };

// How many times a finish may be rejected for failing the output schema before
// the run is allowed to finish anyway (and classified ambiguous).
const OUTPUT_SCHEMA_REPROMPT_LIMIT = 2;

// Validates the run's derived result against the configured output schema.
// The derived result is JSON-parsed when possible so object schemas match.
function validateOutputSchema(state: LoopState, schema: ZodTypeAny): { ok: boolean; errors: string } {
  const derived = deriveRunResult(state.events, state.task.mode);
  let candidate: unknown = derived;
  if (typeof derived === "string") {
    try {
      candidate = JSON.parse(derived);
    } catch {
      // Non-JSON result — validate the raw string against the schema as-is.
    }
  }
  const parsed = schema.safeParse(candidate);
  if (parsed.success) return { ok: true, errors: "" };
  const errors = parsed.error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, errors };
}

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

  // Output-schema gate: the result the caller will receive must satisfy the
  // configured schema. Reject and reprompt with the validation error up to a
  // bounded number of times; if it never conforms, finish anyway and let the
  // classifier mark the run ambiguous.
  if (config.outputSchema) {
    const schemaCheck = validateOutputSchema(state, config.outputSchema);
    if (!schemaCheck.ok) {
      if (state.schemaRepromptCount < OUTPUT_SCHEMA_REPROMPT_LIMIT && state.stepCount < config.maxSteps) {
        state.schemaRepromptCount++;
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: nowIsoUtc(),
          kind: "thought-summary",
          payload: {
            kind: "output-schema-unmet",
            reason: `The result does not match the required output schema. Return output matching the schema, then finish. Validation errors: ${schemaCheck.errors}`,
          },
        });
        state.stepCount++;
        await flushTraceSink(state, config, signals);
        return { kind: "continue" };
      }
      state.schemaUnmet = true;
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "thought-summary",
        payload: {
          kind: "output-schema-unmet",
          reason: `Output did not match the required schema after ${state.schemaRepromptCount} retries: ${schemaCheck.errors}`,
        },
      });
    }
  }

  finishEvent(state, action);
  await flushTraceSink(state, config, signals);
  return { kind: "break" };
}
