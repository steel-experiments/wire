// ABOUTME: Crystallize a completed run's trace into an ordered, re-runnable browser script.
// Skills capture durable site knowledge; a crafted script captures the task solution as code.

import type { TraceEvent } from "../shared/types.js";

export type CraftedStepIntent = "navigate" | "inspect" | "interact" | "exec";

export interface CraftedStep {
  /** 1-based position in the crafted script. */
  index: number;
  intent: CraftedStepIntent;
  ok: boolean;
  code: string;
}

export interface CraftedScript {
  objective: string;
  runId?: string;
  steps: CraftedStep[];
  /** The full annotated program: a header plus each step's code in order. */
  source: string;
}

export interface CrystallizeOptions {
  objective?: string;
  runId?: string;
  /** ISO timestamp to stamp into the header; omitted from output when absent. */
  generatedAt?: string;
  /** Keep failed execs (annotated as failed) instead of dropping them. */
  includeFailed?: boolean;
}

function classifyIntent(code: string): CraftedStepIntent {
  if (/location\.href|location\.assign|window\.location|Page\.navigate|Page\.reload/u.test(code)) {
    return "navigate";
  }
  if (/wire\.click|clickVisibleText|fillByLabel|\.click\s*\(|dispatchMouseEvent|dispatchKeyEvent/u.test(code)) {
    return "interact";
  }
  if (/\breturn\b|document\.|querySelector|innerText|aria|extractTable|getAttribute/u.test(code)) {
    return "inspect";
  }
  return "exec";
}

/**
 * Pair each `code-exec` (with a `code` string) to the `code-result` that
 * immediately follows it, yielding the ordered list of executed steps and
 * whether each succeeded. Execs with no following result (e.g. a trailing
 * action that never completed) and raw-command execs (no code string) are
 * skipped.
 *
 * Relies on `events` being in chronological order — which persisted traces are
 * (the runtime emits exec then result, and `result.ts > exec.ts` because the
 * browser round trip sits between them; `listTraceEvents` sorts by `ts`).
 */
function pairExecsWithResults(events: TraceEvent[]): Array<{ code: string; ok: boolean }> {
  const steps: Array<{ code: string; ok: boolean }> = [];
  let pendingCode: string | undefined;

  for (const event of events) {
    if (event.kind === "code-exec") {
      const code = typeof event.payload.code === "string" ? event.payload.code : undefined;
      pendingCode = code && code.trim().length > 0 ? code : undefined;
      continue;
    }
    if (event.kind === "code-result" && pendingCode !== undefined) {
      steps.push({ code: pendingCode, ok: event.payload.ok === true });
      pendingCode = undefined;
    }
  }

  return steps;
}

function header(objective: string, runId: string | undefined, generatedAt: string | undefined, stepCount: number): string {
  const lines = [
    "// ===== Wire crafted script =====",
    `// Objective: ${objective || "(none recorded)"}`,
  ];
  if (runId) lines.push(`// Source run: ${runId}`);
  if (generatedAt) lines.push(`// Generated: ${generatedAt}`);
  lines.push(
    "//",
    stepCount > 0
      ? `// Replays ${stepCount} browser step(s) in order. Each block is one Wire exec`
      : "// This run produced no successful browser steps to crystallize.",
  );
  if (stepCount > 0) {
    lines.push(
      "// action (async; `wire.click`, clickVisibleText, fillByLabel, extractTable,",
      "// waitForSelector and top-level `return` are provided by the Wire exec sandbox).",
      "// Re-run through Wire and patch steps as the site changes.",
    );
  }
  return lines.join("\n");
}

/**
 * Turn a completed run's trace into a re-runnable script: the ordered sequence
 * of successful browser `exec` steps, annotated by intent, plus a single
 * `source` program string suitable for saving as a durable artifact.
 */
export function crystallizeRunScript(events: TraceEvent[], options: CrystallizeOptions = {}): CraftedScript {
  const includeFailed = options.includeFailed === true;
  const paired = pairExecsWithResults(events).filter((step) => includeFailed || step.ok);

  const steps: CraftedStep[] = paired.map((step, i) => ({
    index: i + 1,
    intent: classifyIntent(step.code),
    ok: step.ok,
    code: step.code,
  }));

  const objective = options.objective ?? "";
  const blocks = steps.map((step) => {
    const failedMark = step.ok ? "" : " — FAILED in source run";
    return `// --- Step ${step.index} (${step.intent})${failedMark} ---\n${step.code.trim()}\n`;
  });

  const source = [header(objective, options.runId, options.generatedAt, steps.length), "", ...blocks]
    .join("\n")
    .replace(/\n+$/u, "\n");

  const crafted: CraftedScript = { objective, steps, source };
  if (options.runId !== undefined) crafted.runId = options.runId;
  return crafted;
}
