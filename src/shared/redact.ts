import type { JsonValue, JsonObject } from "./types.js";

// Secret patterns — the single source of truth for prompt/trace redaction and
// the skill-minting gate (skills/promote.ts). The sk- body allows hyphens and
// underscores so Anthropic-format keys (sk-ant-api03-...) match.

export const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9_-]{20,}/gu,
  /AKIA[0-9A-Z]{16}/gu,
  /AIza[0-9A-Za-z_-]{35}/gu,
  /ya29\.[a-zA-Z0-9_-]{50,}/gu,
  /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/giu,
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /key[_-]?[a-zA-Z0-9]{16,}/giu,
  /token[_-]?[a-zA-Z0-9]{16,}/giu,
  /(?:password|passwd|pwd)\s*[:=]\s*\S+/giu,
  /(?:api[_-]?key|apikey)\s*[:=]\s*\S+/giu,
  /(?:secret|bearer)\s*[:=]\s*\S+/giu,
  /(?:auth[_-]?token|accesstoken|refresh[_-]?token)\s*[:=]\s*\S+/giu,
  /bearer\s+[a-zA-Z0-9._-]+/giu,
  /apiKey=[^&\s]+/giu,
  /(?<=\/\/)[^/\s@]+:[^/\s@]+(?=@)/gu,
];

// Detection (no replacement). Resets lastIndex so the shared /g patterns stay
// stateless across calls.

export function containsSecrets(content: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(content);
  });
}

// String redaction

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}

// Recursive JSON object redaction

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
