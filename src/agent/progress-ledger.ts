import type { JsonObject, JsonValue, ProgressLedgerEntry, TraceEvent } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { LoopState } from "./loop.js";

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asEntry(value: unknown): ProgressLedgerEntry | undefined {
  return isJsonObject(value) ? value : undefined;
}

function entriesFromCandidate(value: unknown): ProgressLedgerEntry[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => {
      const entry = asEntry(item);
      return entry ? [entry] : [];
    });
  }
  const entry = asEntry(value);
  return entry ? [entry] : [];
}

export function progressEntriesFromValue(value: unknown): ProgressLedgerEntry[] {
  if (!isJsonObject(value)) return [];
  const candidates = [
    value["progressLedger"],
    value["progress"],
    value["ledger"],
  ];
  for (const candidate of candidates) {
    const entries = entriesFromCandidate(candidate);
    if (entries.length > 0) return entries;
  }
  return [];
}

export function progressEntriesFromExecResult(returnValue: unknown, stdout?: string): ProgressLedgerEntry[] {
  const fromReturnValue = progressEntriesFromValue(returnValue);
  if (fromReturnValue.length > 0) return fromReturnValue;
  if (typeof stdout !== "string" || stdout.trim().length === 0) return [];
  try {
    return progressEntriesFromValue(JSON.parse(stdout) as unknown);
  } catch {
    return [];
  }
}

function entryKey(entry: ProgressLedgerEntry): string | undefined {
  const key = entry["key"] ?? entry["id"];
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
}

export function upsertProgressEntries(
  ledger: ProgressLedgerEntry[],
  entries: ProgressLedgerEntry[],
): ProgressLedgerEntry[] {
  const next = [...ledger];
  for (const entry of entries) {
    const key = entryKey(entry);
    if (!key) {
      next.push(entry);
      continue;
    }
    const existing = next.findIndex((item) => entryKey(item) === key);
    if (existing === -1) {
      next.push(entry);
    } else {
      next[existing] = { ...next[existing]!, ...entry };
    }
  }
  return next;
}

export function appendProgressLedgerEntries(
  state: LoopState,
  entries: ProgressLedgerEntry[],
): void {
  if (entries.length === 0) return;
  state.progressLedger = upsertProgressEntries(state.progressLedger, entries);
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "progress-ledger",
    payload: {
      entries: entries as unknown as JsonValue,
      ledger: state.progressLedger as unknown as JsonValue,
      count: entries.length,
      total: state.progressLedger.length,
    },
  });
}

export function progressLedgerFromEvents(events: TraceEvent[]): ProgressLedgerEntry[] {
  let ledger: ProgressLedgerEntry[] = [];
  for (const event of events) {
    if (event.kind !== "progress-ledger") continue;
    const payloadLedger = entriesFromCandidate(event.payload.ledger);
    if (payloadLedger.length > 0) {
      ledger = payloadLedger;
      continue;
    }
    ledger = upsertProgressEntries(ledger, entriesFromCandidate(event.payload.entries));
  }
  return ledger;
}

export function progressLedgerText(ledger: ProgressLedgerEntry[]): string {
  return JSON.stringify(ledger, null, 2);
}
