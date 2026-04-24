import type { RunId, TraceEvent, TraceEventId } from "../shared/types.js";
import { parseBoundary, traceEventSchema } from "../shared/schemas.js";
import {
  atomicWriteJson,
  CorruptError,
  entityDir,
  entityPath,
  listJsonFiles,
  NotFoundError,
  readJsonFile,
} from "./atomic.js";

const KIND = "events";

function eventFilePath(root: string, id: TraceEventId): string {
  return entityPath(root, KIND, id);
}

export async function saveTraceEvent(root: string, event: TraceEvent): Promise<void> {
  await atomicWriteJson(eventFilePath(root, event.id), event);
}

export async function saveTraceEvents(root: string, events: TraceEvent[]): Promise<void> {
  for (const event of events) {
    await saveTraceEvent(root, event);
  }
}

export async function loadTraceEvent(root: string, eventId: TraceEventId): Promise<TraceEvent> {
  const path = eventFilePath(root, eventId);
  const raw = await readJsonFile(path);

  if (raw === undefined) {
    throw new NotFoundError(KIND, eventId);
  }

  try {
    return parseBoundary<TraceEvent>(traceEventSchema, raw, "trace-event");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}

export async function listTraceEvents(root: string, runId?: RunId): Promise<TraceEvent[]> {
  const dir = entityDir(root, KIND);
  const files = await listJsonFiles(dir);
  const events: TraceEvent[] = [];

  for (const name of files) {
    const id = name.replace(/\.json$/u, "") as TraceEventId;
    const path = entityPath(root, KIND, id);

    let raw: unknown;
    try {
      raw = await readJsonFile(path);
    } catch {
      continue;
    }

    let event: TraceEvent;
    try {
      event = parseBoundary<TraceEvent>(traceEventSchema, raw, "trace-event");
    } catch {
      continue;
    }

    if (runId === undefined || event.runId === runId) {
      events.push(event);
    }
  }

  return events.sort((lhs, rhs) => lhs.ts.localeCompare(rhs.ts));
}
