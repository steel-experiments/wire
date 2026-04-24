import type { Task, TaskMode } from "../shared/types.js";

// ---------------------------------------------------------------------------
// TaskPlan — decomposition of a complex task into ordered steps
// ---------------------------------------------------------------------------

export interface TaskPlan {
  steps: string[];
  currentStepIndex: number;
  mode: TaskMode;
}

// ---------------------------------------------------------------------------
// createPlan — generate a simple plan from a task's objective and criteria
// ---------------------------------------------------------------------------

export function createPlan(task: Task): TaskPlan {
  const steps: string[] = [];

  // First step is always the core objective
  steps.push(task.objective);

  // Each success criterion becomes a verification step
  for (const criterion of task.successCriteria) {
    steps.push(`Verify: ${criterion}`);
  }

  return {
    steps,
    currentStepIndex: 0,
    mode: task.mode,
  };
}

// ---------------------------------------------------------------------------
// advanceStep — move to the next step in the plan
// ---------------------------------------------------------------------------

export function advanceStep(plan: TaskPlan): TaskPlan {
  if (plan.currentStepIndex >= plan.steps.length - 1) {
    return plan;
  }

  return {
    ...plan,
    currentStepIndex: plan.currentStepIndex + 1,
  };
}

export function advancePlanBy(plan: TaskPlan, steps: number): TaskPlan {
  if (!Number.isFinite(steps) || steps <= 0) {
    return plan;
  }

  const maxIndex = Math.max(0, plan.steps.length - 1);
  const nextIndex = Math.min(maxIndex, plan.currentStepIndex + Math.floor(steps));
  if (nextIndex === plan.currentStepIndex) {
    return plan;
  }

  return {
    ...plan,
    currentStepIndex: nextIndex,
  };
}

// ---------------------------------------------------------------------------
// isPlanComplete — check if all steps have been completed
// ---------------------------------------------------------------------------

export function isPlanComplete(plan: TaskPlan): boolean {
  return plan.currentStepIndex >= plan.steps.length - 1;
}

// ---------------------------------------------------------------------------
// planToContext — render the plan as context for the agent
// ---------------------------------------------------------------------------

export function planToContext(plan: TaskPlan): string {
  const lines: string[] = [];

  lines.push(`Plan (mode: ${plan.mode}):`);

  for (let i = 0; i < plan.steps.length; i++) {
    const marker = i < plan.currentStepIndex ? "done"
      : i === plan.currentStepIndex ? "active"
      : "pending";
    lines.push(`  [${marker}] ${plan.steps[i]!}`);
  }

  lines.push(`Step ${plan.currentStepIndex + 1} of ${plan.steps.length}`);

  return lines.join("\n");
}
