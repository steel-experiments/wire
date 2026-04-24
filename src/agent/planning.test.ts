import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Task } from "../shared/types.js";
import { advancePlanBy, createPlan } from "./planning.js";

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
