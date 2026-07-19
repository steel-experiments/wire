// ABOUTME: Conservative, deterministic structural autopsies for persisted campaign runs.
// ABOUTME: Loads an attempt's isolated Wire storage and persists only bounded, redacted evidence.

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";

import type { Artifact, JsonObject, JsonValue, Run, RunId, TraceEvent } from "../../src/shared/types.js";
import { stableJsonStringify } from "../../src/shared/ids.js";
import { isLikelyNavigationCode } from "../../src/browser/exec.js";
import {
  isErrorResult,
  isNavigationOnlyResult,
  isNotFoundObservation,
} from "../../src/agent/state-helpers.js";
import { listArtifacts } from "../../src/storage/artifacts.js";
import { atomicWriteJson } from "../../src/storage/atomic.js";
import { listTraceEvents } from "../../src/storage/events.js";
import { loadRun } from "../../src/storage/runs.js";
import {
  autopsySchema,
  type Autopsy,
  type StructuralSignatureKind,
} from "./model.js";

const TRACE_TAIL_LIMIT = 200;
const SIGNATURE_EVENT_LIMIT = 10;
const EVIDENCE_LIMIT = 20;
const ARTIFACT_LIMIT = 20;

const NAVIGATION_METHODS = new Set([
  "Page.navigate",
  "Page.reload",
  "Page.navigateToHistoryEntry",
]);

const EXTRACTION_CODE = /wire:extract|\bextractTable\s*\(|\b(?:innerText|textContent|innerHTML|outerHTML)\b/u;
const ANTI_BOT_TEXT = /\b(?:captcha|recaptcha|hcaptcha|verify(?:ing)? you are human|are you (?:a )?human|checking your browser|just a moment|attention required|unusual traffic|bot detection|access denied)\b/iu;
const AUTH_TITLE = /^(?:sign in|log in|login|sign up|authentication required)(?:\s*(?:[|\-\u2013\u2014:]\s*).*)?$/iu;

export interface AnalyzeAutopsyInput {
  campaignId: string;
  runId: RunId;
  attemptSlotId: string;
  arm: "base" | "candidate";
  run?: Run;
  events: readonly TraceEvent[];
  artifacts?: readonly Artifact[];
  /** Root used only to validate bounded local artifact-record pointers. */
  artifactRoot?: string;
  /** `null` means that the independent judge did not return a usable verdict. */
  judgeSuccess: boolean | null;
  traceAvailable?: boolean;
  generatedAt?: string;
}

export interface PersistRunAutopsyInput {
  campaignId: string;
  runId: RunId;
  attemptSlotId: string;
  arm: "base" | "candidate";
  /** The WIRE_ROOT assigned to this physical attempt, never a process-global default. */
  wireRoot: string;
  outputPath: string;
  judgeSuccess: boolean | null;
  generatedAt?: string;
}

interface DetectedSignature {
  kind: StructuralSignatureKind;
  explanation: string;
  evidenceEventIds: string[];
}

interface DetectionResult {
  signatures: DetectedSignature[];
  relevantEventIds: string[];
}

function uniqueBounded(values: readonly string[], limit: number): string[] {
  return [...new Set(values)].slice(0, limit);
}

const SAFE_ERROR_CODES = new Set([
  "EACCES",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENETWORK",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_CONNECTION_RESET",
  "ERR_NAME_NOT_RESOLVED",
  "ERR_NETWORK",
  "ERR_TIMED_OUT",
]);

function boundedErrorCode(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const code = value.trim();
  if (code.length > 40) return undefined;
  return SAFE_ERROR_CODES.has(code) || /^HTTP_[1-5][0-9]{2}$/u.test(code)
    ? code
    : undefined;
}

function boundedEvidenceUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
    // Userinfo, hostnames, ports, query, fragment, and path segments can all
    // contain tenant or task data. Keep only a stable host pseudonym and shape.
    const depth = parsed.pathname.split("/").filter(Boolean).length;
    const hostHash = createHash("sha256")
      .update(`wire-autopsy-host-v1\0${parsed.hostname.toLowerCase()}`)
      .digest("hex")
      .slice(0, 12);
    const originShape = `${parsed.protocol}//host-${hostHash}`;
    return depth === 0 ? originShape : `${originShape}/[${depth}-segment-path]`;
  } catch {
    return undefined;
  }
}

