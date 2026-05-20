import type { TraceEvent, RunId } from "../shared/types.js";

// Trace replay utilities

export interface ReplayTimeline {
  runId: RunId;
  events: TraceEvent[];
  startTime: string;
  endTime: string;
  durationMs: number;
}

export function buildTimeline(events: TraceEvent[], runId: RunId): ReplayTimeline {
  const runEvents = events
    .filter((e) => e.runId === runId)
    .sort((a, b) => a.ts.localeCompare(b.ts));

  const startTime = runEvents[0]?.ts ?? "";
  const endTime = runEvents[runEvents.length - 1]?.ts ?? "";
  const durationMs = runEvents.length >= 2
    ? Date.parse(endTime) - Date.parse(startTime)
    : 0;

  return { runId, events: runEvents, startTime, endTime, durationMs };
}

export function filterByKind(events: TraceEvent[], kind: TraceEvent["kind"]): TraceEvent[] {
  return events.filter((e) => e.kind === kind);
}

export function summarizeTimeline(timeline: ReplayTimeline): string {
  const lines: string[] = [
    `Run ${timeline.runId}`,
    `  Events: ${timeline.events.length}`,
    `  Duration: ${timeline.durationMs}ms`,
    `  Start: ${timeline.startTime}`,
    `  End: ${timeline.endTime}`,
  ];

  const kinds = new Map<string, number>();
  for (const event of timeline.events) {
    kinds.set(event.kind, (kinds.get(event.kind) ?? 0) + 1);
  }

  for (const [kind, count] of kinds) {
    lines.push(`  ${kind}: ${count}`);
  }

  return lines.join("\n");
}
