import type { ArtifactKind, JsonObject, Task, TraceEvent } from "../shared/types.js";
import { looksLikeUnextractedPage } from "./classify.js";
import { extractFirstJsonObject, extractFirstJsonArray } from "./llm-parse.js";

export type ContractArtifactFormat = "markdown" | "json" | "csv" | "text" | "file";

export interface TaskContract {
  mustVisit: string[];
  mustMention: string[];
  /** Explicit entities named by the user that must appear in the final evidence. */
  mustCoverEntities?: string[];
  /** Question-shaped objectives must end with a stated answer, not page material. */
  mustAnswer?: boolean;
  mustProduce?: {
    artifact?: boolean;
    format?: ContractArtifactFormat;
    table?: boolean;
    minItems?: number;
  };
  mustNotContain: string[];
}

export interface ContractValidation {
  passed: boolean;
  missing: string[];
  satisfied: string[];
  totalChecks: number;
}

const PLACEHOLDER_PHRASES = [
  "see open",
  "included in prior",
  "preserved as part of",
  "previously extracted",
  "raw text was not preserved",
  "not preserved",
  "extracted below",
  "content was included",
  "stats not found",
  "not found in body text",
  "auth wall or stats not found",
  "auth wall",
  "not accessible",
  "not available",
  "unavailable",
  "could not extract",
  "could not find",
  "unable to extract",
  "unable to find",
];

const ENTITY_ID_FIELDS = new Set([
  "account",
  "handle",
  "id",
  "key",
  "name",
  "profile",
  "user",
  "username",
]);
const ENTITY_VALUE_METADATA_FIELDS = new Set([
  "artifact",
  "currentuser",
  "error",
  "errors",
  "evidence",
  "href",
  "nextpage",
  "nextuser",
  "ok",
  "page",
  "raw",
  "rawhtml",
  "rawtext",
  "reason",
  "source",
  "target",
  "url",
]);
const STRUCTURED_PLACEHOLDER_VALUE_PATTERN =
  /^(?:n\/?a|na|none|null|unknown|unavailable|not\s+(?:available|found|accessible)|auth\s+wall|blocked|error|failed)$/iu;
const STRUCTURED_FAILURE_TEXT_PATTERN =
  /\b(?:auth\s+wall|sign[-\s]?in\s+required|login\s+required|not\s+(?:available|found|accessible)|could\s+not|unable\s+to|cannot\s+(?:extract|find|access)|blocked|forbidden|failed|error)\b/iu;
const FIELD_LEVEL_PLACEHOLDER_PHRASES = new Set([
  "not accessible",
  "not available",
  "unavailable",
]);

const DOMAIN_PATTERN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/giu;
const ENTITY_LIST_PATTERNS = [
  /\b(?:users?|accounts?|profiles?|usernames?)\s*[:,]?\s*([^.;\n]+)/iu,
  /\bfor\s+(?:users?|accounts?|profiles?|usernames?)\s*[:,]?\s*([^.;\n]+)/iu,
];
const ENTITY_STOP_WORDS = new Set([
  "and",
  "or",
  "with",
  "from",
  "stats",
  "statistics",
  "data",
  "the",
  "these",
  "those",
  "find",
  "return",
  "extract",
  "collect",
  "go",
  "to",
  "for",
  "users",
  "user",
  "accounts",
  "profiles",
  "usernames",
]);
const FILE_EXTENSION_DOMAIN_SUFFIXES = new Set([
  "csv",
  "css",
  "gif",
  "html",
  "jpeg",
  "jpg",
  "js",
  "json",
  "md",
  "pdf",
  "png",
  "svg",
  "ts",
  "txt",
  "webp",
  "xml",
  "yaml",
  "yml",
  "zip",
]);

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function normalizeDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./u, "");
}

