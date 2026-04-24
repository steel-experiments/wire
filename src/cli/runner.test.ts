import { strict as assert } from "node:assert";
import { test } from "node:test";

import { resolveProviderSelection } from "./runner.js";

test("resolveProviderSelection uses explicit provider", () => {
  assert.equal(resolveProviderSelection("anthropic", "claude-sonnet-4-6"), "anthropic");
});

test("resolveProviderSelection infers openai from model", () => {
  assert.equal(resolveProviderSelection(undefined, "gpt-5.4-mini"), "openai");
});

test("resolveProviderSelection infers anthropic from model", () => {
  assert.equal(resolveProviderSelection(undefined, "claude-sonnet-4-6"), "anthropic");
});

test("resolveProviderSelection rejects mismatched provider and model", () => {
  assert.throws(
    () => resolveProviderSelection("anthropic", "gpt-5.4-mini"),
    /does not match provider/u,
  );
});

test("resolveProviderSelection rejects ambiguous provider choice when both keys exist", () => {
  const originalOpenAi = process.env.OPENAI_API_KEY;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "openai-test-key";
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";

  try {
    assert.throws(
      () => resolveProviderSelection(undefined, undefined),
      /Multiple LLM providers are configured/u,
    );
  } finally {
    if (originalOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAi;
    }
    if (originalAnthropic === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
  }
});
