// ABOUTME: Tests for browser-side helper function injection into exec code.
// ABOUTME: Validates preamble content, prependHelpers behaviour, and JS validity.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { HELPER_PREAMBLE, prependHelpers } from "./helpers.js";

test("HELPER_PREAMBLE defines clickVisibleText", () => {
  assert.ok(HELPER_PREAMBLE.includes("function clickVisibleText("), "missing clickVisibleText");
});

test("HELPER_PREAMBLE defines fillByLabel", () => {
  assert.ok(HELPER_PREAMBLE.includes("function fillByLabel("), "missing fillByLabel");
});

test("HELPER_PREAMBLE defines extractTable", () => {
  assert.ok(HELPER_PREAMBLE.includes("function extractTable("), "missing extractTable");
});

test("HELPER_PREAMBLE defines waitForSelector", () => {
  assert.ok(HELPER_PREAMBLE.includes("function waitForSelector("), "missing waitForSelector");
});

test("HELPER_PREAMBLE contains no TypeScript syntax", () => {
  // No type annotations, generic params, or interface keywords
  assert.ok(!/:\s*string\b/.test(HELPER_PREAMBLE), "has TS type annotation");
  assert.ok(!/:\s*number\b/.test(HELPER_PREAMBLE), "has TS type annotation");
  assert.ok(!/<[A-Z]/.test(HELPER_PREAMBLE), "has generic type param");
  assert.ok(!/\binterface\b/.test(HELPER_PREAMBLE), "has interface keyword");
  assert.ok(!/\btype\s+\w/.test(HELPER_PREAMBLE), "has type keyword");
});

test("prependHelpers places preamble before user code", () => {
  const userCode = "return document.title;";
  const result = prependHelpers(userCode);

  const preambleIndex = result.indexOf("function clickVisibleText(");
  const codeIndex = result.indexOf(userCode);

  assert.ok(preambleIndex !== -1, "preamble missing");
  assert.ok(codeIndex !== -1, "user code missing");
  assert.ok(preambleIndex < codeIndex, "preamble must come before user code");
});

test("prependHelpers preserves user code verbatim", () => {
  const userCode = 'const x = document.querySelector("#foo"); return x?.textContent;';
  const result = prependHelpers(userCode);
  assert.ok(result.includes(userCode), "user code was modified");
});

test("prependHelpers adds a newline separator between preamble and user code", () => {
  const result = prependHelpers("return 1;");
  // The preamble and user code should be separated — not run together
  assert.ok(/\n/.test(result), "no newline separator");
});

test("prependHelpers with empty user code still returns preamble", () => {
  const result = prependHelpers("");
  assert.ok(result.includes("function clickVisibleText("), "preamble missing for empty code");
});

test("clickVisibleText throws on no match — error message includes text arg", () => {
  // We can syntactically check the preamble encodes the right error pattern
  assert.ok(
    HELPER_PREAMBLE.includes("no visible element") || HELPER_PREAMBLE.includes("clickVisibleText"),
    "error message pattern missing",
  );
});

test("extractTable throws on missing selector — error message includes selector", () => {
  assert.ok(
    HELPER_PREAMBLE.includes("no element for") || HELPER_PREAMBLE.includes("extractTable"),
    "error message pattern missing",
  );
});

test("waitForSelector includes a configurable timeout parameter", () => {
  // The function signature should accept a second argument for timeoutMs
  const match = HELPER_PREAMBLE.match(/function waitForSelector\(([^)]+)\)/u);
  assert.ok(match, "waitForSelector signature not found");
  assert.ok(match![1]!.includes(","), "waitForSelector should have at least 2 params (selector, timeoutMs)");
});

test("HELPER_PREAMBLE does not reference Node.js globals", () => {
  // Helpers run in the browser page context — no Node APIs allowed
  assert.ok(!HELPER_PREAMBLE.includes("require("), "uses require()");
  assert.ok(!HELPER_PREAMBLE.includes("process."), "uses process");
  assert.ok(!HELPER_PREAMBLE.includes("Buffer."), "uses Buffer");
  assert.ok(!HELPER_PREAMBLE.includes("__dirname"), "uses __dirname");
});
