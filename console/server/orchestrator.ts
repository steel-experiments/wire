// ABOUTME: Launches/resumes `wire ... --stream-json` subprocesses, republishes
// ABOUTME: their NDJSON trace to the bus, and finalizes from the run record.

import { randomUUID } from "node:crypto";
import type { LaunchRequest, RunStatus, RunSummary, WireTraceEvent } from "../src/lib/protocol";
import type { EventBus } from "./bus";
import { LineSplitter } from "./line-splitter";
import { listHistoricalRuns, readRunRecord } from "./state";

// The command used to invoke Wire. Override with WIRE_CMD (space-separated),
// e.g. `WIRE_CMD="node /path/to/wire/dist/index.js"` to run a local build.
function wireCommand(): string[] {
  const raw = process.env.WIRE_CMD ?? "wire";
  return raw.split(" ").filter((part) => part.length > 0);
}

const registry = new Map<string, RunSummary>();
let seeded = false;

function mapPersistedStatus(status: string): RunStatus {
  if (["failed", "error", "aborted", "errored"].includes(status)) return "error";
  return "finished";
}

// Hydrate the registry from ~/.wire/state once, so runs from prior sessions
// (and runs orphaned by a dev-server restart) reappear in the console. Live
// runs from this session take precedence and are never overwritten.
async function seedHistory(): Promise<void> {
  if (seeded) return;
  seeded = true;
  const liveRunIds = new Set([...registry.values()].map((r) => r.runId).filter(Boolean));
  for (const run of await listHistoricalRuns()) {
    if (liveRunIds.has(run.runId)) continue;
    const launchId = `hist:${run.runId}`;
    if (registry.has(launchId)) continue;
    registry.set(launchId, {
      launchId,
      runId: run.runId,
      objective: run.objective,
      mode: run.mode,
      status: mapPersistedStatus(run.status),
      startedAt: run.startedAt,
      stepCount: run.stepCount,
      ...(run.finishedAt ? { finishedAt: run.finishedAt } : {}),
      ...(run.classification ? { classification: run.classification } : {}),
      ...(run.result ? { result: run.result } : {}),
      ...(run.outcomeSummary ? { outcomeSummary: run.outcomeSummary } : {}),
    });
  }
}

export async function listRuns(): Promise<RunSummary[]> {
  await seedHistory();
  return [...registry.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

function publish(bus: EventBus, summary: RunSummary, kind: "run-updated" | "run-finished"): void {
  registry.set(summary.launchId, summary);
  bus.publish({ type: kind, run: { ...summary } });
}

function handleLine(bus: EventBus, launchId: string, line: string): void {
  const summary = registry.get(launchId);
  if (!summary) return;

  let event: WireTraceEvent;
  try {
    event = JSON.parse(line) as WireTraceEvent;
  } catch {
    return; // non-JSON noise on stdout is ignored
  }

  if (!summary.runId && event.runId) {
    summary.runId = event.runId;
    publish(bus, summary, "run-updated");
  }

  // The session event announces the live browser viewer before step 1. Prefer
  // Wire's debugUrl (the public, embeddable Steel player) over liveUrl (the
  // auth-gated app.steel.dev dashboard, which would show a sign-in wall).
  if (event.kind === "session") {
    const live = event.payload["debugUrl"] ?? event.payload["liveUrl"];
    if (typeof live === "string") {
      summary.liveViewUrl = live;
      publish(bus, summary, "run-updated");
    }
    return;
  }

  // A destructive action is gated; surface the proposed action for approval.
  if (event.kind === "approval-request") {
    const p = event.payload;
    const proposed = (p["proposedAction"] ?? {}) as Record<string, unknown>;
    summary.pendingApproval = {
      approvalId: String(p["approvalId"] ?? ""),
      summary: String(p["summary"] ?? "Approval required"),
      ...(typeof proposed["kind"] === "string" ? { actionKind: proposed["kind"] } : {}),
      ...(typeof proposed["riskKind"] === "string" ? { riskKind: proposed["riskKind"] } : {}),
      ...(typeof proposed["codeExcerpt"] === "string" ? { codeExcerpt: proposed["codeExcerpt"] } : {}),
    };
    publish(bus, summary, "run-updated");
    bus.publish({ type: "trace", launchId, runId: summary.runId, event });
    return;
  }

  if (event.kind === "approval-result") delete summary.pendingApproval;
  if (event.kind === "code-exec") summary.stepCount += 1;
  bus.publish({ type: "trace", launchId, runId: summary.runId, event });
}

async function streamWire(
  bus: EventBus,
  launchId: string,
  args: string[],
): Promise<{ exitCode: number; stderr: string }> {
  const summary = registry.get(launchId)!;
  const [bin, ...prefix] = wireCommand();

  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([bin!, ...prefix, ...args], { stdout: "pipe", stderr: "pipe", env: process.env });
  } catch (err) {
    return { exitCode: -1, stderr: err instanceof Error ? err.message : String(err) };
  }

  summary.status = "running";
  publish(bus, summary, "run-updated");

  let stderr = "";
  const drainStderr = (async () => {
    const decoder = new TextDecoder();
    const reader = proc.stderr.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stderr += decoder.decode(value, { stream: true });
    }
  })();

  const splitter = new LineSplitter();
  const decoder = new TextDecoder();
  const reader = proc.stdout.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of splitter.push(decoder.decode(value, { stream: true }))) handleLine(bus, launchId, line);
  }
  for (const line of splitter.flush()) handleLine(bus, launchId, line);

  const exitCode = await proc.exited;
  await drainStderr;
  return { exitCode, stderr };
}