function asRecord(value: JsonValue | undefined): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function isSemanticallyEmpty(value: JsonValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim().length === 0;
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (Array.isArray(value)) return value.length === 0 || value.every(isSemanticallyEmpty);
  const values = Object.values(value);
  return values.length === 0 || values.every(isSemanticallyEmpty);
}

function isNavigationAck(event: TraceEvent): boolean {
  if (!isNavigationOnlyResult(event)) return false;
  const value = asRecord(event.payload.returnValue);
  if (!value) return false;
  return ["navigated", "navigatedTo", "url", "redirected", "loaded"]
    .some((key) => Object.hasOwn(value, key));
}

function isMeaningfulExtractionResult(event: TraceEvent): boolean {
  if (event.kind !== "code-result" || event.payload.ok !== true) return false;
  if (event.payload.source === "raw" || event.payload.source === "wireActions") return false;
  const stdout = event.payload.stdout;
  if (typeof stdout === "string" && stdout.trim().length > 0) return true;
  if (isNavigationOnlyResult(event) || isErrorResult(event)) return false;
  return !isSemanticallyEmpty(event.payload.returnValue);
}

function hasMeaningfulExtraction(events: readonly TraceEvent[]): boolean {
  return events.some(isMeaningfulExtractionResult);
}

function rawMethods(event: TraceEvent): string[] {
  const methods = event.payload.methods;
  if (!Array.isArray(methods)) return [];
  return methods.filter((method): method is string => typeof method === "string");
}

function isNavigationAction(event: TraceEvent): boolean {
  if (event.kind !== "code-exec") return false;
  const code = event.payload.code;
  if (typeof code === "string" && isLikelyNavigationCode(code)) return true;
  return rawMethods(event).some((method) => NAVIGATION_METHODS.has(method));
}

function nav404Evidence(events: readonly TraceEvent[]): string[] {
  const evidence: string[] = [];
  let pendingNavigationId: string | undefined;

  for (const event of events) {
    if (isNavigationAction(event) || isNavigationAck(event)) {
      pendingNavigationId = event.id;
      continue;
    }
    if (event.kind !== "observation") continue;
    if (pendingNavigationId && isNotFoundObservation(event)) {
      evidence.push(pendingNavigationId, event.id);
    }
    pendingNavigationId = undefined;
  }

  return uniqueBounded(evidence, SIGNATURE_EVENT_LIMIT);
}

function isExtractionAction(event: TraceEvent): boolean {
  return event.kind === "code-exec" &&
    typeof event.payload.code === "string" &&
    EXTRACTION_CODE.test(event.payload.code);
}

function followingCodeResult(events: readonly TraceEvent[], actionIndex: number): TraceEvent | undefined {
  for (let index = actionIndex + 1; index < events.length; index++) {
    const event = events[index];
    if (!event) continue;
    if (event.kind === "code-exec") return undefined;
    if (event.kind === "code-result") return event;
  }
  return undefined;
}

function emptyExtractionEvidence(events: readonly TraceEvent[]): string[] {
  const evidence: string[] = [];
  for (let index = 0; index < events.length; index++) {
    const action = events[index];
    if (!action || !isExtractionAction(action)) continue;
    const result = followingCodeResult(events, index);
    if (
      result?.payload.ok === true &&
      !(typeof result.payload.stdout === "string" && result.payload.stdout.trim().length > 0) &&
      isSemanticallyEmpty(result.payload.returnValue)
    ) {
      evidence.push(action.id, result.id);
    }
  }
  return uniqueBounded(evidence, SIGNATURE_EVENT_LIMIT);
}

