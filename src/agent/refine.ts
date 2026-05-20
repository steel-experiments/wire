
import type { LoopResult } from "./loop.js";
import type { Task, TraceEvent } from "../shared/types.js";
import { compareRuns, type RunComparison } from "./compare.js";

// Types

export interface RefinementOptions {
  maxIterations?: number;
  minImprovementPercent?: number;
}

export interface RefinementResult {
  attempted: boolean;
  gateReason?: string;
  comparison?: RunComparison;
  iterations: number;
  stoppedEarly?: boolean;
}

// Safety classification

const DESTRUCTIVE_CODE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /form\.submit\s*\(/u, label: "form submission" },
  { re: /\.submit\s*\(\)/u, label: "element submission" },
  { re: /method\s*:\s*['"](?:POST|PUT|DELETE|PATCH)['"]/iu, label: "HTTP POST/PUT/DELETE/PATCH" },
  { re: /type\s*=\s*['"]password['"]/iu, label: "credential entry" },
  { re: /input\[type.*password\]/iu, label: "credential entry" },
];

const DESTRUCTIVE_URL_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /\/checkout/iu, label: "checkout flow" },
  { re: /\/payment/iu, label: "payment flow" },
  { re: /\/buy/iu, label: "purchase flow" },
  { re: /\/order\/?(?:submit|confirm)?$/iu, label: "order submission" },
];

export function classifyRunSafety(
  events: TraceEvent[],
): { safe: boolean; reasons: string[] } {
  const reasons: string[] = [];

  for (const event of events) {
    // Approval requests mean the run touched something gated
    if (event.kind === "approval-request") {
      reasons.push("required human approval");
      continue;
    }

    // Policy checks that escalated
    if (
      event.kind === "policy-check" &&
      (event.payload["result"] === "require-approval" ||
        event.payload["result"] === "deny")
    ) {
      reasons.push("policy escalation");
      continue;
    }

    // Code-level destructive patterns
    if (event.kind === "code-exec" && typeof event.payload["code"] === "string") {
      const code = event.payload["code"] as string;
      for (const { re, label } of DESTRUCTIVE_CODE_PATTERNS) {
        if (re.test(code)) {
          reasons.push(label);
        }
      }
    }

    // URL-level destructive patterns
    if (event.kind === "observation" && typeof event.payload["url"] === "string") {
      const url = event.payload["url"] as string;
      for (const { re, label } of DESTRUCTIVE_URL_PATTERNS) {
        if (re.test(url)) {
          reasons.push(label);
        }
      }
    }
  }

  return { safe: reasons.length === 0, reasons };
}

// Gate check

export function canRefineRun(
  task: Task,
  result: LoopResult,
): { allowed: boolean; reason?: string } {
  // Mode gate: only investigate or experiment
  if (task.mode === "task") {
    return { allowed: false, reason: `Refinement not allowed in task mode.` };
  }

  // Baseline must have succeeded
  if (result.classification.kind !== "task-complete") {
    return { allowed: false, reason: `Baseline run classified as ${result.classification.kind}, not task-complete.` };
  }

  // Safety gate
  const { safe, reasons } = classifyRunSafety(result.events);
  if (!safe) {
    return { allowed: false, reason: `Destructive actions detected: ${reasons.join(", ")}.` };
  }

  return { allowed: true };
}

// Refinement loop

const DEFAULT_MAX_ITERATIONS = 2;

export async function refineRun(
  task: Task,
  baseline: LoopResult,
  executeFn: (task: Task) => Promise<LoopResult>,
  options?: RefinementOptions,
): Promise<RefinementResult> {
  const maxIterations = options?.maxIterations ?? DEFAULT_MAX_ITERATIONS;

  // Gate check
  const gate = canRefineRun(task, baseline);
  if (!gate.allowed) {
    const blocked: RefinementResult = {
      attempted: false,
      iterations: 0,
    };
    if (gate.reason !== undefined) blocked.gateReason = gate.reason;
    return blocked;
  }

  const allResults: LoopResult[] = [baseline];
  let iterations = 0;
  let stoppedEarly = false;

  for (let i = 0; i < maxIterations; i++) {
    const candidate = await executeFn(task);
    allResults.push(candidate);
    iterations++;

    // Stop if candidate failed where baseline succeeded
    if (candidate.classification.kind !== "task-complete") {
      stoppedEarly = true;
      break;
    }

    // Stop if candidate required approval
    const candidateSafety = classifyRunSafety(candidate.events);
    if (!candidateSafety.safe) {
      stoppedEarly = true;
      break;
    }
  }

  const comparison = compareRuns(task, allResults);

  return {
    attempted: true,
    comparison,
    iterations,
    ...(stoppedEarly ? { stoppedEarly: true } : {}),
  };
}
