import type { JsonObject, TraceEvent } from "../shared/types.js";
import { redactSecrets } from "../shared/redact.js";
import type { ChatMessage, LLMProvider } from "../providers/llm/types.js";
import { stripInjectionPatterns } from "./context.js";
import { contractToPrompt } from "./contract.js";
import { proposeCriticalPoints, reviewCriticalPoints } from "./critical-points.js";
import { deriveRunResult, type LoopState } from "./loop.js";
import { extractFirstJsonObject } from "./llm-parse.js";
import { recordLlmCall, tracingProvider, type LlmTraceOptions } from "./llm-trace.js";
import { hasExtractedTaskResult } from "./state-helpers.js";
import { progressLedgerText } from "./progress-ledger.js";

export interface ArtifactReviewResult {
  passed: boolean;
  problems: string[];
}

export interface ArtifactReviewConfig extends LlmTraceOptions {
  llmProvider?: LLMProvider;
  criticalPointReview?: boolean;
}

export function taskArtifactEvents(state: LoopState): TraceEvent[] {
  return state.events.filter((event) =>
    event.kind === "artifact" &&
    event.payload.source !== "task-summary" &&
    typeof event.payload.content === "string" &&
    event.payload.content.trim().length > 0
  );
}

export function hasUnrecordedLatestTaskResult(state: LoopState): boolean {
  if (!hasExtractedTaskResult(state)) return false;
  const latestResultIndex = state.events.findLastIndex((event) => event.kind === "code-result");
  const latestArtifactIndex = state.events.findLastIndex((event) =>
    event.kind === "artifact" &&
    event.payload.source !== "task-summary"
  );
  return latestResultIndex > latestArtifactIndex;
}

function latestReviewedArtifactCount(state: LoopState): number {
  const review = [...state.events].reverse().find((event) =>
    event.kind === "artifact-review" &&
    typeof event.payload.artifactCount === "number"
  );
  return typeof review?.payload.artifactCount === "number" ? review.payload.artifactCount : 0;
}

export function hasUnfixedArtifactReviewFailure(state: LoopState): boolean {
  const review = [...state.events].reverse().find((event) =>
    event.kind === "artifact-review" &&
    typeof event.payload.artifactCount === "number"
  );
  return review?.payload.passed === false &&
    taskArtifactEvents(state).length <= Number(review.payload.artifactCount);
}

export function shouldReviewArtifacts(state: LoopState, config: ArtifactReviewConfig): boolean {
  if (!config.llmProvider) return false;
  if (state.task.mode !== "task") return false;
  // Review whenever a fresh task artifact exists. The reviewer judges against
  // the objective (always present), not just the inferred contract — gating on
  // contract presence skipped review for bare factoid/Q&A tasks, the exact case
  // where the agent is most likely to pass off a junk page as the answer.
  return taskArtifactEvents(state).length > latestReviewedArtifactCount(state);
}

const REVIEWER_ARTIFACT_BYTES = 50_000;
const REVIEWER_MAX_ARTIFACTS = 3;

function capForReviewer(text: string): string {
  return text.length <= REVIEWER_ARTIFACT_BYTES ? text : text.slice(0, REVIEWER_ARTIFACT_BYTES);
}

function artifactDedupeKey(event: TraceEvent): string {
  const filename = typeof event.payload.filename === "string" && event.payload.filename.length > 0
    ? event.payload.filename
    : undefined;
  if (filename) return filename;
  const kind = typeof event.payload.kind === "string" && event.payload.kind.length > 0
    ? event.payload.kind
    : undefined;
  if (kind) return `kind:${kind}`;
  const path = typeof event.payload.path === "string" && event.payload.path.length > 0
    ? event.payload.path
    : undefined;
  if (path) return path;
  return "artifact";
}

function artifactDisplayName(event: TraceEvent): string {
  const filename = typeof event.payload.filename === "string" && event.payload.filename.length > 0
    ? event.payload.filename
    : undefined;
  if (filename) return filename;
  const path = typeof event.payload.path === "string" && event.payload.path.length > 0
    ? event.payload.path
    : undefined;
  if (path) return path;
  return "artifact";
}

export function dedupeArtifactEvents(events: TraceEvent[]): TraceEvent[] {
  const latest = new Map<string, TraceEvent>();
  for (const event of events) {
    const key = artifactDedupeKey(event);
    latest.delete(key);
    latest.set(key, event);
  }
  return [...latest.values()].slice(-REVIEWER_MAX_ARTIFACTS);
}