function normalizedActionFingerprint(event: TraceEvent): string | undefined {
  if (event.kind !== "code-exec") return undefined;
  const code = event.payload.code;
  if (typeof code === "string" && code.trim().length > 0) {
    return `code:${code.trim().replace(/\s+/gu, " ")}`;
  }
  const methods = rawMethods(event);
  if (methods.length > 0) return `raw:${methods.join(",")}`;
  return undefined;
}

function observationFingerprint(event: TraceEvent): string {
  const summary = asRecord(event.payload.pageSummary);
  const pageShape: JsonObject = {};
  if (summary) {
    const headings = summary.headings;
    if (Array.isArray(headings)) {
      pageShape.headings = headings.filter((value): value is string => typeof value === "string");
    }
    for (const key of ["forms", "buttons", "dialogs", "tables", "links", "inputs"]) {
      const value = summary[key];
      if (typeof value === "number") pageShape[key] = value;
    }
  }
  return stableJsonStringify({
    url: typeof event.payload.url === "string" ? event.payload.url : "",
    title: typeof event.payload.title === "string" ? event.payload.title : "",
    pageShape,
  });
}

function resultFingerprint(event: TraceEvent): string {
  return stableJsonStringify({
    ok: event.payload.ok ?? null,
    stdout: event.payload.stdout ?? null,
    stderr: event.payload.stderr ?? null,
    returnValue: event.payload.returnValue ?? null,
  });
}

function repeatedActionEvidence(events: readonly TraceEvent[]): string[] {
  const actionIndexes = events.flatMap((event, index) =>
    normalizedActionFingerprint(event) === undefined ? [] : [index]
  );

  for (let start = 0; start < actionIndexes.length;) {
    const firstIndex = actionIndexes[start];
    if (firstIndex === undefined) break;
    const fingerprint = normalizedActionFingerprint(events[firstIndex]!);
    let end = start + 1;
    while (
      end < actionIndexes.length &&
      normalizedActionFingerprint(events[actionIndexes[end]!]!) === fingerprint
    ) {
      end++;
    }

    const runIndexes = actionIndexes.slice(start, end);
    if (runIndexes.length >= 3) {
      const boundary = actionIndexes[end] ?? events.length;
      const observations = events
        .slice(firstIndex, boundary)
        .filter((event) => event.kind === "observation");
      const observationShapes = new Set(observations.map(observationFingerprint));
      const results = runIndexes
        .map((index) => followingCodeResult(events, index))
        .filter((event): event is TraceEvent => event !== undefined);
      const allNoProgress = results.length === runIndexes.length &&
        results.every((event) => !isMeaningfulExtractionResult(event));
      const resultShapes = new Set(results.map(resultFingerprint));
      const unchangedResults = results.length === runIndexes.length && resultShapes.size === 1;

      if (observations.length >= 2 && observationShapes.size === 1 && (allNoProgress || unchangedResults)) {
        return uniqueBounded([
          ...runIndexes.map((index) => events[index]!.id),
          ...observations.map((event) => event.id),
        ], SIGNATURE_EVENT_LIMIT);
      }
    }
    start = end;
  }

  return [];
}

function pageSummaryText(event: TraceEvent): string {
  const summary = asRecord(event.payload.pageSummary);
  const headings = summary?.headings;
  return Array.isArray(headings)
    ? headings.filter((value): value is string => typeof value === "string").join(" ")
    : "";
}

function urlHasExplicitAuthPath(rawUrl: unknown): boolean {
  if (typeof rawUrl !== "string") return false;
  try {
    const path = new URL(rawUrl).pathname;
    return /(?:^|\/)(?:login|signin|sign-in|oauth|auth)(?:\/|$)/iu.test(path);
  } catch {
    return false;
  }
}

