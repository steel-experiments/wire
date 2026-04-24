import { randomUUID } from "node:crypto";

import type { EntityId, IdPrefix, JsonValue } from "./types.js";

const ISO_8601_UTC_MILLIS =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function createId<TPrefix extends IdPrefix>(prefix: TPrefix): EntityId<TPrefix> {
  return `${prefix}_${randomUUID()}` as EntityId<TPrefix>;
}

export function isEntityId<TPrefix extends IdPrefix>(
  value: string,
  prefix: TPrefix,
): value is EntityId<TPrefix> {
  return value.startsWith(`${prefix}_`) && value.length > prefix.length + 1;
}

export function nowIsoUtc(date = new Date()): string {
  return date.toISOString();
}

export function isIsoUtcTimestamp(value: string): boolean {
  return ISO_8601_UTC_MILLIS.test(value) && !Number.isNaN(Date.parse(value));
}

export function stableJsonStringify(value: JsonValue): string {
  return JSON.stringify(sortJsonValue(value));
}

export function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sortJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJsonValue(child)]),
    );
  }

  return value;
}
