// ABOUTME: Tests for experiment-mode branch decisions.
// ABOUTME: Verifies each branch carries a concrete divergence directive that cannot contaminate the task contract.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { shouldBranch } from "./branching.js";
import { createTaskContract } from "./contract.js";
import type { RunClassification, RunClassificationKind, Task } from "../shared/types.js";

function classification(kind: RunClassificationKind, confidence = 0.8): RunClassification {
  return { kind, confidence };
}

// Every kind that branches must hand the branch run a concrete instruction so
// it explores a different path instead of replaying the parent run verbatim.
const BRANCHING_KINDS: RunClassificationKind[] = [
  "ambiguous",
  "agent-error",
  "site-error",
  "partial-success",
  "counterexample",
];

for (const kind of BRANCHING_KINDS) {
  test(`shouldBranch supplies a divergence directive for ${kind}`, () => {
    const decision = shouldBranch(classification(kind), 1, 3);
    assert.equal(decision.shouldBranch, true);
    assert.ok(decision.directive && decision.directive.trim().length > 0, "expected a non-empty directive");
  });
}

test("shouldBranch supplies a directive on low-confidence branching", () => {
  const decision = shouldBranch(classification("task-complete", 0.3), 1, 3);
  assert.equal(decision.shouldBranch, true);
  assert.ok(decision.directive && decision.directive.trim().length > 0);
});

test("shouldBranch returns no directive when it does not branch", () => {
  const decision = shouldBranch(classification("task-complete", 0.9), 1, 3);
  assert.equal(decision.shouldBranch, false);
  assert.equal(decision.directive, undefined);
});

// A directive rides on the branch task, but it must never look like a success
// criterion to the contract inferrer: no domains (mustVisit), no digits
// (minItems), no format words (mustProduce). Otherwise sibling branches would
// be graded against different contracts and the synthesis is no longer fair.
test("branch directives cannot contaminate the inferred contract", () => {
  const baseTask: Task = {
    id: "task_test",
    title: "t",
    mode: "experiment",
    objective: "Summarize the article",
    constraints: [],
    successCriteria: [],
    createdAt: "2026-06-03T00:00:00.000Z",
  };
  const baseContract = createTaskContract(baseTask);

  const allDirectives = [
    ...BRANCHING_KINDS.map((k) => shouldBranch(classification(k), 1, 3).directive),
    shouldBranch(classification("task-complete", 0.3), 1, 3).directive,
  ].filter((d): d is string => Boolean(d));

  for (const directive of allDirectives) {
    const branchContract = createTaskContract({
      ...baseTask,
      // Even if a directive were appended to constraints, the contract must
      // not change. (In production it rides a separate field; this is belt
      // and suspenders against future refactors.)
      constraints: [directive],
    });
    assert.deepEqual(branchContract.mustVisit, baseContract.mustVisit, `directive added mustVisit: ${directive}`);
    assert.deepEqual(
      branchContract.mustProduce,
      baseContract.mustProduce,
      `directive added mustProduce: ${directive}`,
    );
  }
});
