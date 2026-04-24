import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createId, nowIsoUtc } from "../shared/ids.js";

import { createExperimentBundleFromRuns, resolveProviderSelection } from "./runner.js";

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

test("createExperimentBundleFromRuns creates comparisons and summary", () => {
  const taskId = createId("task");
  const runs = [
    {
      id: createId("run"),
      taskId,
      status: "succeeded" as const,
      startedAt: nowIsoUtc(),
      finishedAt: nowIsoUtc(),
      classification: { kind: "task-complete" as const, confidence: 0.8 },
      outcomeSummary: "Run one succeeded",
    },
    {
      id: createId("run"),
      taskId,
      parentRunId: undefined,
      branchLabel: "alternative-approach",
      status: "failed" as const,
      startedAt: nowIsoUtc(),
      finishedAt: nowIsoUtc(),
      classification: { kind: "site-error" as const, confidence: 0.7 },
      outcomeSummary: "Run two failed",
    },
  ];

  const bundle = createExperimentBundleFromRuns(taskId, runs);
  assert.equal(bundle.taskId, taskId);
  assert.equal(bundle.hypotheses.length, 1);
  assert.equal(bundle.runIds.length, 2);
  assert.equal(bundle.comparisons.length, 1);
  assert.equal(bundle.comparisons[0]!.lhsRunId, runs[0]!.id);
  assert.equal(bundle.comparisons[0]!.rhsRunId, runs[1]!.id);
  assert.ok(bundle.summary);
});
