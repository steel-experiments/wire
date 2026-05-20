import type {
  Artifact,
  JsonObject,
  JsonValue,
  Run,
  Task,
  TaskMode,
  TraceEvent,
} from "../shared/types.js";
import { redactJsonObject, redactSecrets } from "../shared/redact.js";
import { scoreRun, type RunScore } from "./scoring.js";

export type TrajectoryExportFormat = "trajectory" | "sft" | "rewards" | "preferences";

export interface TraceTrajectory {
  version: 1;
  task: {
    id: string;
    mode: TaskMode;
    objective: string;
    constraints: string[];
    successCriteria: string[];
  };
  run: {
    id: string;
    status: string;
    classification: string;
    score: RunScore;
  };
  trajectory: Array<{
    kind: TraceEvent["kind"];
    ts: string;
    payload: JsonObject;
  }>;
  artifacts: Array<{
    id: string;
    kind: string;
    path: string;
    mimeType?: string;
    metadata?: JsonObject;
  }>;
}

export interface SftExample {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  metadata: {
    taskId: string;
    runId: string;
    score: number;
    classification: string;
    eventIndex: number;
  };
}

export interface RewardExample {
  prompt: string;
  completion: string;
  reward: number;
  components: RunScore["components"];
  metadata: {
    taskId: string;
    runId: string;
    classification: string;
    eventIndex: number;
  };
}

export interface PreferenceExample {
  prompt: string;
  chosen: string;
  rejected: string;
  chosenScore: number;
  rejectedScore: number;
  metadata: {
    taskId: string;
    chosenRunId: string;
    rejectedRunId: string;
  };
}

const SYSTEM_PROMPT = [
  "You are Wire, a zero-weight browser agent.",
  "Act through concise, inspectable browser code.",
  "Preserve evidence and respect explicit policy boundaries.",
].join(" ");

function payloadText(payload: JsonObject): string {
  return redactSecrets(JSON.stringify(redactJsonObject(payload)));
}

function summarizePriorEvents(events: TraceEvent[], maxEvents = 6): string {
  const prior = events.slice(-maxEvents);
  if (prior.length === 0) return "No prior trace events.";
  return prior.map((event) => {
    if (event.kind === "observation") {
      return `observation: ${String(event.payload.url ?? "")} title=${String(event.payload.title ?? "")}`;
    }
    if (event.kind === "code-result") {
      return `code-result: ok=${String(event.payload.ok ?? "")} stdout=${String(event.payload.stdout ?? "").slice(0, 240)}`;
    }
    if (event.kind === "artifact") {
      return `artifact: ${String(event.payload.kind ?? "")} ${String(event.payload.filename ?? event.payload.path ?? "")}`;
    }
    if (event.kind === "contract-check") {
      return `contract-check: passed=${String(event.payload.passed ?? "")}`;
    }
    return `${event.kind}: ${payloadText(event.payload).slice(0, 240)}`;
  }).join("\n");
}

function codeExecEvents(trajectory: TraceTrajectory): Array<{ event: TraceTrajectory["trajectory"][number]; index: number }> {
  return trajectory.trajectory.flatMap((event, index) => event.kind === "code-exec" ? [{ event, index }] : []);
}

function codeFromPayload(payload: JsonObject): string | undefined {
  const code = payload.code;
  return typeof code === "string" && code.trim().length > 0 ? code : undefined;
}

function promptForEvent(trajectory: TraceTrajectory, eventIndex: number): string {
  const prior = trajectory.trajectory.slice(0, eventIndex).map((event) => ({
    id: `event_${eventIndex}`,
    runId: trajectory.run.id as `run_${string}`,
    ts: event.ts,
    kind: event.kind,
    payload: event.payload,
  })) as TraceEvent[];
  return [
    `Objective: ${trajectory.task.objective}`,
    trajectory.task.constraints.length > 0 ? `Constraints: ${trajectory.task.constraints.join("; ")}` : "",
    trajectory.task.successCriteria.length > 0 ? `Success criteria: ${trajectory.task.successCriteria.join("; ")}` : "",
    "Recent trace:",
    summarizePriorEvents(prior),
  ].filter(Boolean).join("\n");
}

