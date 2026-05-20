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

test("detectAuthWall still detects login pages", () => {
  const result = detectAuthWall(observation({
    url: "https://example.com/login",
    title: "Sign in",
  }));

  assert.equal(result.detected, true);
});
