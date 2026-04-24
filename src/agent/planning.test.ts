import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Task } from "../shared/types.js";
import {
  advancePlanBy,
  advanceStep,
  createPlan,
  isPlanComplete,
  planToContext,
} from "./planning.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Planning test",
    mode: "task",
    objective: "Collect pricing",
    constraints: [],
    successCriteria: ["Capture monthly plan", "Capture annual plan"],
    createdAt: nowIsoUtc(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createPlan
// ---------------------------------------------------------------------------

test("createPlan uses objective as first step", () => {
  const plan = createPlan(makeTask());
  assert.equal(plan.steps[0], "Collect pricing");
  assert.equal(plan.currentStepIndex, 0);
  assert.equal(plan.mode, "task");
});

test("createPlan adds verification steps from successCriteria", () => {
  const plan = createPlan(makeTask());
  assert.equal(plan.steps.length, 3); // 1 objective + 2 criteria
  assert.equal(plan.steps[1], "Verify: Capture monthly plan");
  assert.equal(plan.steps[2], "Verify: Capture annual plan");
});

test("createPlan with no successCriteria has single step", () => {
  const plan = createPlan(makeTask({ successCriteria: [] }));
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0], "Collect pricing");
});

test("createPlan preserves task mode", () => {
  const plan = createPlan(makeTask({ mode: "investigate" }));
  assert.equal(plan.mode, "investigate");
});

// ---------------------------------------------------------------------------
// advanceStep
// ---------------------------------------------------------------------------

test("advanceStep increments currentStepIndex", () => {
  const plan = createPlan(makeTask());
  const next = advanceStep(plan);
  assert.equal(next.currentStepIndex, 1);
});

test("advanceStep returns same plan at final step", () => {
  const plan = createPlan(makeTask());
  const atEnd = advancePlanBy(plan, 10);
  const result = advanceStep(atEnd);
  assert.equal(result.currentStepIndex, atEnd.currentStepIndex);
  // Should be the same object reference (no new object created)
  assert.equal(result, atEnd);
});

test("advanceStep does not mutate the original plan", () => {
  const plan = createPlan(makeTask());
  const originalIndex = plan.currentStepIndex;
  advanceStep(plan);
  assert.equal(plan.currentStepIndex, originalIndex);
});

// ---------------------------------------------------------------------------
// advancePlanBy
// ---------------------------------------------------------------------------

test("advancePlanBy advances and clamps at final step", () => {
  const plan = createPlan(makeTask());
  const advanced = advancePlanBy(plan, 10);

  assert.equal(advanced.currentStepIndex, advanced.steps.length - 1);
});

test("advancePlanBy leaves plan unchanged for non-positive values", () => {
  const plan = createPlan(makeTask());
  const unchanged = advancePlanBy(plan, 0);

  assert.equal(unchanged.currentStepIndex, 0);
});

test("advancePlanBy with negative steps returns same plan", () => {
  const plan = createPlan(makeTask());
  const result = advancePlanBy(plan, -5);
  assert.equal(result.currentStepIndex, 0);
});

test("advancePlanBy advances by exact number of steps", () => {
  const plan = createPlan(makeTask()); // 3 steps
  const advanced = advancePlanBy(plan, 1);
  assert.equal(advanced.currentStepIndex, 1);
});

// ---------------------------------------------------------------------------
// isPlanComplete
// ---------------------------------------------------------------------------

test("isPlanComplete returns false at start", () => {
  const plan = createPlan(makeTask());
  assert.equal(isPlanComplete(plan), false);
});

test("isPlanComplete returns true at final step", () => {
  const plan = createPlan(makeTask());
  const atEnd = advancePlanBy(plan, 10);
  assert.equal(isPlanComplete(atEnd), true);
});

test("isPlanComplete returns false in the middle", () => {
  const plan = createPlan(makeTask()); // 3 steps
  const mid = advancePlanBy(plan, 1);
  assert.equal(isPlanComplete(mid), false);
});

test("isPlanComplete returns true for single-step plan", () => {
  const plan = createPlan(makeTask({ successCriteria: [] }));
  assert.equal(isPlanComplete(plan), true);
});

// ---------------------------------------------------------------------------
// planToContext
// ---------------------------------------------------------------------------

test("planToContext renders all steps with correct markers", () => {
  const plan = createPlan(makeTask()); // 3 steps, index 0
  const ctx = planToContext(plan);

  assert.ok(ctx.includes("Plan (mode: task):"));
  assert.ok(ctx.includes("[active] Collect pricing"));
  assert.ok(ctx.includes("[pending] Verify: Capture monthly plan"));
  assert.ok(ctx.includes("[pending] Verify: Capture annual plan"));
  assert.ok(ctx.includes("Step 1 of 3"));
});

test("planToContext marks completed steps as done", () => {
  const plan = createPlan(makeTask());
  const advanced = advancePlanBy(plan, 1); // move to step 2
  const ctx = planToContext(advanced);

  assert.ok(ctx.includes("[done] Collect pricing"));
  assert.ok(ctx.includes("[active] Verify: Capture monthly plan"));
  assert.ok(ctx.includes("[pending] Verify: Capture annual plan"));
  assert.ok(ctx.includes("Step 2 of 3"));
});

test("planToContext shows all done when plan is complete", () => {
  const plan = createPlan(makeTask());
  const atEnd = advancePlanBy(plan, 10);
  const ctx = planToContext(atEnd);

  assert.ok(ctx.includes("[done] Collect pricing"));
  assert.ok(ctx.includes("[done] Verify: Capture monthly plan"));
  assert.ok(ctx.includes("[active] Verify: Capture annual plan"));
  assert.ok(ctx.includes("Step 3 of 3"));
});

test("planToContext shows investigate mode", () => {
  const plan = createPlan(makeTask({ mode: "investigate" }));
  const ctx = planToContext(plan);
  assert.ok(ctx.includes("Plan (mode: investigate):"));
});
