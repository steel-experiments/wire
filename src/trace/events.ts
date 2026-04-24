import type {
  ArtifactId,
  JsonObject,
  RunId,
  SkillId,
  TraceEvent,
  TraceEventKind,
} from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";

// ---------------------------------------------------------------------------
// Trace event creation helpers
// ---------------------------------------------------------------------------

function createTraceEvent(
  runId: RunId,
  kind: TraceEventKind,
  payload: JsonObject,
): TraceEvent {
  return {
    id: createId("event"),
    runId,
    ts: nowIsoUtc(),
    kind,
    payload,
  };
}

export function thoughtSummaryEvent(runId: RunId, summary: string): TraceEvent {
  return createTraceEvent(runId, "thought-summary", { summary });
}

export function observationEvent(
  runId: RunId,
  url: string,
  title: string,
  artifactIds?: ArtifactId[],
): TraceEvent {
  const payload: JsonObject = { url, title };
  if (artifactIds && artifactIds.length > 0) {
    payload.artifactIds = artifactIds;
  }
  return createTraceEvent(runId, "observation", payload);
}

export function codeExecEvent(
  runId: RunId,
  code: string,
  language: string = "typescript",
): TraceEvent {
  return createTraceEvent(runId, "code-exec", { code, language });
}

export function codeResultEvent(
  runId: RunId,
  ok: boolean,
  stdout?: string,
  stderr?: string,
  durationMs?: number,
): TraceEvent {
  const payload: JsonObject = { ok };
  if (stdout) payload.stdout = stdout;
  if (stderr) payload.stderr = stderr;
  if (durationMs !== undefined) payload.durationMs = durationMs;
  return createTraceEvent(runId, "code-result", payload);
}

export function artifactEvent(
  runId: RunId,
  artifactId: ArtifactId,
  kind: string,
  path: string,
): TraceEvent {
  return createTraceEvent(runId, "artifact", { artifactId, kind, path });
}

export function policyCheckEvent(
  runId: RunId,
  actionKind: string,
  result: string,
  reason?: string,
): TraceEvent {
  const payload: JsonObject = { actionKind, result };
  if (reason) payload.reason = reason;
  return createTraceEvent(runId, "policy-check", payload);
}

export function approvalRequestEvent(
  runId: RunId,
  approvalId: string,
  summary: string,
  consequences: string[],
): TraceEvent {
  return createTraceEvent(runId, "approval-request", {
    approvalId,
    summary,
    consequences,
  });
}

export function approvalResultEvent(
  runId: RunId,
  approvalId: string,
  decision: string,
): TraceEvent {
  return createTraceEvent(runId, "approval-result", {
    approvalId,
    decision,
  });
}

export function skillLoadEvent(
  runId: RunId,
  skillId: SkillId,
  scope: string,
  matchReason: string,
): TraceEvent {
  return createTraceEvent(runId, "skill-load", {
    skillId,
    scope,
    matchReason,
  });
}

export function skillProposalEvent(
  runId: RunId,
  skillId: SkillId,
  rationale: string,
): TraceEvent {
  return createTraceEvent(runId, "skill-proposal", {
    skillId,
    rationale,
  });
}

export function errorEvent(
  runId: RunId,
  message: string,
  code?: string,
): TraceEvent {
  const payload: JsonObject = { message };
  if (code) payload.code = code;
  return createTraceEvent(runId, "error", payload);
}

// ---------------------------------------------------------------------------
// Minimum trace policy check
// ---------------------------------------------------------------------------

export function checkMinimumTraceCoverage(
  events: TraceEvent[],
  runId: RunId,
): { valid: boolean; missing: string[] } {
  const missing: string[] = [];
  const runEvents = events.filter((e) => e.runId === runId);
  const kinds = new Set(runEvents.map((e) => e.kind));

  if (!kinds.has("code-exec")) missing.push("code-exec");
  if (!kinds.has("observation")) missing.push("observation");
  if (!kinds.has("policy-check")) missing.push("policy-check");

  return { valid: missing.length === 0, missing };
}
