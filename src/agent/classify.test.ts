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

  it("downgrades an interaction objective to partial when the trace never interacts", () => {
    // Live over-credit case: "complete the iframe inception challenge" judged
    // task-complete on {"answer":"Level 2 Iframe -> Level 3 Iframe"} — a
    // read-only trace. An objective that demands acting on the page cannot be
    // complete when every exec only navigated and read.
    const events = [
      makeEvent("code-exec", { code: "window.location.href = 'https://x.test/challenge'; return {navigated:true};" }),
      makeEvent("code-result", { ok: true, returnValue: { navigated: true } }),
      makeEvent("code-exec", { code: "return document.querySelector('h2').innerText;" }),
      makeEvent("code-result", { ok: true, stdout: "Level 2 Iframe -> Level 3 Iframe" }),
      makeEvent("artifact", { kind: "answer", content: "Level 2 Iframe -> Level 3 Iframe" }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      objective: "Go to the URL and complete the iframe inception challenge",
      events,
      errorCount: 0,
    }));
    assert.equal(result.kind, "partial-success");
    assert.ok(result.notes?.some((n) => /interaction/iu.test(n)));
  });

  it("keeps task-complete for an interaction objective when the trace interacted", () => {
    const events = [
      makeEvent("code-exec", { code: "await clickVisibleText('Start Bot'); return {started:true};" }),
      makeEvent("code-result", { ok: true, returnValue: { started: true } }),
      makeEvent("code-exec", { code: "return {score: 1234};" }),
      makeEvent("code-result", { ok: true, returnValue: { score: 1234 } }),
      makeEvent("artifact", { kind: "answer", content: "{\"score\":1234}" }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      objective: "Click Start Bot and report the final score",
      events,
      errorCount: 0,
    }));
    assert.equal(result.kind, "task-complete");
    assert.equal(result.confidence, 0.85);
  });

  it("watch-loop verbs are exempt from the interaction-evidence rule", () => {
    // play/refresh/poll tasks report structured per-cycle evidence and are
    // protected from repeat-semantics second-guessing — the classifier must
    // not demand click-shaped execs from them.
    const events = [
      makeEvent("code-exec", { code: "return collectRuns();" }),
      makeEvent("code-result", { ok: true, returnValue: { runs: [{ run: 1, status: "completed", over: true }] } }),
      makeEvent("artifact", { kind: "answer", content: "{\"runs\":1}" }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      objective: "play 2048 and refresh for new game 5 times",
      events,
      errorCount: 0,
    }));
    assert.equal(result.kind, "task-complete");
  });

  it("leaves extraction objectives untouched by the interaction-evidence rule", () => {
    const events = [
      makeEvent("code-exec", { code: "return document.body.innerText;" }),
      makeEvent("code-result", { ok: true, stdout: "User-Agent: x" }),
      makeEvent("artifact", { kind: "answer", content: "User-Agent: x" }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      objective: "Navigate to httpbin.org/headers and return the User-Agent header",
      events,
      errorCount: 0,
    }));
    assert.equal(result.kind, "task-complete");
  });

  it("interaction-evidence rule also gates the recovered task-complete path", () => {
    const events = [
      makeEvent("code-exec", { code: "return document.title;" }),
      makeEvent("code-result", { ok: false, error: "boom" }),
      makeEvent("code-exec", { code: "return document.title;" }),
      makeEvent("code-result", { ok: true, stdout: "Challenge page" }),
      makeEvent("artifact", { kind: "answer", content: "Challenge page" }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      objective: "Fill in the form and submit it",
      events,
      errorCount: 0,
    }));
    assert.equal(result.kind, "partial-success");
    assert.ok(result.notes?.some((n) => /interaction/iu.test(n)));
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

  it("classifies partial-success when the latest contract check failed", () => {
    const events = [
      makeEvent("code-result", { ok: true, stdout: "the answer" }),
      makeEvent("artifact", { kind: "answer", content: "the answer" }),
      makeEvent("contract-check", { passed: false, missing: ["Answer not extracted"] }),
    ];
    const result = classifyRun(makeInput({ mode: "task", events, errorCount: 0 }));
    assert.equal(result.kind, "partial-success");
    assert.equal(result.confidence, 0.55);
    assert.ok(result.notes?.includes("Completion contract failed"));
  });

  it("classifies task-complete when a failed contract check is superseded by a passing one", () => {
    const events = [
      makeEvent("code-result", { ok: true, stdout: "the answer" }),
      makeEvent("contract-check", { passed: false, missing: ["Answer not extracted"] }),
      makeEvent("artifact", { kind: "answer", content: "the answer" }),
      makeEvent("contract-check", { passed: true }),
    ];
    const result = classifyRun(makeInput({ mode: "task", events, errorCount: 0 }));
    assert.equal(result.kind, "task-complete");
    assert.equal(result.confidence, 0.85);
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
    assert.ok(result.notes?.some((n) => /generic failure shape/i.test(n)));
  });

  it("downgrades when the result is a search page echoing the query", () => {
    // The %22 artifacts show the agent read back its own percent-encoded query,
    // not extracted content.
    const dump = {
      matches: [
        "%22BUBBLE GUM%22 %22GREAT AMERICA%22 5K RACE CROSSWORD CLUE",
        "The Crossword Solver found 30 answers to \"%22bubble gum%22 %22Great America%22 5K race\", 6 letters crossword clue.",
        "5K race, perhaps",
      ],
      textSnippet: "Crossword Solver \n Dictionary \n Scrabble Word Finder \n sign in \n Advertisement",
    };
    const stdout = JSON.stringify(dump);
    const events = [
      makeEvent("code-result", { ok: true, stdout }),
      makeEvent("artifact", { kind: "json-output", content: stdout }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      events,
      objective: "What was the name of the 5K race hosted at the old Great America theme park in California that had 'bubble gum' in its title?",
    }));
    assert.equal(result.kind, "partial-success");
    assert.ok(result.notes?.some((n) => /generic failure shape/i.test(n)));
  });

  it("downgrades when result echoes a percent-encoded query instead of an answer", () => {
    // Isolates the %22 tell on a short result so the page-dump guard can't be
    // the thing firing.
    const stdout = JSON.stringify({ heading: "%22acme widget%22 specifications at DuckDuckGo", results: [] });
    const events = [
      makeEvent("code-result", { ok: true, stdout }),
      makeEvent("artifact", { kind: "json-output", content: stdout }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      events,
      objective: "find the specifications for the acme widget",
    }));
    assert.equal(result.kind, "partial-success");
    assert.ok(result.notes?.some((n) => /generic failure shape/i.test(n)));
  });

  it("downgrades when the result is a raw whole-page dump rather than an extracted answer", () => {
    // The agent pasted the page innerText (nav chrome, ads, boilerplate) instead
    // of extracting. A page dump doesn't prove an answer (MANIFESTO), even though
    // the answer text happens to be buried in it.
    const dump = [
      "Skip to main content",
      "Sign in   Subscribe",
      "Acme Corporation — Leadership Team",
      "Advertisement",
      "Our CEO is Jane Doe. ".repeat(70),
      "Privacy Policy   Terms of Service   All rights reserved 2026 Acme",
    ].join("\n");
    const events = [
      makeEvent("code-result", { ok: true, stdout: dump }),
      makeEvent("artifact", { kind: "note", content: dump }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      events,
      objective: "find the name of the CEO of Acme Corporation",
    }));
    assert.equal(result.kind, "partial-success");
    assert.ok(result.notes?.some((n) => /generic failure shape/i.test(n)));
  });

  it("keeps task-complete for a long structured extraction without page chrome", () => {
    // Guards against the page-dump check over-firing on legitimately large
    // structured results: length alone must not downgrade a clean extraction.
    const payload = JSON.stringify({
      hotels: Array.from({ length: 40 }, (_, i) => ({ name: `Hotel ${i}`, price: `$${100 + i}` })),
    });
    const events = [
      makeEvent("code-result", { ok: true, stdout: payload }),
      makeEvent("artifact", { kind: "json-output", content: payload }),
    ];
    const result = classifyRun(makeInput({
      mode: "task",
      events,
      objective: "search for hotels in San Francisco and extract names and prices",
    }));
    assert.equal(result.kind, "task-complete");
  });

  it("classifies structured task output without interpreting repeat semantics", () => {
    const payload = {
      runs: [
        { run: 1, status: "completed", score: 2872, over: true },
        { run: 2, status: "completed", score: 8728, over: true },
        { run: 3, status: "completed", score: 8520, over: true },
        { run: 4, status: "completed", score: 5120, over: true },
        { run: 5, status: "completed", score: 9664, over: true },
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
