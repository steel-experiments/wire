import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  BrowserSession,
  JsonValue,
  RunCheckpoint,
  SessionId,
  Task,
  TraceEvent,
} from "../shared/types.js";

import type { BrowserObserveInput, BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";

import { classifyRun, generateOutcomeSummary } from "./classify.js";
import { defaultAgentTurn, executeTask, resumeTask } from "./runtime.js";
import {
  createLoopState,
  executeStep,
  finalizeRun,
  shouldStop,
  deriveRunResult,
} from "./loop.js";
import type { LoopState, StopConditions } from "./loop.js";
import { ActionRegistry } from "./actions.js";
import { writeSkillStats } from "../skills/stats.js";
import type { LLMProvider } from "../providers/llm/openai.js";
import {
  isNavigationOnlyResult,
  appendExtractedResultArtifact,
  hasPostNavigationExtraction,
  isRecoverableStepError,
  computeRepeatStreak,
  buildVerificationAction,
  latestExtractionIsVerificationProbe,
} from "./state-helpers.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Test task",
    mode: "task",
    objective: "Complete a test task",
    constraints: [],
    successCriteria: ["Page loads successfully"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSessionId(): SessionId {
  return createId("session");
}

function createMockProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    async createSession() {
      throw new Error("not implemented");
    },
    async getSession() {
      throw new Error("not implemented");
    },
    async stopSession() {
      throw new Error("not implemented");
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      return {
        sessionId: input.sessionId,
        url: "https://example.com",
        title: "Example",
        tabs: [
          { id: "tab-1", title: "Example", url: "https://example.com", active: true },
        ],
      };
    },
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      return {
        ok: true,
        stdout: "ok",
        durationMs: 10,
      };
    },
    ...overrides,
  };
}

function createMockPolicyEngine(overrides: Partial<PolicyEngine> = {}): PolicyEngine {
  return {
    check(_actionId, _action) {
      return {
        id: createId("policy"),
        actionId: _actionId,
        result: "allow",
      };
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createLoopState
// ---------------------------------------------------------------------------

test("isRecoverableStepError treats transient WebSocket failures as recoverable", () => {
  assert.equal(isRecoverableStepError("WebSocket error"), true);
});

test("classifyRun returns task-complete for all-successful code execs with observations", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com", title: "Example" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com/done", title: "Done" },
    },
  ];

  const result = classifyRun({
    mode: "investigate",
    events,
    successCriteria: ["Task completed"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "task-complete");
  assert.ok(result.confidence >= 0.8);
});

test("classifyRun ignores trailing bookkeeping events when checking terminal evidence", () => {
  // llm-usage (and other bookkeeping kinds) are appended during the turn that
  // proposes finish; they must not mask the evidence the run actually ended on.
  const runId = createId("run");
  const baseEvents: TraceEvent[] = [
    {
      id: createId("event"),
      runId,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true },
    },
    {
      id: createId("event"),
      runId,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com", title: "Example" },
    },
    {
      id: createId("event"),
      runId,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com/done", title: "Done" },
    },
  ];
  const bookkeeping: TraceEvent[] = [
    {
      id: createId("event"),
      runId,
      ts: new Date().toISOString(),
      kind: "llm-usage",
      payload: { inputTokens: 100, outputTokens: 20 },
    },
    {
      id: createId("event"),
      runId,
      ts: new Date().toISOString(),
      kind: "progress-ledger",
      payload: { entries: [], ledger: [], count: 0, total: 0 },
    },
  ];

  const input = {
    mode: "investigate" as const,
    successCriteria: ["Task completed"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  };
  const without = classifyRun({ ...input, events: baseEvents });
  const withBookkeeping = classifyRun({ ...input, events: [...baseEvents, ...bookkeeping] });

  assert.equal(without.kind, "task-complete");
  assert.equal(withBookkeeping.kind, without.kind);
  assert.equal(withBookkeeping.confidence, without.confidence);
});

test("classifyRun does not flag blocked-auth when an early captcha page was recovered from", () => {
  // A run that hit a challenge page, recovered, and completed with evidence
  // must classify on that evidence — not on the historical block.
  const runId = createId("run");
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com", title: "Just a moment... | Cloudflare" },
    },
    {
      id: createId("event"),
      runId,
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, returnValue: { answer: "42 items found" } },
    },
    {
      id: createId("event"),
      runId,
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com/results", title: "Results" },
    },
    {
      id: createId("event"),
      runId,
      ts: new Date().toISOString(),
      kind: "artifact",
      payload: { filename: "answer.md", content: "42 items found" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: ["Items counted"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  });

  assert.notEqual(result.kind, "blocked-auth");
});