function isLikelyVisitDomain(domain: string): boolean {
  const parts = normalizeDomain(domain).split(".");
  const suffix = parts.at(-1);
  return suffix !== undefined && !FILE_EXTENSION_DOMAIN_SUFFIXES.has(suffix);
}

function objectiveText(task: Task): string {
  return [task.objective, ...task.successCriteria, ...task.constraints].join("\n");
}

function inferFormat(text: string): ContractArtifactFormat | undefined {
  if (/\b(?:md|markdown)\b|\.md\b/iu.test(text)) return "markdown";
  if (/\bjson\b|\.json\b/iu.test(text)) return "json";
  if (/\bcsv\b|\.csv\b/iu.test(text)) return "csv";
  // Text is the trickiest format to infer because "text" is also a common
  // noun in objectives ("the heading text", "page text content"). Require a
  // signal that actually implies output format: a directional preposition
  // (as/in/to/into), the "plain text" idiom, a "text format/file/output"
  // qualifier, or a .txt extension.
  if (/\.txt\b|\bplain\s+text\b|\b(?:as|in|to|into)\s+(?:plain\s+)?text\b|\btext\s+(?:format|file|output)\b/iu.test(text)) {
    return "text";
  }
  return undefined;
}

// An objective is question-shaped when it opens with an interrogative word or
// ends in a question mark. Only the objective itself is checked — success
// criteria and constraints routinely contain incidental questions.
const QUESTION_PATTERN = /^(?:what|who|whom|whose|when|where|which|why|how)\b|\?\s*$/iu;

function isQuestionObjective(objective: string): boolean {
  return QUESTION_PATTERN.test(objective.trim());
}