async function finalize(bus: EventBus, launchId: string, exitCode: number, stderr: string): Promise<void> {
  const summary = registry.get(launchId)!;
  summary.exitCode = exitCode;
  summary.finishedAt = new Date().toISOString();

  const record = summary.runId ? await readRunRecord(summary.runId) : null;
  if (record) {
    if (record.classification?.kind) summary.classification = record.classification.kind;
    if (record.result) summary.result = record.result;
    if (record.outcomeSummary) summary.outcomeSummary = record.outcomeSummary;
  }

  // A run that stopped at an unresolved approval gate is paused, not done.
  if (summary.pendingApproval) summary.status = "awaiting-approval";
  else summary.status = exitCode === 0 ? "finished" : "error";

  if (exitCode !== 0 && stderr.trim()) summary.error = stderr.trim().split("\n").slice(-3).join("\n");
  publish(bus, summary, "run-finished");
}

export function launchRun(bus: EventBus, req: LaunchRequest): RunSummary {
  const launchId = randomUUID();
  const summary: RunSummary = {
    launchId,
    objective: req.objective,
    mode: req.mode ?? "task",
    status: "starting",
    startedAt: new Date().toISOString(),
    stepCount: 0,
  };
  registry.set(launchId, summary);
  bus.publish({ type: "run-started", run: { ...summary } });

  const args = ["run", "--stream-json", "--objective", req.objective];
  if (req.mode) args.push("--mode", req.mode);
  if (req.maxSteps) args.push("--max-steps", String(req.maxSteps));
  if (req.provider) args.push("--provider", req.provider);
  if (req.model) args.push("--model", req.model);

  void streamWire(bus, launchId, args).then(({ exitCode, stderr }) => finalize(bus, launchId, exitCode, stderr));
  return summary;
}

/** Approve a run paused at a policy gate; resumes it via `wire approve`. */
export function approveLaunch(bus: EventBus, launchId: string): { ok: boolean; error?: string } {
  const summary = registry.get(launchId);
  if (!summary) return { ok: false, error: "unknown run" };
  if (!summary.runId) return { ok: false, error: "run has no id yet" };
  if (!summary.pendingApproval) return { ok: false, error: "no pending approval" };

  const runId = summary.runId;
  delete summary.pendingApproval;
  delete summary.finishedAt;
  delete summary.exitCode;
  summary.status = "running";
  publish(bus, summary, "run-updated");

  void streamWire(bus, launchId, ["approve", "--run-id", runId, "--stream-json"]).then(({ exitCode, stderr }) =>
    finalize(bus, launchId, exitCode, stderr),
  );
  return { ok: true };
}