function observationHasExplicitAuthOrAntibot(event: TraceEvent): boolean {
  if (event.kind !== "observation") return false;
  const title = typeof event.payload.title === "string" ? event.payload.title.trim() : "";
  const text = `${title} ${pageSummaryText(event)}`;
  return ANTI_BOT_TEXT.test(text) || AUTH_TITLE.test(title) || urlHasExplicitAuthPath(event.payload.url);
}

function authOrAntibotEvidence(events: readonly TraceEvent[]): string[] {
  const latestObservation = [...events].reverse().find((event) => event.kind === "observation");
  if (!latestObservation || !observationHasExplicitAuthOrAntibot(latestObservation)) return [];
  const explicit = events.filter((event) =>
    event.kind === "thought-summary" && event.payload.kind === "auth-wall-detected"
  );
  explicit.push(latestObservation);
  return uniqueBounded(explicit.map((event) => event.id), SIGNATURE_EVENT_LIMIT);
}

function observationIsStructurallyEmpty(event: TraceEvent): boolean {
  if (event.kind !== "observation") return false;
  const url = typeof event.payload.url === "string" ? event.payload.url : "";
  const summary = asRecord(event.payload.pageSummary);
  if (!summary) return url === "about:blank" || url.startsWith("chrome-error://");
  const headings = summary.headings;
  if (Array.isArray(headings) && headings.some((value) => typeof value === "string" && value.trim().length > 0)) {
    return false;
  }
  return ["forms", "buttons", "dialogs", "tables", "links", "inputs"]
    .every((key) => typeof summary[key] !== "number" || summary[key] === 0);
}

function reconfiguredWithoutContentEvidence(events: readonly TraceEvent[]): string[] {
  let lastReconfigureIndex = -1;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (
      event?.kind === "thought-summary" &&
      event.payload.kind === "reconfigure" &&
      typeof event.payload.newSessionId === "string"
    ) {
      lastReconfigureIndex = index;
    }
  }
  if (lastReconfigureIndex < 0) return [];

  const after = events.slice(lastReconfigureIndex + 1);
  const observations = after.filter((event) => event.kind === "observation");
  if (
    observations.length === 0 ||
    observations.some((event) => !observationIsStructurallyEmpty(event)) ||
    hasMeaningfulExtraction(after)
  ) {
    return [];
  }

  return uniqueBounded([
    events[lastReconfigureIndex]!.id,
    ...observations.map((event) => event.id),
  ], SIGNATURE_EVENT_LIMIT);
}

function runtimeErrorEvidence(events: readonly TraceEvent[]): string[] {
  return uniqueBounded(events.filter((event) =>
    (event.kind === "error" &&
      (typeof event.payload.message === "string" || typeof event.payload.code === "string")) ||
    (event.kind === "code-result" && event.payload.ok === false)
  ).map((event) => event.id), SIGNATURE_EVENT_LIMIT);
}