function inferMinItems(text: string): number | undefined {
  const match = text.match(/\b(?:top|first|find|extract|collect|list|return|save)\s+(\d{1,3})\b/iu);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

function normalizeEntity(value: string): string {
  return value.trim().replace(/^@/u, "").toLowerCase();
}

function inferRequiredEntities(text: string): string[] {
  for (const pattern of ENTITY_LIST_PATTERNS) {
    const match = text.match(pattern);
    if (!match?.[1]) continue;
    const listText = match[1]
      .replace(/\band\b/giu, ",")
      .replace(/\s+/gu, " ");
    const entities = unique(
      listText
        .split(/[,，]/u)
        .map((part) => part.trim().replace(/^["'`@]+|["'`.]+$/gu, ""))
        .map(normalizeEntity)
        .filter((part) =>
          /^[a-z0-9][a-z0-9_-]{1,38}$/u.test(part) &&
          !ENTITY_STOP_WORDS.has(part) &&
          !part.includes(".")
        ),
    );
    if (entities.length >= 2) return entities;
  }
  return [];
}

export function createTaskContract(task: Task): TaskContract {
  const text = objectiveText(task);
  const mustVisit = unique((text.match(DOMAIN_PATTERN) ?? []).filter(isLikelyVisitDomain).map(normalizeDomain));
  const format = inferFormat(text);
  const requiredEntities = inferRequiredEntities(text);
  const wantsArtifact = /\b(?:save|write|export|download|artifact|file|md|markdown|json|csv|txt|text)\b/iu.test(text);
  const wantsTable = /\btable\b|comparison table/iu.test(text);
  const wantsExtraction = /\b(?:extract|find|return|collect|list|save|compare)\b/iu.test(text);
  const minItems = Math.max(inferMinItems(text) ?? 0, requiredEntities.length || 0) || undefined;

  const mustProduce = wantsArtifact || wantsTable || format || minItems !== undefined
    ? {
      ...(wantsArtifact ? { artifact: true } : {}),
      ...(format ? { format } : {}),
      ...(wantsTable ? { table: true } : {}),
      ...(minItems !== undefined ? { minItems } : {}),
    }
    : undefined;

  // Investigate/experiment objectives are often phrased as questions but end
  // in findings rather than a single extractable answer, so only task mode
  // carries the answer requirement.
  const mustAnswer = task.mode === "task" && isQuestionObjective(task.objective);

  return {
    mustVisit,
    // No mention requirement is inferred from domains: mustVisit already
    // verifies navigation, and demanding the site's brand word appear in the
    // final result falsely fails extraction tasks whose output is data from
    // the site rather than its name. mustMention stays settable via task-file.
    mustMention: [],
    ...(requiredEntities.length > 0 ? { mustCoverEntities: requiredEntities } : {}),
    ...(mustAnswer ? { mustAnswer: true } : {}),
    ...(mustProduce ? { mustProduce } : {}),
    mustNotContain: wantsExtraction
      ? PLACEHOLDER_PHRASES
      : [],
  };
}

export function contractToPrompt(contract: TaskContract): string {
  const lines: string[] = [];
  if (contract.mustVisit.length > 0) lines.push(`- Must visit: ${contract.mustVisit.join(", ")}`);
  if (contract.mustMention.length > 0) lines.push(`- Final result must mention: ${contract.mustMention.join(", ")}`);
  if (contract.mustCoverEntities && contract.mustCoverEntities.length > 0) {
    lines.push(`- Final result must include every requested entity: ${contract.mustCoverEntities.join(", ")}`);
  }
  if (contract.mustAnswer) {
    lines.push("- Final result must state a direct answer to the question, extracted from a source — not raw page text or search-results text.");
  }
  if (contract.mustProduce) {
    const parts: string[] = [];
    if (contract.mustProduce.artifact) parts.push("artifact");
    if (contract.mustProduce.format) parts.push(contract.mustProduce.format);
    if (contract.mustProduce.table) parts.push("table");
    if (contract.mustProduce.minItems !== undefined) parts.push(`at least ${contract.mustProduce.minItems} items`);
    if (parts.length > 0) lines.push(`- Must produce: ${parts.join(", ")}`);
  }
  if (contract.mustNotContain.length > 0) {
    lines.push("- Must not contain placeholder extraction claims");
  }
  return lines.length > 0 ? lines.join("\n") : "- No extra completion contract inferred.";
}

export function contractSummary(contract: TaskContract): string {
  const parts: string[] = [];
  if (contract.mustVisit.length > 0) parts.push(`visit: ${contract.mustVisit.join(", ")}`);
  if (contract.mustAnswer) parts.push("answer required");
  if (contract.mustProduce) {
    const produce: string[] = [];
    if (contract.mustProduce.format) produce.push(contract.mustProduce.format);
    if (contract.mustProduce.table) produce.push("table");
    else if (contract.mustProduce.artifact) produce.push("artifact");
    if (contract.mustProduce.minItems !== undefined) produce.push(`${contract.mustProduce.minItems} items`);
    if (produce.length > 0) parts.push(produce.join(" "));
  }
  if (contract.mustMention.length > 0) parts.push(`mention: ${contract.mustMention.join(", ")}`);
  if (contract.mustCoverEntities && contract.mustCoverEntities.length > 0) parts.push(`entities: ${contract.mustCoverEntities.join(", ")}`);
  if (contract.mustNotContain.length > 0) parts.push("no placeholders");
  return parts.length > 0 ? parts.join(" · ") : "no extra completion contract";
}

function contractToJson(contract: TaskContract): JsonObject {
  const value: JsonObject = {
    mustVisit: contract.mustVisit,
    mustMention: contract.mustMention,
    mustNotContain: contract.mustNotContain,
  };
  if (contract.mustCoverEntities) {
    value.mustCoverEntities = contract.mustCoverEntities;
  }
  if (contract.mustAnswer) {
    value.mustAnswer = true;
  }
  if (contract.mustProduce) {
    value.mustProduce = { ...contract.mustProduce };
  }
  return value;
}

export function contractCreatedPayload(contract: TaskContract): JsonObject {
  return {
    phase: "created",
    summary: contractSummary(contract),
    contract: contractToJson(contract),
  };
}

function eventText(event: TraceEvent): string {
  const parts: string[] = [event.kind];
  const payload = event.payload;
  for (const value of Object.values(payload)) {
    if (typeof value === "string") parts.push(value);
    else if (typeof value === "number" || typeof value === "boolean") parts.push(String(value));
    else if (value !== null && value !== undefined) {
      try {
        parts.push(JSON.stringify(value));
      } catch {
        // Ignore unserializable trace payloads.
      }
    }
  }
  return parts.join("\n");
}

function artifactEvents(events: TraceEvent[]): TraceEvent[] {
  return events.filter((event) =>
    event.kind === "artifact" &&
    event.payload.source !== "task-summary" &&
    typeof event.payload.content === "string" &&
    event.payload.content.trim().length > 0
  );
}

function combinedAnswerText(events: TraceEvent[], result?: string): string {
  const parts = typeof result === "string" ? [result] : [];
  for (const event of artifactEvents(events)) {
    parts.push(String(event.payload.content));
  }
  for (const event of events) {
    if (event.kind === "progress-ledger") {
      parts.push(eventText(event));
    }
  }
  const latestResult = [...events].reverse().find((event) =>
    event.kind === "code-result" &&
    event.payload.ok === true &&
    event.payload.source !== "wireActions" &&
    event.payload.source !== "raw"
  );
  if (latestResult) parts.push(eventText(latestResult));
  return parts.join("\n\n");
}

function hasVisitedDomain(events: TraceEvent[], domain: string): boolean {
  const wanted = normalizeDomain(domain);
  const wantedLabel = wanted.split(".")[0] ?? wanted;
  return events.some((event) => {
    if (event.kind !== "observation") return false;
    const candidates = [
      typeof event.payload.url === "string" ? event.payload.url : "",
      Array.isArray(event.payload.tabs) ? JSON.stringify(event.payload.tabs) : "",
    ];
    return candidates.some((candidate) => {
      try {
        const observed = normalizeDomain(new URL(candidate).hostname);
        // Exact match or true subdomain (dot boundary) — a lookalike like
        // evilgithub.com must not satisfy github.com. The first-label match
        // is deliberate redirect tolerance: sites migrate TLDs mid-run
        // (railway.app -> railway.com) and the visit should still count.
        return observed === wanted ||
          observed.endsWith(`.${wanted}`) ||
          observed.split(".")[0] === wantedLabel;
      } catch {
        return candidate.toLowerCase().includes(wanted);
      }
    });
  });
}

function artifactMatchesFormat(event: TraceEvent, format: ContractArtifactFormat): boolean {
  const filename = String(event.payload.filename ?? event.payload.path ?? "").toLowerCase();
  const mimeType = String(event.payload.mimeType ?? "").toLowerCase();
  const kind = String(event.payload.kind ?? "") as ArtifactKind;
  if (format === "markdown") return kind === "markdown" || mimeType.includes("markdown") || filename.endsWith(".md");
  if (format === "json") return kind === "json-output" || mimeType.includes("json") || filename.endsWith(".json");
  if (format === "csv") return mimeType.includes("csv") || filename.endsWith(".csv");
  if (format === "text") return mimeType.startsWith("text/") || filename.endsWith(".txt");
  return true;
}

function markdownTableRows(text: string): string[] {
  const lines = text.split(/\r?\n/u);
  const rows: string[] = [];
  for (const line of lines) {
    if (!/^\s*\|.+\|\s*$/u.test(line)) continue;
    if (/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(line)) continue;
    rows.push(line);
  }
  return rows;
}

function countItems(text: string): number {
  const tableRows = markdownTableRows(text);
  if (tableRows.length > 1) return tableRows.length - 1;
  const bullets = text.match(/^\s*(?:[-*]|\d+[.)])\s+\S/gmu)?.length ?? 0;
  if (bullets > 0) return bullets;
  return countJsonItems(text);
}

function jsonItemCount(parsed: unknown): number {
  if (Array.isArray(parsed)) return parsed.length;
  if (parsed && typeof parsed === "object") {
    const arrays = Object.values(parsed as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length > 0) return Math.max(...arrays.map((value) => value.length));
  }
  return 0;
}

// The text is usually a blob of several concatenated parts (final result +
// artifact contents + latest code-result, each prefixed with its event kind),
// so the whole string is rarely valid JSON. Scan every embedded JSON
// object/array span and return the largest item count found — a single rich
// part is enough to satisfy a "produce at least N items" requirement.
function countJsonItems(text: string): number {
  let max = 0;
  for (const parsed of parseJsonSpans(text)) {
    max = Math.max(max, jsonItemCount(parsed));
  }
  return max;
}

function parseJsonSpans(text: string): unknown[] {
  const parsed: unknown[] = [];
  let rest = text;
  while (rest.length > 0) {
    const objStart = rest.indexOf("{");
    const arrStart = rest.indexOf("[");
    if (objStart === -1 && arrStart === -1) break;
    const useArray = arrStart !== -1 && (objStart === -1 || arrStart < objStart);
    const start = useArray ? arrStart : objStart;
    const span = useArray ? extractFirstJsonArray(rest) : extractFirstJsonObject(rest);
    if (span === undefined) {
      rest = rest.slice(start + 1);
      continue;
    }
    try {
      parsed.push(JSON.parse(span) as unknown);
    } catch {
      // Not valid JSON despite balanced brackets; skip this span.
    }
    rest = rest.slice(start + span.length);
  }
  return parsed;
}

function normalizeRecordFieldName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function primitiveText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function normalizedEntityValue(value: unknown): string | undefined {
  const text = primitiveText(value);
  if (!text) return undefined;
  const normalized = normalizeEntity(text);
  return normalized.length > 0 ? normalized : undefined;
}

function recordEntityValues(record: Record<string, unknown>): string[] {
  const values: string[] = [];
  const collectFrom = (source: Record<string, unknown>): void => {
    for (const [key, value] of Object.entries(source)) {
      if (!ENTITY_ID_FIELDS.has(normalizeRecordFieldName(key))) continue;
      const normalized = normalizedEntityValue(value);
      if (normalized) values.push(normalized);
    }
  };
  collectFrom(record);
  if (isPlainObject(record.fields)) collectFrom(record.fields);
  if (isPlainObject(record.data)) collectFrom(record.data);
  return unique(values);
}

function looksLikeEntityRecord(record: Record<string, unknown>): boolean {
  return recordEntityValues(record).length > 0;
}

function collectEntityRecords(value: unknown, out: Record<string, unknown>[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEntityRecords(item, out);
    return;
  }
  if (!isPlainObject(value)) return;

  if (looksLikeEntityRecord(value)) out.push(value);

  for (const key of ["entries", "progress", "ledger", "records", "results", "items", "rows", "users", "profiles", "data"]) {
    if (key in value) collectEntityRecords(value[key], out);
  }
}

function markdownTableRecords(text: string): Record<string, unknown>[] {
  const lines = text.split(/\r?\n/u);
  const records: Record<string, unknown>[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!/^\s*\|.+\|\s*$/u.test(lines[index]!)) {
      index++;
      continue;
    }
    const block: string[] = [];
    while (index < lines.length && /^\s*\|.+\|\s*$/u.test(lines[index]!)) {
      block.push(lines[index]!);
      index++;
    }
    if (block.length < 3 || !/^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u.test(block[1]!)) {
      continue;
    }
    const headers = splitMarkdownRow(block[0]!).map(normalizeRecordFieldName);
    for (const row of block.slice(2)) {
      const cells = splitMarkdownRow(row);
      const record: Record<string, unknown> = {};
      headers.forEach((header, cellIndex) => {
        if (header.length > 0) record[header] = cells[cellIndex] ?? "";
      });
      if (looksLikeEntityRecord(record)) records.push(record);
    }
  }
  return records;
}

function splitMarkdownRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/u, "")
    .replace(/\|$/u, "")
    .split("|")
    .map((cell) => cell.trim());
}

