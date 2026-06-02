// ABOUTME: Tests for LLM-output JSON extraction helpers (object + array).

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { extractFirstJsonArray } from "./llm-parse.js";

test("extractFirstJsonArray returns a bare array unchanged", () => {
  assert.equal(extractFirstJsonArray('["a","b"]'), '["a","b"]');
});

test("extractFirstJsonArray pulls the array out of surrounding prose and fences", () => {
  assert.equal(extractFirstJsonArray('Here you go:\n```json\n["a","b"]\n```'), '["a","b"]');
});

test("extractFirstJsonArray is string-aware: brackets inside strings do not end the array", () => {
  // The lone `]` inside the string must not terminate extraction, and a stray
  // `]` in trailing prose must not be grabbed by a naive lastIndexOf.
  assert.equal(extractFirstJsonArray('result: ["a]b", "c"] and that is all]'), '["a]b", "c"]');
});

test("extractFirstJsonArray handles escaped quotes inside strings", () => {
  assert.equal(extractFirstJsonArray('["say \\"hi]\\" now"]'), '["say \\"hi]\\" now"]');
});

test("extractFirstJsonArray handles nested arrays", () => {
  assert.equal(extractFirstJsonArray('[[1,2],[3]] trailing'), "[[1,2],[3]]");
});

test("extractFirstJsonArray returns undefined when there is no array", () => {
  assert.equal(extractFirstJsonArray("NONE"), undefined);
  assert.equal(extractFirstJsonArray("just prose"), undefined);
});
