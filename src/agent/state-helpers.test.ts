// ABOUTME: Tests for the reconfigure gate — when a session reconfigure (proxy/captcha
// ABOUTME: swap) is justified by the current page, so Wire stops proxying unblocked pages.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { JsonObject, TraceEvent } from "../shared/types.js";
import { isNotFoundObservation, reconfigureJustified } from "./state-helpers.js";

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
  const event = observation({ url: "about:blank", title: "Page not found", pageSummary: emptySummary });
  assert.equal(isNotFoundObservation(event), false);
  assert.equal(reconfigureJustified(event), false);
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
  const event = observation({ url: "https://example.com/", title: "", pageSummary: emptySummary });
  assert.equal(isNotFoundObservation(event), false);
  assert.equal(reconfigureJustified(event), true);
});

test("a sparse Steel Docs page-not-found landing is detected and not reconfigured", () => {
  const event = observation({
    url: "https://docs.steel.dev/integrations/stripe-projects",
    title: "Page not found | Steel Docs",
    pageSummary: emptySummary,
  });
  assert.equal(isNotFoundObservation(event), true);
  assert.equal(reconfigureJustified(event), false);
});

test("an exact page-not-found title is detected when site navigation remains", () => {
  const event = observation({
    url: "https://docs.example.com/missing",
    title: "Page Not Found | Example Docs",
    pageSummary: { ...emptySummary, headings: ["Page Not Found"], links: 12 },
  });
  assert.equal(isNotFoundObservation(event), true);
  assert.equal(reconfigureJustified(event), false);
});

test("a conventional 404 Not Found title is detected", () => {
  const event = observation({
    url: "https://example.com/missing",
    title: "404 Not Found",
    pageSummary: emptySummary,
  });
  assert.equal(isNotFoundObservation(event), true);
  assert.equal(reconfigureJustified(event), false);
});

test("branded not-found title variants are detected", () => {
  for (const title of ["Page Not Found - Example", "Example — Oops! Page Not Found", "404 Error | Example"]) {
    const event = observation({
      url: "https://example.com/missing",
      title,
      pageSummary: emptySummary,
    });
    assert.equal(isNotFoundObservation(event), true, title);
    assert.equal(reconfigureJustified(event), false, title);
  }
});

test("a CDN-branded 404 is not mistaken for a challenge", () => {
  const event = observation({
    url: "https://example.com/missing",
    title: "404 Not Found | Cloudflare",
    pageSummary: emptySummary,
  });
  assert.equal(isNotFoundObservation(event), true);
  assert.equal(reconfigureJustified(event), false);
});

test("an exact not-found title or heading suppresses CDN-brand reconfigure without sparse evidence", () => {
  const titledLanding = observation({
    url: "https://example.com/missing",
    title: "Page Not Found | Cloudflare",
  });
  assert.equal(isNotFoundObservation(titledLanding), true);
  assert.equal(reconfigureJustified(titledLanding), false);

  const referenceHeading = observation({
    url: "https://example.com/http/status/404",
    title: "Cloudflare HTTP reference",
    pageSummary: { ...contentSummary, headings: ["404 Not Found"] },
  });
  assert.equal(isNotFoundObservation(referenceHeading), false, "ambiguous 404 headings still require sparse evidence");
  assert.equal(reconfigureJustified(referenceHeading), false, "not-found labels suppress a brand-only session swap");
});

test("a sparse bare 404 is detected", () => {
  const event = observation({
    url: "https://example.com/missing",
    title: "404",
    pageSummary: emptySummary,
  });
  assert.equal(isNotFoundObservation(event), true);
  assert.equal(reconfigureJustified(event), false);
});

test("an article discussing HTTP 404 is not detected as a not-found landing", () => {
  const event = observation({
    url: "https://example.com/blog/http-404",
    title: "Understanding HTTP 404 errors",
    pageSummary: { ...contentSummary, headings: ["What does HTTP 404 mean?"] },
  });
  assert.equal(isNotFoundObservation(event), false);
  assert.equal(reconfigureJustified(event), false);
});

test("rich HTTP reference content titled or headed 404 Not Found is not a not-found landing", () => {
  for (const event of [
    observation({
      url: "https://docs.example.com/http/status/404",
      title: "404 Not Found - HTTP | Reference",
      pageSummary: { ...contentSummary, headings: ["HTTP response status codes"] },
    }),
    observation({
      url: "https://docs.example.com/http/status/404",
      title: "HTTP status reference",
      pageSummary: { ...contentSummary, headings: ["404 Not Found"] },
    }),
  ]) {
    assert.equal(isNotFoundObservation(event), false);
    assert.equal(reconfigureJustified(event), false);
  }
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

test("an explicit anti-bot signal takes precedence over a not-found title", () => {
  const event = observation({
    url: "https://shop.example/missing",
    title: "404 Not Found",
    pageSummary: { ...emptySummary, headings: ["Verify you are human"] },
  });
  assert.equal(isNotFoundObservation(event), true);
  assert.equal(reconfigureJustified(event), true);
});

test("a plain http (non-https) navigated blank page is still navigated", () => {
  assert.equal(
    reconfigureJustified(observation({ url: "http://intranet.local/", title: "", pageSummary: emptySummary })),
    true,
  );
});
