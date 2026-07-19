import * as assert from "node:assert/strict";
import { test } from "node:test";
import { buildJudgePrompt } from "../compare/judge-rubric.ts";

test("blind rubric makes explicit requirements and partial-answer caps inspectable", () => {
  const prompt = buildJudgePrompt(
    "Return exactly 5 rows with title and URL as JSON.",
    "[{\"title\":\"one\"}]",
  );

  assert.match(prompt, /0\.65 correctness and coverage/u);
  assert.match(prompt, /required entity, field, comparison, or substantial item is missing: at most 0\.69/u);
  assert.match(prompt, /requested format or exact count is wrong: at most 0\.89/u);
  assert.match(prompt, /Award 1\.00 only when every explicit requirement is satisfied/u);
  assert.match(prompt, /Return exactly one decimal number/u);
  assert.match(prompt, /Return exactly 5 rows with title and URL as JSON/u);
  assert.ok(prompt.includes('[{"title":"one"}]'));
});

test("blind rubric bounds candidate-controlled answer text", () => {
  const prompt = buildJudgePrompt("objective", "x".repeat(5_000));
  assert.ok(prompt.endsWith("x".repeat(4_000)));
  assert.ok(!prompt.endsWith("x".repeat(4_001)));
});