function detectSignatures(
  events: readonly TraceEvent[],
  run: Run | undefined,
  judgeSuccess: boolean | null,
  traceAvailable: boolean,
): DetectionResult {
  const signatures: DetectedSignature[] = [];
  const relevantEventIds: string[] = [];
  const add = (kind: StructuralSignatureKind, explanation: string, eventIds: readonly string[]): void => {
    const evidenceEventIds = uniqueBounded(eventIds, SIGNATURE_EVENT_LIMIT);
    signatures.push({ kind, explanation, evidenceEventIds });
    relevantEventIds.push(...evidenceEventIds);
  };

  if (!traceAvailable || events.length === 0) {
    add("trace-unavailable", "Persisted trace events were unavailable; no trace-based inference was made.", []);
  } else {
    const notFound = nav404Evidence(events);
    if (notFound.length > 0) {
      add("nav-404", "A post-navigation observation has an explicit not-found or sparse 404 page shape.", notFound);
    }

    const navigationOnly = events.filter(isNavigationAck).map((event) => event.id);
    if (navigationOnly.length >= 2 && !hasMeaningfulExtraction(events)) {
      add(
        "navigation-only-stall",
        "At least two successful results contain only navigation acknowledgements, with no meaningful extraction in the analyzed trace tail.",
        navigationOnly,
      );
    }

    const emptyExtraction = emptyExtractionEvidence(events);
    if (emptyExtraction.length > 0) {
      add("empty-extraction", "An explicitly identifiable extraction action returned a semantically empty value.", emptyExtraction);
    }

    const repeatedAction = repeatedActionEvidence(events);
    if (repeatedAction.length > 0) {
      add("repeated-action-stall", "The same normalized action appears at least three times while observations stay unchanged and results are unchanged or contain no meaningful extraction.", repeatedAction);
    }

    const authOrAntibot = authOrAntibotEvidence(events);
    if (authOrAntibot.length > 0) {
      add("auth-or-antibot", "The persisted trace records an explicit authentication or anti-bot surface.", authOrAntibot);
    }

    const reconfigured = reconfiguredWithoutContentEvidence(events);
    if (reconfigured.length > 0) {
      add("reconfigured-without-content", "A recorded session reconfiguration is followed only by structurally empty observations and no meaningful extraction.", reconfigured);
    }

    const runtimeErrors = runtimeErrorEvidence(events);
    if (runtimeErrors.length > 0) {
      add("runtime-or-network-error", "The persisted trace contains explicit runtime or network error evidence.", runtimeErrors);
    }
  }

  if (run?.status === "succeeded" && judgeSuccess === false) {
    const completionEvidence = run.resultProvenance?.sourceEventId;
    add(
      "judge-rejected",
      "The independent judge marked a run persisted as succeeded as unsuccessful.",
      completionEvidence ? [completionEvidence] : [],
    );
  }

  return { signatures, relevantEventIds: uniqueBounded(relevantEventIds, EVIDENCE_LIMIT) };
}

function eventEvidence(event: TraceEvent): Autopsy["evidence"][number] {
  const evidence: Autopsy["evidence"][number] = { eventId: event.id };
  if (event.kind === "observation") {
    const url = boundedEvidenceUrl(event.payload.url);
    // Page titles routinely contain account names, email addresses, task data,
    // or document contents. Persist only a fixed structural classification.
    const title = isNotFoundObservation(event)
      ? "not-found page"
      : observationHasExplicitAuthOrAntibot(event)
        ? "authentication or anti-bot page"
        : observationIsStructurallyEmpty(event)
          ? "structurally empty page"
          : undefined;
    if (url !== undefined) evidence.url = url;
    if (title !== undefined) evidence.title = title;
  }

  let action: string | undefined;
  if (event.kind === "code-exec") {
    const methods = rawMethods(event);
    if (isNavigationAction(event)) action = "navigation action";
    else if (isExtractionAction(event)) action = "extraction action";
    else if (methods.length > 0) action = `raw browser action batch (${Math.min(methods.length, 99)} methods)`;
    else if (Array.isArray(event.payload.summaries)) {
      action = `browser action batch (${event.payload.summaries.length} actions)`;
    } else action = "code execution";
  } else if (event.kind === "error") {
    const code = boundedErrorCode(event.payload.code);
    action = code === undefined ? "runtime error" : `runtime error: ${code}`;
  } else if (event.kind === "thought-summary") {
    action = event.payload.kind === "auth-wall-detected"
      ? "authentication wall detected"
      : event.payload.kind === "reconfigure"
        ? "session reconfiguration"
        : "agent decision summary";
  } else if (event.kind === "code-result") {
    if (event.payload.ok === false) {
      action = "code execution failed";
    } else if (isNavigationAck(event)) {
      action = "navigation-only result";
    } else if (isSemanticallyEmpty(event.payload.returnValue)) {
      action = "semantically empty result";
    }
  }
  if (action !== undefined) evidence.action = action;
  return evidence;
}

function isPathInside(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child !== ""
    && child !== ".."
    && !child.startsWith("../")
    && !child.startsWith("..\\")
    && !isAbsolute(child);
}

