// ABOUTME: Shared test fixtures for agent-side suites — tasks, providers,
// ABOUTME: policy engines, and loop signals. Adopt as test files are touched.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  SessionId,
  Task,
} from "../shared/types.js";
import type { BrowserObserveInput, BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { LoopSignals } from "./runtime.js";

export function makeTask(overrides: Partial<Task> = {}): Task {
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

export function makeSessionId(): SessionId {
  return createId("session");
}

export function createMockPolicyEngine(overrides: Partial<PolicyEngine> = {}): PolicyEngine {
  return {
    check(_actionId, _action) {
      return { id: createId("policy"), actionId: _actionId, result: "allow" };
    },
    ...overrides,
  };
}

export function createMockProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
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

export function makeLoopSignals(overrides: Partial<LoopSignals> = {}): LoopSignals {
  return {
    policyDenied: false,
    authWallHit: false,
    authWallStreak: 0,
    authWallHost: undefined,
    antiBotRecoveryAttempted: false,
    maxStepsReached: false,
    awaitingApproval: false,
    blockedByPolicy: false,
    userCancelled: false,
    pendingApproval: undefined,
    pendingAction: undefined,
    flushedEvents: 0,
    ...overrides,
  };
}

// Keep the fixtures honest: a smoke test so a drifting fixture fails here,
// in the one shared place, instead of in whichever suite imports it next.
test("shared fixtures produce schema-plausible defaults", async () => {
  const task = makeTask();
  assert.equal(task.mode, "task");
  const provider = createMockProvider();
  const observation = await provider.observe({ sessionId: makeSessionId() });
  assert.equal(observation.tabs.length, 1);
  const decision = createMockPolicyEngine().check(createId("action"), { kind: "exec", summary: "x" });
  assert.equal(decision.result, "allow");
  assert.equal(makeLoopSignals({ maxStepsReached: true }).maxStepsReached, true);
});
