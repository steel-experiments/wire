// ABOUTME: Crystallize a completed run's trace into an ordered, re-runnable browser script.
// Skills capture durable site knowledge; a crafted script captures the task solution as code.

import type { TraceEvent } from "../shared/types.js";
import { DEFAULT_HELPER_SOURCE } from "../browser/helpers.js";

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
  /**
   * Emit a self-contained Node script (helpers inlined, minimal CDP runner
   * over the built-in WebSocket) runnable against any CDP endpoint — a Steel
   * session's wsUrl or a local Chrome — with no Wire runtime involved.
   */
  standalone?: boolean;
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

// Single-line form of a possibly multi-line objective, safe inside a // comment.
function commentSafe(text: string): string {
  return text.replace(/\s*\n\s*/gu, " ").trim();
}

function standaloneHeader(objective: string, runId: string | undefined, generatedAt: string | undefined, stepCount: number): string {
  const lines = [
    "#!/usr/bin/env node",
    "// ===== Wire crafted script (standalone) =====",
    `// Objective: ${commentSafe(objective) || "(none recorded)"}`,
  ];
  if (runId) lines.push(`// Source run: ${runId}`);
  if (generatedAt) lines.push(`// Generated: ${generatedAt}`);
  lines.push(
    "//",
    `// Self-contained replay of ${stepCount} browser step(s) — no Wire runtime required.`,
    "// Usage: node crafted.mjs <cdp-websocket-url>",
    "//   e.g. a Steel session's wsUrl, or ws://127.0.0.1:9222/... from a local",
    "//   Chrome started with --remote-debugging-port=9222.",
    "// Steps run in order via Runtime.evaluate; the replay stops on the first failure.",
    "// Patch step code as the site changes.",
  );
  return lines.join("\n");
}

// The fixed runner body of a standalone crafted script. Deliberately plain:
// Node's built-in WebSocket, an id-correlated CDP send(), page-target attach,
// then one Runtime.evaluate per step with the helpers prepended — a minimal
// echo of how Wire's own exec bridge drives a session.
const STANDALONE_RUNNER = `
const url = process.argv[2];
if (!url) {
  console.error("Usage: node crafted.mjs <cdp-websocket-url>");
  process.exit(1);
}

const ws = new WebSocket(url);
let nextId = 1;
const pending = new Map();

function send(method, params, sessionId) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
  });
}

ws.addEventListener("message", (event) => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg.result);
  }
});

ws.addEventListener("error", () => {
  console.error("WebSocket connection failed: " + url);
  process.exit(1);
});

ws.addEventListener("open", async () => {
  try {
    // A browser-level endpoint needs a page target attach; a page-level
    // endpoint (".../devtools/page/<id>") accepts evaluate directly.
    let sessionId;
    if (!url.includes("/devtools/page/")) {
      const { targetInfos } = await send("Target.getTargets", {});
      const page = targetInfos.find((t) => t.type === "page");
      if (!page) throw new Error("no page target found at " + url);
      ({ sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true }));
    }
    for (const step of STEPS) {
      const wrapped = "(async () => {\\n" + HELPERS + "\\n" + step.code + "\\n})()";
      const result = await send("Runtime.evaluate", { expression: wrapped, awaitPromise: true, returnByValue: true }, sessionId);
      if (result.exceptionDetails) {
        const detail = result.exceptionDetails.exception && result.exceptionDetails.exception.description
          ? result.exceptionDetails.exception.description
          : result.exceptionDetails.text;
        throw new Error("step " + step.index + " (" + step.intent + ") failed: " + detail);
      }
      const value = result.result && result.result.value !== undefined ? " " + JSON.stringify(result.result.value) : "";
      console.log("step " + step.index + " (" + step.intent + ") ok" + value);
    }
  } catch (err) {
    console.error(String(err && err.message ? err.message : err));
    process.exitCode = 1;
  } finally {
    ws.close();
  }
});
`.trimStart();

function standaloneSource(objective: string, steps: CraftedStep[], options: CrystallizeOptions): string {
  const stepLiterals = steps.map((step) =>
    `  { index: ${step.index}, intent: ${JSON.stringify(step.intent)}, code: ${JSON.stringify(step.code.trim())} },`
  );
  return [
    standaloneHeader(objective, options.runId, options.generatedAt, steps.length),
    "",
    `const HELPERS = ${JSON.stringify(DEFAULT_HELPER_SOURCE)};`,
    "",
    "const STEPS = [",
    ...stepLiterals,
    "];",
    "",
    STANDALONE_RUNNER,
  ].join("\n").replace(/\n+$/u, "\n");
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

  if (options.standalone === true) {
    const crafted: CraftedScript = { objective, steps, source: standaloneSource(objective, steps, options) };
    if (options.runId !== undefined) crafted.runId = options.runId;
    return crafted;
  }

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
