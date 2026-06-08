// ABOUTME: Embedded-mode entry point — run Wire unattended as a tool from a
// ABOUTME: parent agent, with safe defaults, a typed result, and provenance.
import type { z } from "zod";

import type { BrowserProvider } from "../browser/bridge.js";
import { createPolicyEngine, type PolicyEngine } from "../policy/engine.js";
import type { LLMProvider } from "../providers/llm/openai.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type {
  BrowserSession,
  CreateSessionInput,
  ResultProvenance,
  Run,
  RunClassification,
  Task,
  TraceEvent,
} from "../shared/types.js";
import { executeTask, type RuntimeConfig, type TraceSink } from "./runtime.js";

// A lightweight task description so callers don't have to author a full Task
// (mode, constraints, success criteria) just to fetch a page and extract data.
export interface EmbeddedRunInput {
  // What the run should accomplish, in plain language.
  objective: string;
  // Optional starting URL; prepended to the objective as a navigation step.
  url?: string;
  // Optional description of the data to extract; becomes a success criterion.
  extract?: string;
  // Explicit success criteria, if the objective/extract shorthand isn't enough.
  successCriteria?: string[];
}

// Embedded configuration. Only `provider` is strictly required; an `llmProvider`
// is required for any non-trivial run. The approval and skill-write defaults are
// the unattended-safe ones — override only deliberately.
export interface EmbeddedConfig<T = unknown> {
  provider: BrowserProvider;
  llmProvider?: LLMProvider;
  // Defaults to the baseline policy engine when omitted.
  policyEngine?: PolicyEngine;
  // When set, the result must validate against this schema; `data` is the
  // parsed value. A run that never conforms is classified `ambiguous`.
  outputSchema?: z.ZodType<T>;
  // Step budget for the agent loop. Defaults to 20.
  maxSteps?: number;
  // Hard wall-clock deadline for the run, in milliseconds.
  maxWallClockMs?: number;
  // Directory to load skills from (read-only here — promotion is off by
  // default so concurrent embedded runs never race on a shared skill store).
  skillDir?: string;
  sessionInput?: CreateSessionInput;
  existingSession?: BrowserSession;
  releaseExistingSessionOnExit?: boolean;
  cancelSignal?: AbortSignal;
  traceSink?: TraceSink;
  // Escape hatches for the embedded defaults below.
  onApprovalRequired?: "pause" | "deny" | "allow";
  skillPromotion?: "auto" | "off";
}

// The trimmed result a parent agent consumes: the outcome, the typed data, and
// the provenance backing it. Full `events` are included for callers that want
// the trace; everything else is a convenience projection of `run`.
export interface EmbeddedResult<T = unknown> {
  classification: RunClassification;
  data?: T;
  provenance?: ResultProvenance;
  outcomeSummary: string;
  result?: string;
  run: Run;
  events: TraceEvent[];
}

// Builds a full task from the lightweight embedded input.
export function embeddedTask(input: EmbeddedRunInput): Task {
  const objective = input.url ? `Go to ${input.url} and ${input.objective}` : input.objective;
  const successCriteria = input.successCriteria
    ?? (input.extract ? [`Extract: ${input.extract}`] : [`Complete: ${input.objective}`]);
  return {
    id: createId("task"),
    title: input.objective.slice(0, 80),
    mode: "task",
    objective,
    constraints: [],
    successCriteria,
    createdAt: nowIsoUtc(),
  };
}

// Runs Wire unattended on behalf of a parent agent. Applies the unattended-safe
// defaults (deny on required approval, no skill writes), enforces the optional
// output schema, and returns a typed, provenance-backed result instead of a
// trace the caller must mine. For safe concurrency, give each concurrent call
// its own `skillDir` (or leave skillPromotion off, the default).
export async function runEmbedded<T = unknown>(
  input: EmbeddedRunInput,
  config: EmbeddedConfig<T>,
): Promise<EmbeddedResult<T>> {
  const runtimeConfig: RuntimeConfig = {
    provider: config.provider,
    policyEngine: config.policyEngine ?? createPolicyEngine(),
    maxSteps: config.maxSteps ?? 20,
    onApprovalRequired: config.onApprovalRequired ?? "deny",
    skillPromotion: config.skillPromotion ?? "off",
  };
  if (config.llmProvider) runtimeConfig.llmProvider = config.llmProvider;
  if (config.outputSchema) runtimeConfig.outputSchema = config.outputSchema;
  if (config.maxWallClockMs !== undefined) runtimeConfig.maxWallClockMs = config.maxWallClockMs;
  if (config.skillDir !== undefined) runtimeConfig.skillDir = config.skillDir;
  if (config.sessionInput) runtimeConfig.sessionInput = config.sessionInput;
  if (config.existingSession) runtimeConfig.existingSession = config.existingSession;
  if (config.releaseExistingSessionOnExit !== undefined) {
    runtimeConfig.releaseExistingSessionOnExit = config.releaseExistingSessionOnExit;
  }
  if (config.cancelSignal) runtimeConfig.cancelSignal = config.cancelSignal;
  if (config.traceSink) runtimeConfig.traceSink = config.traceSink;

  const loopResult = await executeTask(embeddedTask(input), runtimeConfig);
  const { run } = loopResult;

  const result: EmbeddedResult<T> = {
    classification: loopResult.classification,
    outcomeSummary: loopResult.outcomeSummary,
    run,
    events: loopResult.events,
  };

  if (config.outputSchema) {
    const candidate = run.resultPayload ?? run.result;
    const parsed = config.outputSchema.safeParse(candidate);
    if (parsed.success) result.data = parsed.data;
  } else if (run.resultPayload !== undefined) {
    result.data = run.resultPayload as T;
  }

  if (run.resultProvenance) result.provenance = run.resultProvenance;
  if (run.result !== undefined) result.result = run.result;

  return result;
}
