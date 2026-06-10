import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Hypothesis, TaskId } from "../shared/types.js";

export function createHypothesis(
  taskId: TaskId,
  statement: string,
  rationale?: string,
): Hypothesis {
  const hypothesis: Hypothesis = {
    id: createId("hypothesis"),
    taskId,
    statement,
    status: "active",
    updatedAt: nowIsoUtc(),
  };
  if (rationale) {
    hypothesis.rationale = rationale;
  }
  return hypothesis;
}

