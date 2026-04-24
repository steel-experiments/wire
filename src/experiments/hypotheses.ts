import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Hypothesis, HypothesisId, HypothesisStatus, TaskId } from "../shared/types.js";

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

export function updateHypothesisStatus(
  hypothesis: Hypothesis,
  status: HypothesisStatus,
): Hypothesis {
  return {
    ...hypothesis,
    status,
    updatedAt: nowIsoUtc(),
  };
}

export function summarizeHypotheses(hypotheses: Hypothesis[]): {
  active: number;
  supported: number;
  rejected: number;
  ambiguous: number;
} {
  let active = 0;
  let supported = 0;
  let rejected = 0;
  let ambiguous = 0;

  for (const h of hypotheses) {
    switch (h.status) {
      case "active":
        active += 1;
        break;
      case "supported":
        supported += 1;
        break;
      case "rejected":
        rejected += 1;
        break;
      case "ambiguous":
        ambiguous += 1;
        break;
    }
  }

  return { active, supported, rejected, ambiguous };
}
