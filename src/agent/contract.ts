import type { ArtifactKind, JsonObject, Task, TraceEvent } from "../shared/types.js";

export type ContractArtifactFormat = "markdown" | "json" | "csv" | "text" | "file";

export interface TaskContract {
  mustVisit: string[];
  mustMention: string[];
  mustProduce?: {
    artifact?: boolean;
    format?: ContractArtifactFormat;
    table?: boolean;
    minItems?: number;
  };
  mustReach: Array<
    | { kind: "contains-number"; value: number }
    | { kind: "min-count"; value: number }
  >;
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
  "extracted below",
  "content was included",
];

const DOMAIN_PATTERN = /\b(?:[a-z0-9-]+\.)+[a-z]{2,}\b/giu;
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

function labelFromDomain(domain: string): string {
  const first = normalizeDomain(domain).split(".")[0] ?? domain;
  return first.length > 0 ? first[0]!.toUpperCase() + first.slice(1) : domain;
}

function objectiveText(task: Task): string {
  return [task.objective, ...task.successCriteria, ...task.constraints].join("\n");
}

function inferFormat(text: string): ContractArtifactFormat | undefined {
  if (/\b(?:md|markdown)\b|\.md\b/iu.test(text)) return "markdown";
  if (/\bjson\b|\.json\b/iu.test(text)) return "json";
  if (/\bcsv\b|\.csv\b/iu.test(text)) return "csv";
  if (/\b(?:txt|text)\b|\.txt\b/iu.test(text)) return "text";
  return undefined;
}

function inferMinItems(text: string): number | undefined {
  const match = text.match(/\b(?:top|first|find|extract|collect|list|return|save)\s+(\d{1,3})\b/iu);
  if (!match) return undefined;
  const count = Number(match[1]);
  return Number.isFinite(count) && count > 0 ? count : undefined;
}

function inferWinTargetNumbers(text: string): number[] {
  const values: number[] = [];
  const patterns = [
    /\b(?:play|beat|solve)\s+(?:the\s+)?(\d{2,6})(?:\s+(?:game|puzzle))?\b/giu,
    /\bwin\s+(?:the\s+)?(\d{2,6})\s+(?:game|puzzle)\b/giu,
    /\b(\d{2,6})\s+(?:game|puzzle)\b[^\n.;:,]*\bwin\b/giu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) values.push(value);
    }
  }
  return [...new Set(values)];
}

export function createTaskContract(task: Task): TaskContract {
  const text = objectiveText(task);
  const lower = text.toLowerCase();
  const mustVisit = unique((text.match(DOMAIN_PATTERN) ?? []).filter(isLikelyVisitDomain).map(normalizeDomain));
  const mustMention = unique(mustVisit.map(labelFromDomain));
  const format = inferFormat(text);
  const wantsArtifact = /\b(?:save|write|export|download|artifact|file|md|markdown|json|csv|txt|text)\b/iu.test(text);
  const wantsTable = /\btable\b|comparison table/iu.test(text);
  const minItems = inferMinItems(text);
  const mustReach: TaskContract["mustReach"] = [];

  if (/\bwin\b/iu.test(text)) {
    for (const value of inferWinTargetNumbers(text)) {
      mustReach.push({ kind: "contains-number", value });
    }
  }

  if (minItems !== undefined) {
    mustReach.push({ kind: "min-count", value: minItems });
  }

  const mustProduce = wantsArtifact || wantsTable || format || minItems !== undefined
    ? {
      ...(wantsArtifact ? { artifact: true } : {}),
      ...(format ? { format } : {}),
      ...(wantsTable ? { table: true } : {}),
      ...(minItems !== undefined ? { minItems } : {}),
    }
    : undefined;

  return {
    mustVisit,
    mustMention,
    ...(mustProduce ? { mustProduce } : {}),
    mustReach,
    mustNotContain: lower.includes("extract") || lower.includes("save") || lower.includes("compare")
      ? PLACEHOLDER_PHRASES
      : [],
  };
}

