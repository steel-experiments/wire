import { strict as assert } from "node:assert";
import { test } from "node:test";

import type {
  BrowserExecResult,
  BrowserObservation,
  BrowserSession,
  Task,
} from "../shared/types.js";
import type { BrowserObserveInput, BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { executeTask } from "./runtime.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Test task",
    mode: "task",
    objective: "Complete a test task",
    constraints: [],
    successCriteria: ["Page loads successfully"],
    createdAt: nowIsoUtc(),
    ...overrides,
  };
}

function createMockPolicyEngine(): PolicyEngine {
  return {
    check(actionId) {
      return { id: createId("policy"), actionId, result: "allow", ts: nowIsoUtc() };
    },
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
    async stopSession() {},
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      return {
        sessionId: input.sessionId,
        url: "https://example.com",
        title: "Example",
        tabs: [{ id: "tab-1", title: "Example", url: "https://example.com", active: true }],
      };
    },
    async exec(): Promise<BrowserExecResult> {
      return { ok: true, durationMs: 1 };
    },
    async raw() {
      return { ok: true, result: {} };
    },
    ...overrides,
  };
}

test("executeTask records model-authored progress ledger from exec results", async () => {
  const task = makeTask({
    objective: "Collect pricing from two sites and return a comparison table",
    successCriteria: ["Two pricing rows are preserved"],
  });
  const sessionId = createId("session");
  const provider = createMockProvider({
    async createSession(): Promise<BrowserSession> {
      return { id: sessionId, provider: "custom", createdAt: nowIsoUtc(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      return {
        ok: true,
        durationMs: 10,
        returnValue: {
          progress: [
            { key: "linear", fields: { plan: "Basic", price: "$10" }, evidence: "pricing page row" },
            { key: "asana", fields: { plan: "Starter", price: "$13.49" }, evidence: "pricing page row" },
          ],
        },
      };
    },
  });

  const result = await executeTask(
    task,
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: 4 },
    async (state) => state.stepCount === 0
      ? { kind: "exec", summary: "Collect progress", payload: { code: "return progress" } }
      : { kind: "finish", summary: "Done" },
  );

  const ledgerEvent = result.events.find((event) => event.kind === "progress-ledger");
  assert.ok(ledgerEvent);
  assert.ok(result.run.resultPayload !== undefined);
  assert.match(result.run.result ?? "", /linear/u);
});