function boundedArtifacts(
  artifacts: readonly Artifact[],
  artifactRoot: string | undefined,
): Pick<Autopsy, "artifactIds" | "artifacts"> {
  const ordered = [...artifacts].sort((left, right) => left.id.localeCompare(right.id));
  const artifactIds = uniqueBounded(ordered.map((artifact) => artifact.id), ARTIFACT_LIMIT);
  const refs = ordered
    .filter((artifact) => artifactRoot !== undefined && isPathInside(artifactRoot, artifact.path))
    .slice(0, ARTIFACT_LIMIT)
    .map((artifact) => ({
      id: artifact.id,
      // Point to the bounded metadata record, not a user-named artifact file.
      path: `artifacts/${artifact.id}.json`.slice(0, 500),
    }));
  return { artifactIds, artifacts: refs };
}

/** Pure trace analysis entry point for deterministic fixtures and callers. */
export function analyzeAutopsy(input: AnalyzeAutopsyInput): Autopsy {
  const events = input.events.slice(-TRACE_TAIL_LIMIT);
  const traceAvailable = input.traceAvailable !== false && events.length > 0;
  const detected = detectSignatures(events, input.run, input.judgeSuccess, traceAvailable);
  const relevant = new Set(detected.relevantEventIds);
  const evidence = events
    .filter((event) => relevant.has(event.id))
    .slice(0, EVIDENCE_LIMIT)
    .map(eventEvidence);
  const artifactEvidence = boundedArtifacts(input.artifacts ?? [], input.artifactRoot);

  return autopsySchema.parse({
    version: 1,
    campaignId: input.campaignId,
    runId: input.runId,
    attemptSlotId: input.attemptSlotId,
    arm: input.arm,
    signatures: detected.signatures,
    evidence,
    ...artifactEvidence,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
  });
}

/** Pure signature-only helper for small fixture assertions. */
export function analyzeStructuralSignatures(
  events: readonly TraceEvent[],
  options: { run?: Run; judgeSuccess?: boolean | null; traceAvailable?: boolean } = {},
): DetectedSignature[] {
  const tail = events.slice(-TRACE_TAIL_LIMIT);
  return detectSignatures(
    tail,
    options.run,
    options.judgeSuccess ?? null,
    options.traceAvailable !== false && tail.length > 0,
  ).signatures;
}

/**
 * Load one physical attempt's isolated storage and atomically persist its autopsy.
 * Missing/corrupt run or event storage yields `trace-unavailable`; artifact read
 * failure only omits artifact references and does not fabricate trace evidence.
 */
export async function persistRunAutopsy(input: PersistRunAutopsyInput): Promise<Autopsy> {
  if (!isAbsolute(input.wireRoot)) {
    throw new Error("wireRoot must be the absolute WIRE_ROOT for the physical attempt");
  }
  if (!isAbsolute(input.outputPath)) {
    throw new Error("outputPath must be absolute");
  }

  let run: Run | undefined;
  let events: TraceEvent[] = [];
  let artifacts: Artifact[] = [];
  let traceAvailable = true;

  try {
    run = await loadRun(input.wireRoot, input.runId);
  } catch {
    traceAvailable = false;
  }
  try {
    events = await listTraceEvents(input.wireRoot, input.runId);
    if (events.length === 0) traceAvailable = false;
  } catch {
    traceAvailable = false;
  }
  try {
    artifacts = await listArtifacts(input.wireRoot, input.runId);
  } catch {
    artifacts = [];
  }

  const autopsy = analyzeAutopsy({
    campaignId: input.campaignId,
    runId: input.runId,
    attemptSlotId: input.attemptSlotId,
    arm: input.arm,
    ...(run ? { run } : {}),
    events,
    artifacts,
    artifactRoot: input.wireRoot,
    judgeSuccess: input.judgeSuccess,
    traceAvailable,
    ...(input.generatedAt ? { generatedAt: input.generatedAt } : {}),
  });
  await atomicWriteJson(input.outputPath, autopsy);
  return autopsy;
}
