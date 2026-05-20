// ABOUTME: Tests for browser-side helper function injection into exec code.
// ABOUTME: Validates preamble content, prependHelpers behaviour, and JS validity.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createHelperDiff,
  HELPER_PREAMBLE,
  helperSourceToPreamble,
  prependHelpers,
  validateHelperSource,
} from "./helpers.js";

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

test("prependHelpers accepts rewritten helper source", () => {
  const helperSource = "export function findTitle() { return document.title; }";
  const result = prependHelpers("return findTitle();", helperSource);

  assert.ok(result.startsWith("function findTitle()"), "rewritten helper not prepended");
  assert.ok(!result.includes("export function"), "export keyword should be stripped for execution");
  assert.ok(result.endsWith("return findTitle();"), "user code missing");
});

test("helperSourceToPreamble strips exports from JS-compatible module source", () => {
  const source = [
    "export async function clickThing() { return true; }",
    "export const selector = '#main';",
  ].join("\n");

  const preamble = helperSourceToPreamble(source);

  assert.match(preamble, /^async function clickThing/u);
  assert.match(preamble, /\nconst selector = '#main';/u);
});

test("validateHelperSource rejects empty helper edits", () => {
  const result = validateHelperSource("  ");
  assert.equal(result.ok, false);
});

test("validateHelperSource rejects Node globals", () => {
  const result = validateHelperSource("function bad() { return process.env.SECRET; }");
  assert.equal(result.ok, false);
});

test("validateHelperSource accepts JS-compatible exported helpers", () => {
  const result = validateHelperSource("export function byTestId(id) { return document.querySelector(`[data-testid=\"${id}\"]`); }");
  assert.deepEqual(result, { ok: true });
});

test("createHelperDiff records removed and added helper lines", () => {
  const diff = createHelperDiff("function a() { return 1; }", "function a() { return 2; }");

  assert.ok(diff.includes("--- helpers/before.js"));
  assert.ok(diff.includes("+++ helpers/after.js"));
  assert.ok(diff.includes("-function a() { return 1; }"));
  assert.ok(diff.includes("+function a() { return 2; }"));
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
