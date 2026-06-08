import { strict as assert } from "node:assert";
import { test } from "node:test";

import { deriveRunResult } from "./loop-result.js";
import { progressEntriesFromValue } from "./progress-ledger.js";

import type {
  BrowserExecResult,
  BrowserObservation,
  BrowserSession,
  Task,
  TraceEvent,
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

test("progressEntriesFromValue extracts known envelope keys", () => {
  // progressLedger key
  const fromLedger = progressEntriesFromValue({
    progressLedger: [{ key: "a" }, { key: "b" }],
  });
  assert.equal(fromLedger.length, 2);

  // progress key
  const fromProgress = progressEntriesFromValue({
    progress: [{ key: "x", score: 100 }],
  });
  assert.equal(fromProgress.length, 1);
  assert.equal(fromProgress[0]!.key, "x");
});

test("progressEntriesFromValue auto-extracts array-of-objects properties", () => {
  // LLM returns {units:[{unit:1,score:100},{unit:2,score:200}]} — no envelope key
  const entries = progressEntriesFromValue({
    ok: true,
    units: [
      { unit: 1, score: 100, gameOver: true },
      { unit: 2, score: 200, gameOver: true },
    ],
  });

  assert.equal(entries.length, 2);
  // Entries without key/id get a synthetic key
  assert.ok(entries[0]!.key, "entry should have a key");
  assert.ok(entries[1]!.key, "entry should have a key");
  assert.equal(entries[0]!.score, 100);
  assert.equal(entries[1]!.score, 200);
});

test("progressEntriesFromValue does not extract artifact arrays", () => {
  // Artifact-shaped arrays should not be extracted as progress entries
  const entries = progressEntriesFromValue({
    artifacts: [{ filename: "result.md", mimeType: "text/markdown", content: "..." }],
  });

  assert.equal(entries.length, 0);
});

test("progressEntriesFromValue prefers known envelope over auto-extraction", () => {
  const entries = progressEntriesFromValue({
    progress: [{ key: "from-envelope" }],
    units: [{ unit: 1 }, { unit: 2 }],
  });

  // Should use the explicit progress key, not auto-extract units
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.key, "from-envelope");
});

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

test("deriveRunResult prefers progress ledger over late page dumps in task mode", () => {
  // Simulate: step 1 has structured units data, step 2 is a generic page dump
  const events: TraceEvent[] = [
    {
      id: createId("event"),
      runId: createId("run"),
      ts: nowIsoUtc(),
      kind: "code-result",
      payload: {
        ok: true,
        source: "exec",
        returnValue: {
          units: [
            { unit: 1, score: 1000, over: true },
            { unit: 2, score: 2000, over: true },
          ],
        },
      },
    },
    // Progress ledger event (auto-extracted from the code result above)
    {
      id: createId("event"),
      runId: createId("run"),
      ts: nowIsoUtc(),
      kind: "progress-ledger",
      payload: {
        entries: [
          { key: "entry-0", unit: 1, score: 1000, over: true },
          { key: "entry-1", unit: 2, score: 2000, over: true },
        ],
        count: 2,
        total: 2,
      },
    },
    // Late-stage page dump (would normally become the "latest" result)
    {
      id: createId("event"),
      runId: createId("run"),
      ts: nowIsoUtc(),
      kind: "code-result",
      payload: {
        ok: true,
        source: "exec",
        returnValue: {
          ok: true,
          evidence: { title: "Page Title", url: "https://example.com", text: "MENU\nSign in\nSubscribe" },
        },
      },
    },
  ];

  const result = deriveRunResult(events, "task");
  assert.ok(result, "should return a result");
  // Should be the progress ledger, not the page dump
  assert.match(result!, /entry-0/u, "result should contain progress ledger entries");
  assert.match(result!, /score.*1000/u, "result should contain structured unit data");
});
