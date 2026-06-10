// ABOUTME: Branch tests for finalizeExecution — skill-store write gating and
// ABOUTME: classification of finished runs.

import { strict as assert } from "node:assert";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Task } from "../shared/types.js";
import type { BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";

import { createLoopState } from "./loop.js";
import { finalizeExecution } from "./finalize.js";
import type { LoopSignals, RuntimeConfig } from "./runtime.js";

function makeTask(): Task {
  return {
    id: createId("task"),
    title: "Finalize test",
    mode: "task",
    objective: "Extract the answer",
    constraints: [],
    successCriteria: ["Answer extracted"],
    createdAt: nowIsoUtc(),
  };
}

function makeProvider(): BrowserProvider {
  return {
    async createSession() { throw new Error("not implemented"); },
    async getSession() { throw new Error("not implemented"); },
    async stopSession() {},
    async observe() { throw new Error("not implemented"); },
    async exec() { throw new Error("not implemented"); },
  };
}

function makePolicy(): PolicyEngine {
  return {
    check(actionId) {
      return { id: createId("policy"), actionId, result: "allow" };
    },
  };
}

function makeSignals(): LoopSignals {
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
  };
}

// State whose trace says a skill was loaded — the exact case where stats
// (and possibly retirement) would be written to the skill store.
function stateWithLoadedSkill() {
  const state = createLoopState(makeTask(), createId("session"));
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "skill-load",
    payload: { skills: ["skill_gate_test"] },
  });
  return state;
}

async function runFinalize(skillDir: string, skillPromotion: "auto" | "off") {
  const config: RuntimeConfig = {
    provider: makeProvider(),
    policyEngine: makePolicy(),
    maxSteps: 5,
    skillDir,
    skillPromotion,
  };
  return finalizeExecution(stateWithLoadedSkill(), config, makeSignals(), async () => {});
}

test("finalizeExecution with skillPromotion off never writes to the skill store", async () => {
  const skillDir = await mkdtemp(join(tmpdir(), "wire-finalize-off-"));
  try {
    await runFinalize(skillDir, "off");
    const entries = await readdir(skillDir, { recursive: true });
    assert.deepEqual(entries, [], "promotion-off must leave the skill store untouched");
  } finally {
    await rm(skillDir, { recursive: true, force: true });
  }
});

test("finalizeExecution with skillPromotion auto records skill stats", async () => {
  const skillDir = await mkdtemp(join(tmpdir(), "wire-finalize-auto-"));
  try {
    await runFinalize(skillDir, "auto");
    const entries = await readdir(skillDir, { recursive: true });
    assert.ok(
      entries.some((entry) => String(entry).includes(".stats")),
      `expected stats files, got: ${JSON.stringify(entries)}`,
    );
  } finally {
    await rm(skillDir, { recursive: true, force: true });
  }
});
