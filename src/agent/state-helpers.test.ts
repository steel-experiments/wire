// ABOUTME: Tests for the reconfigure gate — when a session reconfigure (proxy/captcha
// ABOUTME: swap) is justified by the current page, so Wire stops proxying unblocked pages.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { JsonObject, TraceEvent } from "../shared/types.js";
import { reconfigureJustified } from "./state-helpers.js";

function observation(payload: JsonObject): TraceEvent {
  return {
    id: createId("event"),
    runId: createId("run"),
    ts: nowIsoUtc(),
    kind: "observation",
    payload,
  };
}

const emptySummary: JsonObject = { headings: [], forms: 0, buttons: 0, dialogs: 0, tables: 0, links: 0, inputs: 0 };
const contentSummary: JsonObject = { headings: ["EDGAR Search Results"], forms: 1, buttons: 2, dialogs: 0, tables: 1, links: 30, inputs: 3 };

test("no observation yet is not a justified reconfigure", () => {
  assert.equal(reconfigureJustified(undefined), false);
});

test("pre-navigation about:blank is never a block", () => {
  assert.equal(
    reconfigureJustified(observation({ url: "about:blank", title: "about:blank", pageSummary: emptySummary })),
    false,
  );
});

test("empty url is not navigated, so not justified", () => {
  assert.equal(reconfigureJustified(observation({ url: "", title: "", pageSummary: emptySummary })), false);
});

test("chrome-error page is not an http(s) navigation, so not auto-proxied", () => {
  assert.equal(
    reconfigureJustified(observation({ url: "chrome-error://chromewebdata/", title: "Connection Error", pageSummary: emptySummary })),
    false,
  );
});

test("a loaded content page with no block signal is working — do not proxy it", () => {
  // This is the SEC EDGAR self-block case: results were on screen; a proxy swap discarded them.
  assert.equal(
    reconfigureJustified(observation({ url: "https://www.sec.gov/cgi-bin/browse-edgar", title: "EDGAR Search Results", pageSummary: contentSummary })),
    false,
  );
});

test("a navigated http(s) page that rendered nothing is a plausible block", () => {
  assert.equal(
    reconfigureJustified(observation({ url: "https://example.com/", title: "", pageSummary: emptySummary })),
    true,
  );
});

test("a genuine challenge page (title block signal) is justified even with content", () => {
  assert.equal(
    reconfigureJustified(observation({ url: "https://shop.example/", title: "Just a moment...", pageSummary: contentSummary })),
    true,
  );
});

test("a challenge signalled in a heading is justified", () => {
  assert.equal(
    reconfigureJustified(observation({
      url: "https://shop.example/",
      title: "Access",
      pageSummary: { ...emptySummary, headings: ["Verify you are human"], buttons: 1 },
    })),
    true,
  );
});

test("a plain http (non-https) navigated blank page is still navigated", () => {
  assert.equal(
    reconfigureJustified(observation({ url: "http://intranet.local/", title: "", pageSummary: emptySummary })),
    true,
  );
});
