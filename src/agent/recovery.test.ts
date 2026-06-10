// ABOUTME: Tests for the anti-bot recovery path — gating conditions, the
// ABOUTME: one-shot attempt flag, and error containment on a failed swap.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { LoadedSkill, Task } from "../shared/types.js";
import type { BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";

import { ActionRegistry } from "./actions.js";
import { createLoopState } from "./loop.js";
import { tryAntiBotRecovery } from "./recovery.js";
import { createMockPolicyEngine, makeLoopSignals, makeTask } from "./fixtures.test.js";
import type { RuntimeConfig } from "./runtime.js";

function barrierSkill(): LoadedSkill {
  return {
    id: createId("skill"),
    scope: "domain",
    hostnamePatterns: ["example.com"],
    tags: ["listings"],
    source: "team",
    updatedAt: "2026-06-10",
    path: "/skills/example.com.md",
    body: "",
    sections: {
      "Known Traps": "- example.com shows a captcha interstitial on /listings; reconfigure with proxy gets past it.",
    },
  } as LoadedSkill;
}

// State observed on a blocked challenge page that a loaded skill describes.
function blockedState() {
  const state = createLoopState(makeTask(), createId("session"));
  state.loadedSkills = [barrierSkill()];
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "observation",
    payload: {
      url: "https://example.com/listings",
      title: "Verification required",
      pageSummary: {},
    },
  });
  return state;
}

function recoveryRegistry(onReconfigure: () => Promise<void>): ActionRegistry {
  const registry = new ActionRegistry();
  registry.register({
    kind: "reconfigure",
    description: "test reconfigure",
    async execute() {
      await onReconfigure();
      return {};
    },
  });
  return registry;
}

function makeConfig(): RuntimeConfig {
  return {
    provider: {
      async createSession() { throw new Error("not implemented"); },
      async getSession() { throw new Error("not implemented"); },
      async stopSession() {},
      async observe() { throw new Error("not implemented"); },
      async exec() { throw new Error("not implemented"); },
    } satisfies BrowserProvider,
    policyEngine: createMockPolicyEngine(),
    maxSteps: 5,
    skillDir: "",
  };
}

test("tryAntiBotRecovery reconfigures once when a skill names the barrier", async () => {
  const state = blockedState();
  const signals = makeLoopSignals();
  let reconfigures = 0;
  const registry = recoveryRegistry(async () => { reconfigures += 1; });

  const recovered = await tryAntiBotRecovery(
    state, makeConfig(), signals, registry, async () => {}, () => false,
  );

  assert.equal(recovered, true);
  assert.equal(reconfigures, 1);
  assert.equal(signals.antiBotRecoveryAttempted, true);

  // Second call is a no-op: recovery is one-shot per run.
  const again = await tryAntiBotRecovery(
    state, makeConfig(), signals, registry, async () => {}, () => false,
  );
  assert.equal(again, false);
  assert.equal(reconfigures, 1);
});

test("tryAntiBotRecovery does not fire without skill evidence or on healthy pages", async () => {
  const signals = makeLoopSignals();
  let reconfigures = 0;
  const registry = recoveryRegistry(async () => { reconfigures += 1; });

  // No loaded skill describing the barrier → no recovery.
  const noSkill = blockedState();
  noSkill.loadedSkills = [];
  assert.equal(
    await tryAntiBotRecovery(noSkill, makeConfig(), signals, registry, async () => {}, () => false),
    false,
  );

  // Healthy content page (no block signal, has content) → no recovery.
  const healthy = blockedState();
  healthy.events.pop();
  healthy.events.push({
    id: createId("event"),
    runId: healthy.run.id,
    ts: nowIsoUtc(),
    kind: "observation",
    payload: {
      url: "https://example.com/listings",
      title: "Listings — Example",
      pageSummary: { headings: ["All listings"], forms: 1, buttons: 4 },
    },
  });
  assert.equal(
    await tryAntiBotRecovery(healthy, makeConfig(), makeLoopSignals(), registry, async () => {}, () => false),
    false,
  );

  // Cancelled or policy-denied runs never recover.
  assert.equal(
    await tryAntiBotRecovery(blockedState(), makeConfig(), makeLoopSignals(), registry, async () => {}, () => true),
    false,
  );
  const denied = makeLoopSignals();
  denied.policyDenied = true;
  assert.equal(
    await tryAntiBotRecovery(blockedState(), makeConfig(), denied, registry, async () => {}, () => false),
    false,
  );

  assert.equal(reconfigures, 0);
});

test("tryAntiBotRecovery records a traced error and returns false when the swap fails", async () => {
  const state = blockedState();
  const signals = makeLoopSignals();
  const registry = recoveryRegistry(async () => {
    throw new Error("session create failed");
  });

  const recovered = await tryAntiBotRecovery(
    state, makeConfig(), signals, registry, async () => {}, () => false,
  );

  assert.equal(recovered, false);
  const error = state.events.find((e) => e.kind === "error");
  assert.ok(error, "the failed swap must be a traced error event");
  assert.equal(error!.payload.code, "ERECONFIGURE");
  assert.match(String(error!.payload.message), /session create failed/u);
});
