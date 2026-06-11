// ABOUTME: Tests for semantic search-loop detection — counting search navigations
// ABOUTME: that never lead to an extraction, the pattern the action guards miss.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type { BrowserExecResult, BrowserObservation, TraceEvent } from "../shared/types.js";
import type { BrowserObserveInput } from "../browser/bridge.js";
import { countSearchesSinceExtraction, isSearchNavigationUrl } from "./search-loop.js";
import { executeTask } from "./runtime.js";
import { createMockPolicyEngine, createMockProvider, makeSessionId, makeTask } from "./fixtures.test.js";

function ev(kind: TraceEvent["kind"], payload: Record<string, unknown>): TraceEvent {
  return {
    id: createId("event"),
    runId: createId("run"),
    ts: "2026-06-11T00:00:00.000Z",
    kind,
    payload: payload as TraceEvent["payload"],
  };
}

test("isSearchNavigationUrl recognizes engines and query params, not content pages", () => {
  assert.equal(isSearchNavigationUrl("https://duckduckgo.com/?q=bubble+gum+5k"), true);
  assert.equal(isSearchNavigationUrl("https://www.bing.com/search?q=x"), true);
  assert.equal(isSearchNavigationUrl("https://www.google.com/search?q=x"), true);
  // A non-engine page carrying a literal query is still a search-shaped hop.
  assert.equal(isSearchNavigationUrl("https://www.wordplays.com/crossword-solver?query=5K-race"), true);
  assert.equal(isSearchNavigationUrl("https://example.com/docs/page"), false);
  assert.equal(isSearchNavigationUrl("https://www.iana.org/domains/example"), false);
  assert.equal(isSearchNavigationUrl("not a url"), false);
});

test("countSearchesSinceExtraction counts distinct search hops and dedupes re-observation", () => {
  const events = [
    ev("observation", { url: "https://duckduckgo.com/?q=first" }),
    // Same SERP observed again (post-exec auto-observe) — not a new search.
    ev("observation", { url: "https://duckduckgo.com/?q=first" }),
    ev("observation", { url: "https://duckduckgo.com/?q=second+try" }),
    ev("observation", { url: "https://www.wordplays.com/solver?q=second+try" }),
  ];
  assert.equal(countSearchesSinceExtraction(events), 3);
});

test("countSearchesSinceExtraction resets on a meaningful extraction", () => {
  const events = [
    ev("observation", { url: "https://duckduckgo.com/?q=race+name" }),
    ev("observation", { url: "https://duckduckgo.com/?q=race+name+1982" }),
    ev("code-result", { ok: true, stdout: "The race was called the Bubble Gum Blowout (source: archive page)." }),
    ev("observation", { url: "https://duckduckgo.com/?q=confirm+blowout" }),
  ];
  assert.equal(countSearchesSinceExtraction(events), 1);
});

test("countSearchesSinceExtraction does not reset on navigation acks or page material", () => {
  const pageDump = [
    "Skip to main content Sign in Subscribe",
    "x".repeat(1200),
    "Privacy Policy All rights reserved",
  ].join("\n");
  const events = [
    ev("observation", { url: "https://duckduckgo.com/?q=one" }),
    ev("code-result", { ok: true, returnValue: { navigated: true } }),
    ev("observation", { url: "https://duckduckgo.com/?q=two" }),
    // A wholesale innerText dump is page material, not an extraction.
    ev("code-result", { ok: true, stdout: pageDump }),
    ev("observation", { url: "https://duckduckgo.com/?q=three" }),
    // A reflected percent-encoded query is the SERP-trap shape.
    ev("code-result", { ok: true, stdout: 'results for "%22bubble%20gum%22%205K"' }),
  ];
  assert.equal(countSearchesSinceExtraction(events), 3);
});

test("executeTask nudges then aborts a semantic search loop (search→dump→re-search)", async () => {
  // Live case run_3383faa5: the agent oscillated between DuckDuckGo and SEO-spam
  // sites for 30 steps. Every turn used a new URL, new code, and new non-empty
  // content, so the action-signature guards never fired. The pattern-level
  // guard counts search navigations without a meaningful extraction: nudge at
  // 3, abort at 6.
  const task = makeTask({ objective: "What was the name of the bubble gum 5K race?" });
  const sessionId = makeSessionId();
  // Query-echo shaped dump: page material, never a meaningful extraction.
  const serpDump = 'results for "%22bubble%20gum%22%205K" — Only include results for this site';
  let observeCount = 0;
  let execCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      // First observation is the blank start page; afterwards each navigation
      // lands on a fresh search URL (new query every time).
      const url = observeCount === 1
        ? "about:blank"
        : `https://duckduckgo.com/?q=bubble+gum+5k+attempt+${observeCount}`;
      return {
        sessionId: input.sessionId,
        url,
        title: observeCount === 1 ? "about:blank" : `attempt ${observeCount} at DuckDuckGo`,
        tabs: [],
      };
    },
    async exec(): Promise<BrowserExecResult> {
      execCount++;
      // Odd execs navigate (nav ack); even execs dump the SERP (page material).
      return execCount % 2 === 1
        ? { ok: true, durationMs: 5, returnValue: { navigated: true } }
        : { ok: true, durationMs: 5, returnValue: serpDump };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 30 },
    async (state) => {
      const navTurn = state.stepCount % 2 === 0;
      return navTurn
        ? {
          kind: "exec",
          summary: `Search attempt ${state.stepCount}`,
          payload: { code: `window.location.href = "https://duckduckgo.com/?q=attempt+${state.stepCount}"; return {navigated:true};` },
        }
        : {
          kind: "exec",
          summary: "Read the results page",
          payload: { code: "return document.body.innerText;" },
        };
    },
  );

  const nudge = result.events.find((e) =>
    e.kind === "thought-summary" &&
    typeof e.payload["reason"] === "string" &&
    /searched .* without extracting/iu.test(String(e.payload["reason"]))
  );
  assert.ok(nudge, "the loop must record a search-loop nudge for the agent");

  const stop = result.events.find((e) =>
    e.kind === "thought-summary" &&
    typeof e.payload["reason"] === "string" &&
    /search/iu.test(String(e.payload["reason"])) &&
    /aborting to force re-plan/iu.test(String(e.payload["reason"]))
  );
  assert.ok(stop, "the loop must abort once the search loop keeps going past the nudge");
  assert.ok(result.stepCount < 30, `must bail well before maxSteps; used ${result.stepCount}`);
  assert.notEqual(result.run.status, "succeeded");
});