function reviewerEvidence(state: LoopState): { evidence: string; artifacts: string } {
  const sanitize = (text: string): string =>
    capForReviewer(stripInjectionPatterns(redactSecrets(text)));
  const artifacts = dedupeArtifactEvents(taskArtifactEvents(state)).map((event) => {
    const label = artifactDisplayName(event);
    const content = typeof event.payload.content === "string" ? event.payload.content : "";
    return `Artifact: ${label}\n${sanitize(content)}`;
  }).join("\n\n");
  const result = deriveRunResult(state.events, state.task.mode);
  const ledger = state.progressLedger.length > 0
    ? `\n\nProgress ledger:\n${sanitize(progressLedgerText(state.progressLedger))}`
    : "";
  const evidence = `${result ? sanitize(result) : "(none)"}${ledger}`;
  return { evidence, artifacts };
}

export function artifactReviewPrompt(state: LoopState): string {
  const { evidence, artifacts } = reviewerEvidence(state);
  return [
    "Review the final artifact against the objective and completion contract.",
    "Return strict JSON only: {\"passed\": boolean, \"problems\": string[]}.",
    "Flag concrete artifact quality problems, wrong-field values, obvious misplaced text, placeholders, missing requested data, or tables that do not answer the task.",
    "Phrase every problem as expected-versus-observed: what the objective requires, then what the artifact actually contains or lacks. Never restate the requirement alone — each problem is a repair instruction.",
    "Do not require perfection or external browsing. Do not invent facts. Use only the artifact and trace evidence below.",
    "",
    `Objective: ${state.task.objective}`,
    `Completion contract:\n${contractToPrompt(state.contract)}`,
    `Recent extracted evidence:\n${evidence}`,
    `Final artifact content:\n${artifacts}`,
  ].join("\n");
}

function parseArtifactReview(content: string): ArtifactReviewResult | undefined {
  const candidates = [content.trim(), extractFirstJsonObject(content)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const obj = parsed as Record<string, unknown>;
      if (typeof obj.passed !== "boolean") continue;
      const problems = Array.isArray(obj.problems)
        ? obj.problems.map(String).filter((item) => item.trim().length > 0).slice(0, 8)
        : [];
      return { passed: obj.passed, problems };
    } catch {
      // Try next candidate.
    }
  }
  return undefined;
}

export async function reviewWithCriticalPoints(
  state: LoopState,
  llm: LLMProvider,
  traceOptions?: LlmTraceOptions,
): Promise<ArtifactReviewResult | undefined> {
  let points = state.criticalPoints;
  if (points === undefined) {
    points = await proposeCriticalPoints(state.task, tracingProvider(llm, state, traceOptions, "critical-points-propose"));
    state.criticalPoints = points;
  }
  if (points.length === 0) return undefined;
  const { evidence, artifacts } = reviewerEvidence(state);
  const review = await reviewCriticalPoints(
    state.task,
    points,
    `${evidence}\n\nArtifacts:\n${artifacts}`,
    tracingProvider(llm, state, traceOptions, "critical-points-review"),
  );
  return { passed: review.passed, problems: review.unmet.slice(0, 8) };
}

export async function reviewArtifacts(
  state: LoopState,
  config: ArtifactReviewConfig,
): Promise<ArtifactReviewResult | undefined> {
  if (!config.llmProvider) return undefined;
  if (config.criticalPointReview) {
    const critical = await reviewWithCriticalPoints(state, config.llmProvider, config);
    if (critical) return critical;
  }
  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are a terse artifact reviewer for a browser agent. Return only strict JSON.",
    },
    { role: "user", content: artifactReviewPrompt(state) },
  ];
  const response = await config.llmProvider.chat(messages, { maxTokens: 700 });
  await recordLlmCall(state, config, "artifact-review", messages, response);
  return parseArtifactReview(response.content);
}

export function artifactReviewPayload(
  review: ArtifactReviewResult | undefined,
  artifactCount: number,
): JsonObject {
  if (!review) {
    return {
      passed: true,
      problems: [],
      artifactCount,
      skipped: true,
      reason: "Artifact review response could not be parsed",
    };
  }
  return {
    passed: review.passed,
    problems: review.problems,
    artifactCount,
  };
}
