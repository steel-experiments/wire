import type { JsonValue, JsonObject } from "./types.js";

// ---------------------------------------------------------------------------
// Secret patterns — used for prompt and trace payload redaction
// ---------------------------------------------------------------------------

export const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/gu,
  /AKIA[0-9A-Z]{16}/gu,
  /AIza[0-9A-Za-z_-]{35}/gu,
  /ya29\.[a-zA-Z0-9_-]{50,}/gu,
  /key[_-]?[a-zA-Z0-9]{16,}/giu,
  /token[_-]?[a-zA-Z0-9]{16,}/giu,
  /password\s*[:=]\s*\S+/giu,
  /bearer\s+[a-zA-Z0-9._-]+/giu,
  /apiKey=[^&\s]+/giu,
];

// ---------------------------------------------------------------------------
// String redaction
// ---------------------------------------------------------------------------

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recursive JSON object redaction
// ---------------------------------------------------------------------------

export function redactJsonObject(obj: JsonObject): JsonObject {
  const result: JsonObject = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === null || value === undefined) {
      result[key] = value;
      continue;
    }

    if (typeof value === "string") {
      result[key] = redactSecrets(value);
      continue;
    }

    if (Array.isArray(value)) {
      result[key] = value.map(redactJsonValue);
      continue;
    }

    if (typeof value === "object") {
      result[key] = redactJsonObject(value as JsonObject);
      continue;
    }

    result[key] = value;
  }

  return result;
}

function redactJsonValue(value: JsonValue): JsonValue {
  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return redactSecrets(value);
  }

  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }

  if (typeof value === "object") {
    return redactJsonObject(value as JsonObject);
  }

  return value;
}