test("classifyRun does not return task-complete when the latest evidence is missing", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://steel.dev/pricing", title: "Pricing" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10 },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: ["Pricing captured"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "partial-success");
  assert.match(result.notes?.[0] ?? "", /did not record a final answer or artifact/i);
});

test("classifyRun returns task-complete when the final exec extracts an answer", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://steel.dev/pricing", title: "Pricing" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://steel.dev/pricing", title: "Pricing" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true, durationMs: 10, stdout: "{\"plans\":[\"...\"]}" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: ["Pricing captured"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "task-complete");
});

test("classifyRun returns partial-success for code success with no evidence", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: ["Task completed"],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "partial-success");
  assert.ok(result.notes?.some((n) => /did not record a final answer or artifact/i.test(n)));
});

test("classifyRun returns ambiguous when awaiting approval", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    awaitingApproval: true,
  });

  assert.equal(result.kind, "ambiguous");
  assert.match(result.notes?.[0] ?? "", /Awaiting human approval/);
});

test("classifyRun returns partial-success for mixed results", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: true },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: false },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "partial-success");
  assert.ok(result.notes);
  assert.ok(result.notes!.length > 0);
});

test("classifyRun returns blocked-auth when auth wall hit", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 0,
    authWallHit: true,
    policyDenied: false,
  });

  assert.equal(result.kind, "blocked-auth");
  assert.ok(result.confidence >= 0.9);
});

test("classifyRun returns agent-error when policy denied", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: true,
  });

  assert.equal(result.kind, "agent-error");
});

test("classifyRun returns infra-error for network failures", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { code: "ECONNREFUSED", message: "Connection refused" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 1,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "infra-error");
});

test("classifyRun returns site-error for all-failed code execs", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-result",
      payload: { ok: false },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "site-error");
});

test("classifyRun returns ambiguous for empty events", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "ambiguous");
  assert.ok(result.confidence < 0.5);
});

test("classifyRun returns agent-error for high error count", () => {
  const result = classifyRun({
    mode: "task",
    events: [],
    successCriteria: [],
    errorCount: 10,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "agent-error");
});

// ---------------------------------------------------------------------------
// generateOutcomeSummary
// ---------------------------------------------------------------------------

test("generateOutcomeSummary includes classification and confidence", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "code-exec",
      payload: { code: "1+1" },
    },
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com" },
    },
  ];

  const summary = generateOutcomeSummary(
    { kind: "task-complete", confidence: 0.9 },
    events,
  );

  assert.ok(summary.includes("task-complete"));
  assert.ok(summary.includes("0.9"));
  assert.ok(summary.includes("1 code executions"));
  assert.ok(summary.includes("1 observations"));
});

test("generateOutcomeSummary includes notes when present", () => {
  const summary = generateOutcomeSummary(
    { kind: "ambiguous", confidence: 0.5, notes: ["No evidence", "Budget left"] },
    [],
  );

  assert.ok(summary.includes("No evidence"));
  assert.ok(summary.includes("Budget left"));
});

test("generateOutcomeSummary includes error count", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { message: "Failed" },
    },
  ];

  const summary = generateOutcomeSummary({ kind: "agent-error", confidence: 0.7 }, events);

  assert.ok(summary.includes("Errors: 1"));
});

// ---------------------------------------------------------------------------
// executeStep — raw CDP action policy gate
// ---------------------------------------------------------------------------

test("classifyRun returns infra-error when session crash is detected", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { message: "Session crashed unexpectedly", code: "session_crash" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 1,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "infra-error");
  assert.ok(result.confidence >= 0.8);
});

test("classifyRun returns blocked-auth when captcha indicators are present", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "observation",
      payload: { url: "https://example.com/recaptcha", title: "Recaptcha Challenge" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "blocked-auth");
  assert.ok(result.confidence >= 0.7);
});

test("classifyRun returns site-error when 429 error is detected", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { message: "429 Too Many Requests", code: "HTTP429" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 1,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "site-error");
  assert.ok(result.confidence >= 0.8);
});

test("classifyRun returns infra-error when ETIMEDOUT is detected", () => {
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: new Date().toISOString(),
      kind: "error",
      payload: { message: "connection timed out", code: "ETIMEDOUT" },
    },
  ];

  const result = classifyRun({
    mode: "task",
    events,
    successCriteria: [],
    errorCount: 1,
    authWallHit: false,
    policyDenied: false,
  });

  assert.equal(result.kind, "infra-error");
  assert.ok(result.confidence >= 0.8);
});

// ---------------------------------------------------------------------------
// tryParseAction — malformed LLM payload rejection
// ---------------------------------------------------------------------------
