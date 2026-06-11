import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type { BrowserObservation } from "../shared/types.js";
import { detectAuthWall } from "./auth.js";

function observation(overrides: Partial<BrowserObservation>): BrowserObservation {
  return {
    sessionId: createId("session"),
    url: "https://example.com",
    title: "Example",
    tabs: [],
    ...overrides,
  };
}

test("detectAuthWall does not encode Google anti-bot traps", () => {
  const result = detectAuthWall(observation({
    url: "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dvercel%2Bpricing",
    title: "Unusual traffic",
  }));

  assert.equal(result.detected, false);
});

test("detectAuthWall does not treat captcha wording as login auth", () => {
  const result = detectAuthWall(observation({
    url: "https://example.com/check",
    title: "Verify you are human",
  }));

  assert.equal(result.detected, false);
});

test("detectAuthWall never fires on browser error pages", () => {
  // Observed live: Steel's "Connection Error" chrome-error page presents a
  // single bare form, so the login-form heuristic classified six SEC EDGAR
  // connection failures as blocked-auth instead of infra-error. An
  // unloadable page can't be an auth wall.
  const errorPage = detectAuthWall(observation({
    url: "chrome-error://chromewebdata/",
    title: "Connection Error – Steel",
    pageSummary: { forms: 1, buttons: 1, links: 2, inputs: 1, tables: 0, dialogs: 0, headings: ["Connection Error"] },
  }));
  assert.equal(errorPage.detected, false);

  const blank = detectAuthWall(observation({
    url: "about:blank",
    title: "about:blank",
  }));
  assert.equal(blank.detected, false);
});

test("detectAuthWall still detects login pages", () => {
  const result = detectAuthWall(observation({
    url: "https://example.com/login",
    title: "Sign in",
  }));

  assert.equal(result.detected, true);
});
