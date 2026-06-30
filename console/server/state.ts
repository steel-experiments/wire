// ABOUTME: Reads persisted Wire records from ~/.wire/state as plain JSON.
// ABOUTME: Treats the state dir as data; never imports Wire's storage code.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WireTraceEvent } from "../src/lib/protocol";

export function stateRoot(): string {
  if (process.env.WIRE_ROOT) return process.env.WIRE_ROOT;
  const home = process.env.WIRE_HOME ?? join(homedir(), ".wire");
  return join(home, "state");
}

interface PersistedRun {
  id?: string;
  taskId?: string;
  sessionId?: string;
  status?: string;
  result?: string;
  outcomeSummary?: string;
  stepCount?: number;
  startedAt?: string;
  finishedAt?: string;
  classification?: { kind?: string };
}

interface PersistedTask {
  objective?: string;
  mode?: string;
}

async function readJsonFile<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as T;
  } catch {
    return null;
  }
}

/** Read a run record by id, or null if missing/unreadable. */
export async function readRunRecord(runId: string): Promise<PersistedRun | null> {
  return readJsonFile<PersistedRun>(join(stateRoot(), "runs", `${runId}.json`));
}

export interface HistoricalRun {
  runId: string;
  objective: string;
  mode: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  stepCount: number;
  classification?: string;
  result?: string;
  outcomeSummary?: string;
}

/** List finished runs persisted under ~/.wire/state, newest first. */
export async function listHistoricalRuns(limit = 50): Promise<HistoricalRun[]> {
  const runsDir = join(stateRoot(), "runs");
  let files: string[];
  try {
    files = (await readdir(runsDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const taskCache = new Map<string, PersistedTask | null>();
  const runs: HistoricalRun[] = [];

  for (const name of files) {
    const rec = await readJsonFile<PersistedRun>(join(runsDir, name));
    if (!rec?.id) continue;

    let objective = "";
    let mode = "task";
    if (rec.taskId) {
      let task = taskCache.get(rec.taskId);
      if (task === undefined) {
        task = await readJsonFile<PersistedTask>(join(stateRoot(), "tasks", `${rec.taskId}.json`));
        taskCache.set(rec.taskId, task);
      }
      if (task?.objective) objective = task.objective;
      if (task?.mode) mode = task.mode;
    }

    runs.push({
      runId: rec.id,
      objective: objective || "(unknown objective)",
      mode,
      status: rec.status ?? "unknown",
      startedAt: rec.startedAt ?? "",
      ...(rec.finishedAt ? { finishedAt: rec.finishedAt } : {}),
      stepCount: rec.stepCount ?? 0,
      ...(rec.classification?.kind ? { classification: rec.classification.kind } : {}),
      ...(rec.result ? { result: rec.result } : {}),
      ...(rec.outcomeSummary ? { outcomeSummary: rec.outcomeSummary } : {}),
    });
  }

  runs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return runs.slice(0, limit);
}

/** The Steel session id for a run, or null if the run has no session. */
export async function runSessionId(runId: string): Promise<string | null> {
  const run = await readRunRecord(runId);
  return run?.sessionId ?? null;
}

/** Load a finished run's persisted trace events, oldest first. */
export async function listRunEvents(runId: string): Promise<WireTraceEvent[]> {
  const dir = join(stateRoot(), "events");
  let files: string[];
  try {
    files = (await readdir(dir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }

  const events: WireTraceEvent[] = [];
  for (const name of files) {
    const event = await readJsonFile<WireTraceEvent>(join(dir, name));
    if (event && event.runId === runId) events.push(event);
  }
  events.sort((a, b) => a.ts.localeCompare(b.ts));
  return events;
}
