import { describe, it } from "node:test";
import * as assert from "node:assert/strict";
import { createId } from "../shared/ids.js";
import type { TraceEvent, TaskMode, JsonObject } from "../shared/types.js";
import { classifyRun, generateOutcomeSummary, type ClassificationInput } from "./classify.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(kind: TraceEvent["kind"], payload: JsonObject): TraceEvent {
  return {
    id: createId("event"),
    runId: createId("run"),
    ts: new Date().toISOString(),
    kind,
    payload,
  };
}

function makeInput(overrides: Partial<ClassificationInput> = {}): ClassificationInput {
  return {
    mode: "task" as TaskMode,
    events: [],
    successCriteria: [],
    objective: "get the answer",
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// classifyRun
// ---------------------------------------------------------------------------

describe("classifyRun", () => {
  it("classifies awaitingApproval as ambiguous", () => {
    const result = classifyRun(makeInput({ awaitingApproval: true }));
    assert.equal(result.kind, "ambiguous");
    assert.equal(result.confidence, 0.85);
  });

  it("classifies infra-error when session error with no recovery", () => {
    const events = [
      makeEvent("error", { message: "Session crashed unexpectedly" }),
    ];
    const result = classifyRun(makeInput({ events }));
    assert.equal(result.kind, "infra-error");
    assert.equal(result.confidence, 0.85);
  });

  it("does not classify infra-error from a recovered crash observation sequence", () => {
    const events = [
      makeEvent("error", { message: "Session crashed unexpectedly" }),
      makeEvent("observation", { url: "https://example.com", title: "Example" }),
    ];
    const result = classifyRun(makeInput({ events }));
    assert.notEqual(result.kind, "infra-error");
  });

  it("classifies blocked-auth when captcha in URL", () => {
    const events = [
      makeEvent("observation", { url: "https://example.com/captcha", title: "Verify" }),
    ];
    const result = classifyRun(makeInput({ events }));
    assert.equal(result.kind, "blocked-auth");
    assert.equal(result.confidence, 0.8);
  });

  it("classifies site-error on 429 error", () => {
    const events = [
      makeEvent("error", { message: "429 Too Many Requests", code: "429" }),
    ];
    const result = classifyRun(makeInput({ events }));
    assert.equal(result.kind, "site-error");
    assert.equal(result.confidence, 0.85);
  });

  it("classifies infra-error on ETIMEDOUT", () => {
    const events = [
      makeEvent("error", { message: "ETIMEDOUT connection timed out", code: "ETIMEDOUT" }),
    ];
    const result = classifyRun(makeInput({ events }));
    assert.equal(result.kind, "infra-error");
    assert.equal(result.confidence, 0.85);
  });

  it("classifies policyDenied as agent-error", () => {
    const result = classifyRun(makeInput({ policyDenied: true }));
    assert.equal(result.kind, "agent-error");
    assert.equal(result.confidence, 0.95);
  });

  it("classifies authWallHit as blocked-auth", () => {
    const result = classifyRun(makeInput({ authWallHit: true }));
    assert.equal(result.kind, "blocked-auth");
    assert.equal(result.confidence, 0.9);
  });

  it("classifies budgetExhausted as ambiguous", () => {
    const result = classifyRun(makeInput({ budgetExhausted: true }));
    assert.equal(result.kind, "ambiguous");
    assert.equal(result.confidence, 0.6);
  });

  it("classifies high errors with code success as site-error", () => {
    const events = [
      makeEvent("code-exec", { code: "return 1" }),
      makeEvent("code-result", { ok: true, stdout: "1" }),
      makeEvent("code-exec", { code: "return 2" }),
      makeEvent("code-result", { ok: true, stdout: "2" }),
    ];
    const result = classifyRun(makeInput({ events, errorCount: 6 }));
    assert.equal(result.kind, "site-error");
    assert.equal(result.confidence, 0.7);
  });

  it("classifies high errors without code success as agent-error", () => {
    const events = [
      makeEvent("code-exec", { code: "return 1" }),
      makeEvent("code-result", { ok: false, stderr: "fail" }),
      makeEvent("code-exec", { code: "return 2" }),
      makeEvent("code-result", { ok: false, stderr: "fail" }),
    ];
    const result = classifyRun(makeInput({ events, errorCount: 6 }));
    assert.equal(result.kind, "agent-error");
    assert.equal(result.confidence, 0.7);
  });

  it("classifies task-complete in task mode with artifact and output", () => {
    const events = [
      makeEvent("code-result", { ok: true, stdout: "the answer" }),
      makeEvent("artifact", { kind: "answer", content: "the answer" }),
    ];
    const result = classifyRun(makeInput({ mode: "task", events, errorCount: 0 }));
    assert.equal(result.kind, "task-complete");
    assert.equal(result.confidence, 0.85);
  });

  it("classifies task-complete with errors at lower confidence", () => {
    const events = [
      makeEvent("code-result", { ok: true, stdout: "the answer" }),
      makeEvent("artifact", { kind: "answer", content: "the answer" }),
    ];
    const result = classifyRun(makeInput({ mode: "task", events, errorCount: 2 }));
    assert.equal(result.kind, "task-complete");
    assert.equal(result.confidence, 0.7);
  });

  it("classifies task-complete in investigate mode with evidence", () => {
    const events = [
      makeEvent("observation", { url: "https://example.com", title: "Example" }),
      makeEvent("observation", { url: "https://example.com/page", title: "Page" }),
      makeEvent("code-result", { ok: true, stdout: "data" }),
      makeEvent("artifact", { kind: "note", content: "findings" }),
    ];
    const result = classifyRun(makeInput({ mode: "investigate", events, errorCount: 0 }));
    assert.equal(result.kind, "task-complete");
  });

  it("classifies partial-success when code succeeds without output or artifact", () => {
    const events = [
      makeEvent("code-result", { ok: true }),
    ];
    const result = classifyRun(makeInput({ mode: "task", events, errorCount: 0 }));
    assert.equal(result.kind, "partial-success");
    assert.equal(result.confidence, 0.6);
  });

  it("classifies partial-success with mixed successes and failures", () => {
    const events = [
      makeEvent("code-result", { ok: true, stdout: "result" }),
      makeEvent("code-result", { ok: false, stderr: "error" }),
    ];
    const result = classifyRun(makeInput({ mode: "task", events, errorCount: 0 }));
    assert.equal(result.kind, "partial-success");
    assert.equal(result.confidence, 0.6);
  });

  it("classifies recovered to task-complete with answer artifact in task mode", () => {
    const events = [
      makeEvent("code-result", { ok: true, stdout: "the answer" }),
      makeEvent("code-result", { ok: false, stderr: "error" }),
      makeEvent("artifact", { kind: "answer", content: "final answer" }),
    ];
    const result = classifyRun(makeInput({ mode: "task", events, errorCount: 0 }));
    assert.equal(result.kind, "task-complete");
    assert.equal(result.confidence, 0.7);
  });

  it("does not downgrade artifact-backed task completion for stale observations", () => {
    const events = [
      makeEvent("observation", { url: "https://example.com", title: "Example" }),
      makeEvent("observation", { url: "https://example.com", title: "Example" }),
      makeEvent("observation", { url: "https://example.com", title: "Example" }),
      makeEvent("code-result", { ok: true, stdout: '{"objectiveVerified":true,"sessionOpen":true}' }),
      makeEvent("code-result", { ok: false, stderr: "Execution context was destroyed" }),
      makeEvent("artifact", { kind: "json-output", content: '{"objectiveVerified":true,"sessionOpen":true}' }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      events,
      objective: "verify objective and keep session open",
      consecutiveUnchanged: 5,
    }));
    assert.equal(result.kind, "task-complete");
    assert.equal(result.confidence, 0.7);
  });

  it("downgrades to partial-success when result has mostly empty extraction fields (grants.gov shape)", () => {
    // Repro of run_48b5ae4d-d1c9: result was a JSON object with named fields
    // (oppNumber, agency, deadline, awardCeiling, cfda) all empty strings,
    // plus a snippet that happened to contain 'intelligence' from the homepage.
    // Keyword check passed; structural check should reject.
    const stdout = JSON.stringify({
      url: "https://simpler.grants.gov/search?utm_source=Grants.gov",
      oppNumber: "",
      oppTitle: "",
      agency: "",
      deadline: "",
      awardCeiling: "",
      cfda: "",
      snippet: "Skip to main content. Search funding opportunities. artificial intelligence.",
    });
    const events = [
      makeEvent("code-result", { ok: true, stdout }),
      makeEvent("artifact", { kind: "json-output", content: stdout }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      events,
      errorCount: 0,
      objective: "Open grants.gov, search for active funding opportunities containing 'artificial intelligence', and return top 5 with agency, deadline, and CFDA number.",
    }));
    assert.equal(result.kind, "partial-success");
    assert.ok(result.notes?.some((n) => /does not.*address/i.test(n)));
  });

  it("downgrades task-complete to partial-success when output does not address objective", () => {
    const events = [
      makeEvent("code-result", { ok: true, stdout: '{"title":"Booking.com","url":"https://www.booking.com/"}' }),
      makeEvent("artifact", { kind: "json-output", content: '{"title":"Booking.com"}' }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      events,
      errorCount: 0,
      objective: "search for hotels in San Francisco and extract names and prices",
    }));
    assert.equal(result.kind, "partial-success");
    assert.ok(result.confidence < 0.6);
    assert.ok(result.notes?.some((n) => /does not.*address/i.test(n)));
  });

  it("credits structured iteration evidence for repeat objectives", () => {
    const payload = {
      runs: [
        { run: 1, score: 2872 },
        { run: 2, score: 8728 },
        { run: 3, score: 8520 },
        { run: 4, score: 5120 },
        { run: 5, score: 9664 },
      ],
      sessionOpen: true,
    };
    const events = [makeEvent("code-result", { ok: true, returnValue: payload })];
    const result = classifyRun(makeInput({
      mode: "task",
      events,
      objective: "play 2048 and achieve high score for 5 games",
    }));
    assert.equal(result.kind, "task-complete");
  });

  it("downgrades recovered task-complete when output does not address objective", () => {
    const events = [
      makeEvent("code-result", { ok: true, stdout: "some unrelated data" }),
      makeEvent("code-result", { ok: false, stderr: "error" }),
      makeEvent("artifact", { kind: "answer", content: "unrelated data" }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      events,
      errorCount: 0,
      objective: "search for hotels in San Francisco and extract names and prices",
    }));
    assert.equal(result.kind, "partial-success");
    assert.ok(result.notes?.some((n) => /does not.*address/i.test(n)));
  });

  it("classifies site-error when all code execs failed", () => {
    const events = [
      makeEvent("code-result", { ok: false, stderr: "error" }),
      makeEvent("code-result", { ok: false, stderr: "error" }),
    ];
    const result = classifyRun(makeInput({ events, errorCount: 0 }));
    assert.equal(result.kind, "site-error");
    assert.equal(result.confidence, 0.5);
  });

  it("classifies infra-error on E-prefix error codes", () => {
    const events = [
      makeEvent("error", { message: "Connection refused", code: "ECONNREFUSED" }),
    ];
    const result = classifyRun(makeInput({ events, errorCount: 0 }));
    assert.equal(result.kind, "infra-error");
    assert.equal(result.confidence, 0.8);
  });

  it("defaults to ambiguous with low confidence", () => {
    const result = classifyRun(makeInput());
    assert.equal(result.kind, "ambiguous");
    assert.equal(result.confidence, 0.3);
  });
});

// ---------------------------------------------------------------------------
// generateOutcomeSummary
// ---------------------------------------------------------------------------

describe("generateOutcomeSummary", () => {
  it("formats classification and event stats", () => {
    const classification = { kind: "task-complete" as const, confidence: 0.85 };
    const events = [
      makeEvent("code-exec", { code: "x" }),
      makeEvent("code-result", { ok: true, stdout: "x" }),
      makeEvent("observation", { url: "https://example.com", title: "Example" }),
      makeEvent("error", { message: "oops" }),
    ];
    const summary = generateOutcomeSummary(classification, events);
    assert.ok(summary.includes("task-complete"));
    assert.ok(summary.includes("0.85"));
    assert.ok(summary.includes("1 code executions"));
    assert.ok(summary.includes("1 observations"));
    assert.ok(summary.includes("Errors: 1"));
  });
});
