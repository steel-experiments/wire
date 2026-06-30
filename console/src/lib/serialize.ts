// ABOUTME: Serializes a run into a clean text/markdown blob for copying out —
// ABOUTME: the full context (objective, answer, output, trace) to paste elsewhere.

import type { RunSummary, WireTraceEvent } from "./protocol";
import { finishSummary, prettyResult } from "./format";

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** A read-only, full-detail row for the trace (no UI clipping). */
function describe(event: WireTraceEvent): { label: string; detail: string } | null {
  const p = event.payload;
  switch (event.kind) {
    case "observation":
      return { label: "observe", detail: `${str(p.url)}${str(p.title) ? ` — ${str(p.title)}` : ""}` };
    case "code-exec":
      return { label: "exec", detail: str(p.code) || (p.rawCommands ? `raw[${str(p.rawCommands)}]` : "(no code)") };
    case "code-result": {
      const ok = p.ok === true;
      return { label: ok ? "ok" : "err", detail: ok ? str(p.returnValue ?? p.stdout) : str(p.stderr ?? p.returnValue) };
    }
    case "thought-summary":
      return { label: p.kind === "finish" ? "finish" : "stop", detail: str(p.summary ?? p.reason) };
    case "policy-check":
      return { label: "policy", detail: `${str(p.result)} ${str(p.policyKind ?? p.actionKind)}` };
    case "approval-request":
      return { label: "approval", detail: str(p.summary) };
    case "error":
      return { label: "error", detail: str(p.message ?? p.code) };
    case "contract-check":
      if (p.phase === "created") return { label: "contract", detail: str(p.summary) };
      return { label: "contract", detail: p.passed === true ? "passed" : str((p.missing as unknown[])?.join("; ")) };
    default:
      return null;
  }
}

export function serializeRun(summary: RunSummary, events: WireTraceEvent[]): string {
  const lines: string[] = [`# ${summary.objective}`, ""];

  const meta = [`status: ${summary.status}`, `mode: ${summary.mode}`];
  if (summary.runId) meta.push(`run: ${summary.runId}`);
  if (summary.classification) meta.push(`classification: ${summary.classification}`);
  if (summary.startedAt) meta.push(`started: ${summary.startedAt}`);
  lines.push(meta.join(" · "));

  const answer = finishSummary(events);
  if (answer) lines.push("", "## Answer", answer);
  if (summary.result) lines.push("", "## Output", prettyResult(summary.result));
  if (summary.error) lines.push("", "## Error", summary.error);

  const rows = events
    .map((event) => ({ event, row: describe(event) }))
    .filter((r) => r.row);
  if (rows.length > 0) {
    lines.push("", "## Trace");
    let step = 0;
    for (const { event, row } of rows) {
      if (event.kind === "code-exec") step += 1;
      const num = event.kind === "code-exec" ? String(step).padStart(2) : "  ";
      lines.push(`${num} ${row!.label.padEnd(8)} ${row!.detail}`);
    }
  }

  return lines.join("\n");
}