function recordsByEntityFromText(text: string): Map<string, Record<string, unknown>[]> {
  const records: Record<string, unknown>[] = [];
  for (const parsed of parseJsonSpans(text)) collectEntityRecords(parsed, records);
  records.push(...markdownTableRecords(text));

  const byEntity = new Map<string, Record<string, unknown>[]>();
  for (const record of records) {
    for (const entity of recordEntityValues(record)) {
      const bucket = byEntity.get(entity) ?? [];
      bucket.push(record);
      byEntity.set(entity, bucket);
    }
  }
  return byEntity;
}

function isStructuredPlaceholderValue(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return true;
  return STRUCTURED_PLACEHOLDER_VALUE_PATTERN.test(trimmed) ||
    STRUCTURED_FAILURE_TEXT_PATTERN.test(trimmed);
}

function countSubstantiveRecordValues(value: unknown, entity: string, keyPath: string[] = []): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countSubstantiveRecordValues(item, entity, keyPath), 0);
  }
  if (isPlainObject(value)) {
    let total = 0;
    for (const [key, child] of Object.entries(value)) {
      const normalizedKey = normalizeRecordFieldName(key);
      if (ENTITY_ID_FIELDS.has(normalizedKey) || ENTITY_VALUE_METADATA_FIELDS.has(normalizedKey)) continue;
      total += countSubstantiveRecordValues(child, entity, [...keyPath, normalizedKey]);
    }
    return total;
  }

  const text = primitiveText(value);
  if (text === undefined) return 0;
  const key = keyPath.at(-1) ?? "";
  if (ENTITY_ID_FIELDS.has(key) || ENTITY_VALUE_METADATA_FIELDS.has(key)) return 0;
  if (isStructuredPlaceholderValue(text)) return 0;
  if (normalizeEntity(text) === normalizeEntity(entity)) return 0;
  return 1;
}