export function toTraceTrajectory(
  task: Task,
  run: Run,
  events: TraceEvent[],
  artifacts: Artifact[],
  options: { maxSteps?: number } = {},
): TraceTrajectory {
  const score = scoreRun(task, run, events, artifacts, options);
  return {
    version: 1,
    task: {
      id: task.id,
      mode: task.mode,
      objective: redactSecrets(task.objective),
      constraints: task.constraints.map(redactSecrets),
      successCriteria: task.successCriteria.map(redactSecrets),
    },
    run: {
      id: run.id,
      status: run.status,
      classification: run.classification?.kind ?? "ambiguous",
      score,
    },
    trajectory: events.map((event) => ({
      kind: event.kind,
      ts: event.ts,
      payload: redactJsonObject(event.payload),
    })),
    artifacts: artifacts.map((artifact) => ({
      id: artifact.id,
      kind: artifact.kind,
      path: redactSecrets(artifact.path),
      ...(artifact.mimeType ? { mimeType: artifact.mimeType } : {}),
      ...(artifact.metadata ? { metadata: redactJsonObject(artifact.metadata) } : {}),
    })),
  };
}

export function toSftExamples(trajectory: TraceTrajectory, minScore = 0): SftExample[] {
  if (trajectory.run.score.total < minScore) return [];
  return codeExecEvents(trajectory).flatMap(({ event, index }) => {
    const code = codeFromPayload(event.payload);
    if (!code) return [];
    return [{
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: promptForEvent(trajectory, index) },
        { role: "assistant", content: code },
      ],
      metadata: {
        taskId: trajectory.task.id,
        runId: trajectory.run.id,
        score: trajectory.run.score.total,
        classification: trajectory.run.classification,
        eventIndex: index,
      },
    }];
  });
}

export function toRewardExamples(trajectory: TraceTrajectory): RewardExample[] {
  return codeExecEvents(trajectory).flatMap(({ event, index }) => {
    const completion = codeFromPayload(event.payload);
    if (!completion) return [];
    return [{
      prompt: promptForEvent(trajectory, index),
      completion,
      reward: trajectory.run.score.total,
      components: trajectory.run.score.components,
      metadata: {
        taskId: trajectory.task.id,
        runId: trajectory.run.id,
        classification: trajectory.run.classification,
        eventIndex: index,
      },
    }];
  });
}

function finalCompletion(trajectory: TraceTrajectory): string {
  const code = codeExecEvents(trajectory)
    .map(({ event }) => codeFromPayload(event.payload))
    .filter((value): value is string => value !== undefined);
  if (code.length > 0) return code.join("\n\n");
  const result = trajectory.trajectory.findLast((event) =>
    event.kind === "thought-summary" || event.kind === "code-result"
  );
  return result ? payloadText(result.payload) : JSON.stringify(trajectory.run);
}

export function toPreferencePair(
  chosen: TraceTrajectory,
  rejected: TraceTrajectory,
  minDelta = 0.2,
): PreferenceExample | null {
  if (chosen.task.id !== rejected.task.id) return null;
  if (chosen.run.score.total - rejected.run.score.total < minDelta) return null;
  return {
    prompt: [
      `Objective: ${chosen.task.objective}`,
      chosen.task.constraints.length > 0 ? `Constraints: ${chosen.task.constraints.join("; ")}` : "",
      chosen.task.successCriteria.length > 0 ? `Success criteria: ${chosen.task.successCriteria.join("; ")}` : "",
    ].filter(Boolean).join("\n"),
    chosen: finalCompletion(chosen),
    rejected: finalCompletion(rejected),
    chosenScore: chosen.run.score.total,
    rejectedScore: rejected.run.score.total,
    metadata: {
      taskId: chosen.task.id,
      chosenRunId: chosen.run.id,
      rejectedRunId: rejected.run.id,
    },
  };
}

export function exportRows(
  trajectories: TraceTrajectory[],
  format: TrajectoryExportFormat,
  options: { minScore?: number; minPreferenceDelta?: number } = {},
): JsonValue[] {
  if (format === "trajectory") return trajectories as unknown as JsonValue[];
  if (format === "sft") return trajectories.flatMap((trajectory) => toSftExamples(trajectory, options.minScore ?? 0)) as unknown as JsonValue[];
  if (format === "rewards") return trajectories.flatMap(toRewardExamples) as unknown as JsonValue[];

  const rows: PreferenceExample[] = [];
  const byTask = new Map<string, TraceTrajectory[]>();
  for (const trajectory of trajectories) {
    const group = byTask.get(trajectory.task.id) ?? [];
    group.push(trajectory);
    byTask.set(trajectory.task.id, group);
  }

  for (const group of byTask.values()) {
    const sorted = [...group].sort((a, b) => b.run.score.total - a.run.score.total);
    const chosen = sorted[0];
    const rejected = sorted[sorted.length - 1];
    if (!chosen || !rejected || chosen.run.id === rejected.run.id) continue;
    const pair = toPreferencePair(chosen, rejected, options.minPreferenceDelta ?? 0.2);
    if (pair) rows.push(pair);
  }
  return rows as unknown as JsonValue[];
}