export function contractToPrompt(contract: TaskContract): string {
  const lines: string[] = [];
  if (contract.mustVisit.length > 0) lines.push(`- Must visit: ${contract.mustVisit.join(", ")}`);
  if (contract.mustMention.length > 0) lines.push(`- Final result must mention: ${contract.mustMention.join(", ")}`);
  if (contract.mustProduce) {
    const parts: string[] = [];
    if (contract.mustProduce.artifact) parts.push("artifact");
    if (contract.mustProduce.format) parts.push(contract.mustProduce.format);
    if (contract.mustProduce.table) parts.push("table");
    if (contract.mustProduce.minItems !== undefined) parts.push(`at least ${contract.mustProduce.minItems} items`);
    if (parts.length > 0) lines.push(`- Must produce: ${parts.join(", ")}`);
  }
  for (const reach of contract.mustReach) {
    if (reach.kind === "contains-number") lines.push(`- Must show evidence containing: ${reach.value}`);
    if (reach.kind === "min-count") lines.push(`- Must show at least ${reach.value} items`);
  }
  if (contract.mustNotContain.length > 0) {
    lines.push("- Must not contain placeholder extraction claims");
  }
  return lines.length > 0 ? lines.join("\n") : "- No extra completion contract inferred.";
}

export function contractSummary(contract: TaskContract): string {
  const parts: string[] = [];
  if (contract.mustVisit.length > 0) parts.push(`visit: ${contract.mustVisit.join(", ")}`);
  if (contract.mustProduce) {
    const produce: string[] = [];
    if (contract.mustProduce.format) produce.push(contract.mustProduce.format);
    if (contract.mustProduce.table) produce.push("table");
    else if (contract.mustProduce.artifact) produce.push("artifact");
    if (contract.mustProduce.minItems !== undefined) produce.push(`${contract.mustProduce.minItems} items`);
    if (produce.length > 0) parts.push(produce.join(" "));
  }
  if (contract.mustReach.length > 0) {
    const reach = contract.mustReach.map((item) =>
      item.kind === "contains-number" ? String(item.value) : `${item.value} items`
    );
    parts.push(`evidence: ${reach.join(", ")}`);
  }
  if (contract.mustMention.length > 0) parts.push(`mention: ${contract.mustMention.join(", ")}`);
  if (contract.mustNotContain.length > 0) parts.push("no placeholders");
  return parts.length > 0 ? parts.join(" · ") : "no extra completion contract";
}

function contractToJson(contract: TaskContract): JsonObject {
  const value: JsonObject = {
    mustVisit: contract.mustVisit,
    mustMention: contract.mustMention,
    mustReach: contract.mustReach.map((item) => ({ kind: item.kind, value: item.value })),
    mustNotContain: contract.mustNotContain,
  };
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
        return observed.endsWith(wanted) || observed.split(".")[0] === wantedLabel;
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
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === "object") {
      const values = Object.values(parsed as Record<string, unknown>);
      const arrays = values.filter(Array.isArray);
      if (arrays.length > 0) return Math.max(...arrays.map((value) => value.length));
    }
  } catch {
    // Not JSON.
  }
  return 0;
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

  for (const reach of contract.mustReach) {
    if (reach.kind === "contains-number" && !new RegExp(`\\b${reach.value}\\b`, "u").test(answerText)) {
      missing.push(`Missing evidence containing ${reach.value}`);
    } else if (reach.kind === "contains-number") {
      satisfied.push(`Found evidence containing ${reach.value}`);
    }
    if (reach.kind === "min-count" && countItems(answerText) < reach.value) {
      missing.push(`Expected at least ${reach.value} items in final result`);
    } else if (reach.kind === "min-count") {
      satisfied.push(`Found at least ${reach.value} items in final result`);
    }
  }

  for (const phrase of contract.mustNotContain) {
    if (answerLower.includes(phrase)) {
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
