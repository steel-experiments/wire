// ABOUTME: Tests for embedded mode — runEmbedded defaults, typed output,
// ABOUTME: provenance, blocked-policy, and safe concurrency across runs.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { z } from "zod";

import { runEmbedded, embeddedTask, type EmbeddedConfig } from "./embedded.js";
import type { BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { LLMProvider, ChatResponse } from "../providers/llm/openai.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { BrowserSession, BrowserObservation } from "../shared/types.js";

function makeSession(): BrowserSession {
  return {
    id: createId("session"),
    provider: "steel",
    status: "ready",
    liveUrl: "https://example.com",
    createdAt: nowIsoUtc(),
  };
}

function makeObservation(): BrowserObservation {
  return { sessionId: makeSession().id, url: "https://example.com", title: "Test Page", tabs: [] };
}

/** Provider whose exec returns a structured {answer} object. */
function extractProvider(): BrowserProvider {
  return {
    createSession: async () => makeSession(),
    getSession: async () => makeSession(),
    stopSession: async () => {},
    observe: async () => makeObservation(),
    exec: async () => ({ ok: true, durationMs: 1, returnValue: { answer: "forty-two" } }),
  };
}

/** LLM that extracts once, then finishes. */
function extractThenFinishLlm(): LLMProvider {
  let calls = 0;
  return {
    model: "test-model",
    async chat(): Promise<ChatResponse> {
      calls++;
      const action = calls === 1
        ? { kind: "exec", summary: "Extract", payload: { code: "wire:extract\nreturn {answer: 'forty-two'}" } }
        : { kind: "finish", summary: "Done — forty-two" };
      return { content: JSON.stringify(action), model: "test-model" };
    },
  };
}

function baseConfig<T>(overrides: Partial<EmbeddedConfig<T>> = {}): EmbeddedConfig<T> {
  return {
    provider: extractProvider(),
    llmProvider: extractThenFinishLlm(),
    skillDir: "",
    maxSteps: 8,
    ...overrides,
  };
}

test("embeddedTask builds a task-mode task from lightweight input", () => {
  const task = embeddedTask({ objective: "read the title", url: "https://example.com", extract: "page title" });
  assert.equal(task.mode, "task");
  assert.match(task.objective, /example\.com/);
  assert.match(task.objective, /read the title/);
  assert.deepEqual(task.successCriteria, ["Extract: page title"]);
});

test("runEmbedded returns typed data and provenance for a conforming run", async () => {
  const schema = z.object({ answer: z.string() });
  const result = await runEmbedded({ objective: "get the answer" }, baseConfig({ outputSchema: schema }));

  assert.equal(result.data?.answer, "forty-two", "data should be the validated structured result");
  assert.ok(result.provenance, "should carry provenance");
  assert.equal(result.provenance!.url, "https://example.com");
  assert.notEqual(result.classification.kind, "ambiguous");
});

test("runEmbedded denies approval-gated actions instead of hanging", async () => {
  const gating: PolicyEngine = {
    check: (actionId) => ({ id: createId("policy"), actionId, result: "require-approval" as const }),
  };
  const result = await runEmbedded(
    { objective: "do the gated thing" },
    baseConfig({ policyEngine: gating }),
  );

  assert.equal(result.classification.kind, "blocked-policy");
  assert.equal(result.run.status, "failed", "must terminate, not pause");
});

test("runEmbedded reports a schema mismatch explicitly instead of silently omitting data", async () => {
  const schema = z.object({ totallyDifferentField: z.number() });
  const result = await runEmbedded({ objective: "get the answer" }, baseConfig({ outputSchema: schema }));

  assert.equal(result.data, undefined);
  assert.ok(result.schemaError, "a failed parse must be reported, not swallowed");
  assert.match(result.schemaError!, /totallyDifferentField/u);
});

test("concurrent runEmbedded calls with distinct skillDir do not interfere", async () => {
  const [a, b] = await Promise.all([
    runEmbedded({ objective: "first" }, baseConfig({ skillDir: "/tmp/wire-embedded-a" })),
    runEmbedded({ objective: "second" }, baseConfig({ skillDir: "/tmp/wire-embedded-b" })),
  ]);

  // Distinct runs, each with its own result and no cross-contamination.
  assert.notEqual(a.run.id, b.run.id);
  assert.equal(a.data !== undefined, true);
  assert.equal(b.data !== undefined, true);
  assert.notEqual(a.classification.kind, "blocked-policy");
  assert.notEqual(b.classification.kind, "blocked-policy");
});