function hasSubstantiveRecordValue(record: Record<string, unknown>, entity: string): boolean {
  return countSubstantiveRecordValues(record, entity) > 0;
}

function entityHasSubstantiveRecord(recordsByEntity: Map<string, Record<string, unknown>[]>, entity: string): boolean {
  const records = recordsByEntity.get(normalizeEntity(entity)) ?? [];
  return records.some((record) => hasSubstantiveRecordValue(record, entity));
}

function allRequiredEntitiesHaveSubstantiveRecords(
  recordsByEntity: Map<string, Record<string, unknown>[]>,
  entities: string[] | undefined,
): boolean {
  return (entities ?? []).length > 0 &&
    (entities ?? []).every((entity) => entityHasSubstantiveRecord(recordsByEntity, entity));
}

function shouldIgnoreFieldLevelPlaceholder(
  phrase: string,
  contract: TaskContract,
  recordsByEntity: Map<string, Record<string, unknown>[]>,
): boolean {
  return FIELD_LEVEL_PLACEHOLDER_PHRASES.has(phrase) &&
    allRequiredEntitiesHaveSubstantiveRecords(recordsByEntity, contract.mustCoverEntities);
}

export function validateTaskContract(
  contract: TaskContract,
  events: TraceEvent[],
  result?: string,
): ContractValidation {
  const missing: string[] = [];
  const satisfied: string[] = [];
  const answerText = combinedAnswerText(events, result);
  const answerLower = answerText.toLowerCase();
  const artifacts = artifactEvents(events);

  for (const domain of contract.mustVisit) {
    if (!hasVisitedDomain(events, domain)) {
      missing.push(`Missing visited evidence for ${domain}`);
    } else {
      satisfied.push(`Visited ${domain}`);
    }
  }

  for (const label of contract.mustMention) {
    const labelLower = label.toLowerCase();
    if (!answerLower.includes(labelLower) && !answerLower.includes(labelLower.replace(/\s+/gu, ""))) {
      missing.push(`Final result does not mention ${label}`);
    } else {
      satisfied.push(`Final result mentions ${label}`);
    }
  }

  const structuredRecordsByEntity = recordsByEntityFromText(answerText);
  const hasStructuredEntityRecords = structuredRecordsByEntity.size > 0;
  for (const entity of contract.mustCoverEntities ?? []) {
    const escaped = entity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const pattern = new RegExp(`(?:^|[^a-z0-9_-])@?${escaped}(?:$|[^a-z0-9_-])`, "iu");
    if (!pattern.test(answerText)) {
      missing.push(`Final result is missing requested entity ${entity}`);
    } else {
      satisfied.push(`Final result includes requested entity ${entity}`);
    }

    if (hasStructuredEntityRecords) {
      const records = structuredRecordsByEntity.get(normalizeEntity(entity)) ?? [];
      if (records.length === 0) {
        missing.push(`Final result has no structured record for requested entity ${entity}`);
      } else if (!entityHasSubstantiveRecord(structuredRecordsByEntity, entity)) {
        missing.push(`Final result has only placeholder or failure values for requested entity ${entity}`);
      } else {
        satisfied.push(`Final result has substantive values for requested entity ${entity}`);
      }
    }
  }

  // The answer check looks only at the run's final result, not the combined
  // evidence trail: SERP dumps legitimately appear as evidence in artifacts
  // and code-results, but the result itself must be the extracted answer.
  if (contract.mustAnswer) {
    const resultText = result?.trim() ?? "";
    if (resultText.length === 0) {
      missing.push("Final result does not state an answer to the question");
    } else if (looksLikeUnextractedPage(resultText)) {
      missing.push("Final result looks like raw page or search-results text, not an extracted answer");
    } else {
      satisfied.push("Final result states an extracted answer");
    }
  }

  if (contract.mustProduce?.artifact && artifacts.length === 0) {
    missing.push("Missing non-summary artifact");
  } else if (contract.mustProduce?.artifact) {
    satisfied.push("Produced non-summary artifact");
  }

  if (contract.mustProduce?.format && !artifacts.some((event) => artifactMatchesFormat(event, contract.mustProduce!.format!))) {
    missing.push(`Missing ${contract.mustProduce.format} artifact`);
  } else if (contract.mustProduce?.format) {
    satisfied.push(`Produced ${contract.mustProduce.format} artifact`);
  }

  if (contract.mustProduce?.table && markdownTableRows(answerText).length < 3) {
    missing.push("Missing markdown table with meaningful rows");
  } else if (contract.mustProduce?.table) {
    satisfied.push("Produced markdown table with meaningful rows");
  }

  const minItems = contract.mustProduce?.minItems;
  if (minItems !== undefined && countItems(answerText) < minItems) {
    missing.push(`Expected at least ${minItems} items in final result`);
  } else if (minItems !== undefined) {
    satisfied.push(`Produced at least ${minItems} items in final result`);
  }

  for (const phrase of contract.mustNotContain) {
    if (answerLower.includes(phrase) && !shouldIgnoreFieldLevelPlaceholder(phrase, contract, structuredRecordsByEntity)) {
      missing.push(`Final result contains placeholder text: ${phrase}`);
    } else {
      satisfied.push(`Final result avoids placeholder text: ${phrase}`);
    }
  }

  return {
    passed: missing.length === 0,
    missing,
    satisfied,
    totalChecks: missing.length + satisfied.length,
  };
}

export function contractValidationPayload(validation: ContractValidation): JsonObject {
  return {
    phase: "validated",
    passed: validation.passed,
    missing: validation.missing,
    satisfied: validation.satisfied,
    totalChecks: validation.totalChecks,
  };
}
