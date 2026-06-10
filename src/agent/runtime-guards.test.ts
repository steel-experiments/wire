// ABOUTME: Regression tests for runtime guard rails — policy relabeling,
// ABOUTME: trace redaction on startup, and finish-flow error containment.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  BrowserSession,
  SessionId,
  Task,
} from "../shared/types.js";
import type { BrowserObserveInput, BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";
import { createPolicyEngine } from "../policy/engine.js";
import type { LLMProvider } from "../providers/llm/types.js";

import { executeTask } from "./runtime.js";
import { createLoopState, executeStep } from "./loop.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Test task",
    mode: "task",
    objective: "Complete a test task",
    constraints: [],
    successCriteria: ["Page loads successfully"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSessionId(): SessionId {
  return createId("session");
}

function createMockPolicyEngine(overrides: Partial<PolicyEngine> = {}): PolicyEngine {
  return {
    check(_actionId, _action) {
      return { id: createId("policy"), actionId: _actionId, result: "allow" };
    },
    ...overrides,
  };
}

function createMockProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    async createSession() {
      throw new Error("not implemented");
    },
    async getSession() {
      throw new Error("not implemented");
    },
    async stopSession() {
      throw new Error("not implemented");
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      return {
        sessionId: input.sessionId,
        url: "https://example.com",
        title: "Example",
        tabs: [
          { id: "tab-1", title: "Example", url: "https://example.com", active: true },
        ],
      };
    },
    async exec(_input: BrowserExecRequest): Promise<BrowserExecResult> {
      return { ok: true, stdout: "ok", durationMs: 10 };
    },
    ...overrides,
  };
}

test("initial observation is redacted before it reaches the trace", async () => {
  const task = makeTask();
  const sessionId = makeSessionId();
  const provider = createMockProvider({
    async createSession(): Promise<BrowserSession> {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      return {
        sessionId: input.sessionId,
        url: "https://example.com/dash?apiKey=supersecretvalue123",
        title: "Dashboard",
        tabs: [],
      };
    },
    async stopSession() {},
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 2 },
    async () => ({ kind: "finish", summary: "Done" }),
  );

  const observation = result.events.find((e) => e.kind === "observation");
  assert.ok(observation);
  const url = String(observation!.payload.url ?? "");
  assert.ok(!url.includes("supersecretvalue123"), "initial observation URL must be redacted");
  assert.ok(url.includes("[REDACTED]"));
});

test("model-supplied policyKind cannot relabel a raw action for the policy engine", async () => {
  const task = makeTask();
  const state = createLoopState(task, makeSessionId());
  const provider = createMockProvider();
  const policy = createPolicyEngine();

  const result = await executeStep(
    state,
    {
      kind: "raw",
      summary: "Evaluate via CDP",
      payload: {
        policyKind: "read",
        method: "Runtime.evaluate",
        params: { expression: "document.cookie" },
      },
    },
    provider,
    policy,
  );

  assert.ok(
    result.pendingApproval,
    "raw CDP must require approval despite a spoofed payload policyKind",
  );
  const policyEvent = result.state.events.find((e) => e.kind === "policy-check");
  assert.equal(policyEvent?.payload.policyKind, "raw");
});

test("executeTask survives an LLM error during the finish flow and still classifies the run", async () => {
  const task = makeTask({ objective: "Extract pricing and save as markdown table in md format" });
  const sessionId = makeSessionId();
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      const content = [
        "| Plan | Price |",
        "|---|---|",
        "| Hobby | Free |",
        "| Pro | $20/mo |",
        "| Enterprise | Custom |",
      ].join("\n");
      return {
        ok: true,
        durationMs: 10,
        returnValue: {
          artifacts: [{ filename: "pricing.md", kind: "markdown", mimeType: "text/markdown", content }],
        },
      };
    },
    async stopSession() {},
  });
  const llmProvider: LLMProvider = {
    model: "reviewer",
    async chat(messages) {
      const prompt = messages.map((message) => message.content).join("\n");
      if (!prompt.includes("Review the final artifact against the objective")) {
        return { model: "reviewer", content: "{}" };
      }
      throw new Error("429 too many requests");
    },
  };

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), llmProvider, maxSteps: 6 },
    async (state) => {
      if (state.stepCount === 0) return { kind: "exec", summary: "Extract artifact", payload: { code: "return bad" } };
      return { kind: "finish", summary: "Done" };
    },
  );

  // The reviewer failure must not reject out of executeTask: the run ends
  // with a recorded error event and a real classification.
  assert.ok(result.run.classification, "run must still be classified");
  const errorEvent = result.events.find((e) => e.kind === "error");
  assert.ok(errorEvent, "finish-flow failure must be recorded as an error event");
  assert.match(String(errorEvent!.payload.message ?? ""), /429/);
});
