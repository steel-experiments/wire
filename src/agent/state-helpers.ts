import type { ArtifactId, ArtifactKind, JsonObject, JsonValue, ProposedAction, TraceEvent } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { isLikelyNavigationCode } from "../browser/exec.js";
import type { LoopState } from "./loop.js";

function latestEventByKind(state: LoopState, kind: TraceEvent["kind"]): TraceEvent | undefined {
  return [...state.events].reverse().find((event) => event.kind === kind);
}

export function latestObservation(state: LoopState): TraceEvent | undefined {
  return latestEventByKind(state, "observation");
}

export function latestError(state: LoopState): TraceEvent | undefined {
  return latestEventByKind(state, "error");
}

export function latestCodeResult(state: LoopState): TraceEvent | undefined {
  return latestEventByKind(state, "code-result");
}

export function hasRecordedTaskArtifact(state: LoopState): boolean {
  return state.events.some((event) =>
    event.kind === "artifact" &&
    typeof event.payload.kind === "string" &&
    typeof event.payload.content === "string" &&
    event.payload.content.trim().length > 0
  );
}

export function hasExtractedTaskResult(state: LoopState): boolean {
  const result = latestCodeResult(state);
  if (!result || result.payload.ok !== true) {
    return false;
  }

  // Navigation-only results (e.g. {navigatedTo}, {navigated}) don't count
  if (isNavigationOnlyResult(result)) {
    return false;
  }

  // Error results (e.g. {"error":"profile link not found"}) don't count
  if (isErrorResult(result)) {
    return false;
  }

  return (
    (typeof result.payload.stdout === "string" && result.payload.stdout.trim().length > 0) ||
    result.payload.returnValue !== undefined
  );
}

/** Detect code-results that only confirm navigation without extracting meaningful content. */
export function isNavigationOnlyResult(event: TraceEvent): boolean {
  const rv = event.payload.returnValue;
  if (rv === undefined || rv === null || typeof rv === "string") return false;
  if (typeof rv !== "object") return false;
  const keys = Object.keys(rv as Record<string, unknown>);
  if (keys.length === 0) return false;
  const navKeys = new Set(["navigated", "navigatedTo", "url", "redirected", "loaded", "clicked"]);
  return keys.every((k) => navKeys.has(k));
}

/**
 * "No-progress" results: the exec succeeded but produced nothing the agent
 * can build on — empty returnValue, nav-only, or error-shaped. Used by the
 * cross-signature stall guard to catch agents wandering across distinct URLs
 * that all dead-end (e.g. grants.gov 404 walking).
 */
export function isNoProgressResult(event: TraceEvent): boolean {
  if (event.kind !== "code-result") return false;
  if (event.payload.ok !== true) return false;
  const stdout = event.payload.stdout;
  const hasStdout = typeof stdout === "string" && stdout.trim().length > 0;
  const rv = event.payload.returnValue;
  if (hasStdout) return false;
  if (rv === undefined || rv === null) return true;
  if (typeof rv === "string") return rv.trim().length === 0;
  if (Array.isArray(rv)) return rv.length === 0;
  if (typeof rv === "object") {
    if (Object.keys(rv as Record<string, unknown>).length === 0) return true;
    if (isNavigationOnlyResult(event)) return true;
    if (isErrorResult(event)) return true;
  }
  return false;
}

/** Detect code-results that only report an error (e.g. {"error":"not found"}). */
export function isErrorResult(event: TraceEvent): boolean {
  const rv = event.payload.returnValue;
  if (rv === undefined || rv === null || typeof rv === "string") return false;
  if (typeof rv !== "object") return false;
  const obj = rv as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  // Only has "error" key, or "error" plus navigation/meta keys
  if (!("error" in obj)) return false;
  const nonMetaKeys = keys.filter((k) => k !== "error" && k !== "hrefs" && k !== "links" && k !== "anchors" && k !== "sample");
  return nonMetaKeys.length === 0;
}

/** True when a post-navigation extraction step has occurred (code-exec after navigation that produced real output).
 *  Returns true if no navigation happened (nothing to guard against). */
export function hasPostNavigationExtraction(state: LoopState): boolean {
  const events = state.events;
  let sawNavigation = false;
  for (const e of events) {
    if (e.kind === "code-exec" && typeof e.payload.code === "string" && isLikelyNavigationCode(e.payload.code)) {
      sawNavigation = true;
      continue;
    }
    if (sawNavigation && e.kind === "code-result" && e.payload.ok === true) {
      // If this result has meaningful content beyond navigation confirmation, extraction happened
      if (!isNavigationOnlyResult(e) && (e.payload.returnValue !== undefined || (typeof e.payload.stdout === "string" && e.payload.stdout.trim().length > 0))) {
        return true;
      }
    }
  }
  // No navigation happened — nothing to guard against
  return !sawNavigation;
}

export function hasAttemptedExtraction(state: LoopState): boolean {
  return state.events.some((event) =>
    event.kind === "code-exec" &&
    typeof event.payload.code === "string" &&
    event.payload.code.includes("wire:extract")
  );
}

export function hasMeaningfulProgress(state: LoopState): boolean {
  const observations = state.events.filter((event) => event.kind === "observation");
  const codeExecs = state.events.filter((event) => event.kind === "code-exec");
  return observations.length > 1 || codeExecs.length > 0;
}

export function buildFailureSummary(state: LoopState): string | undefined {
  if (!hasMeaningfulProgress(state)) {
    return undefined;
  }

  const observation = latestObservation(state);
  const error = latestError(state);
  const parts: string[] = [];

  if (observation) {
    const title = typeof observation.payload.title === "string" ? observation.payload.title : undefined;
    const url = typeof observation.payload.url === "string" ? observation.payload.url : undefined;
    if (title && url) {
      parts.push(`Reached ${title} at ${url}`);
    } else if (url) {
      parts.push(`Reached ${url}`);
    }
  }

  if (error && typeof error.payload.message === "string") {
    parts.push(`Run stopped with error: ${error.payload.message}`);
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

export function isRecoverableStepError(message: string): boolean {
  return /Target not found|timeout|network|ECONN|ETIMEDOUT|ENOTFOUND|fetch|Execution context was destroyed|Cannot find context|wasn't found|Not supported|CDP error|Session closed|WebSocket error/iu
    .test(message);
}

// Observation diffing — detect stalled progress

export interface ObservationDiff {
  urlChanged: boolean;
  titleChanged: boolean;
  contentChanged: boolean;
  unchanged: boolean;
  summary: string;
}

export function computeObservationDiff(
  oldObs: TraceEvent | undefined,
  newObs: TraceEvent,
): ObservationDiff {
  if (!oldObs) {
    return { urlChanged: false, titleChanged: false, contentChanged: false, unchanged: false, summary: "First observation" };
  }

  const urlChanged = String(oldObs.payload.url ?? "") !== String(newObs.payload.url ?? "");
  const titleChanged = String(oldObs.payload.title ?? "") !== String(newObs.payload.title ?? "");

  const oldHeadings = ((oldObs.payload.pageSummary as Record<string, unknown>)?.headings) as string[] | undefined;
  const newHeadings = ((newObs.payload.pageSummary as Record<string, unknown>)?.headings) as string[] | undefined;
  const contentChanged = (oldHeadings?.join("") ?? "") !== (newHeadings?.join("") ?? "");

  const unchanged = !urlChanged && !titleChanged && !contentChanged;

  const parts: string[] = [];
  if (urlChanged) parts.push(`URL changed to ${newObs.payload.url}`);
  if (titleChanged) parts.push(`Title changed to ${newObs.payload.title}`);
  if (contentChanged) parts.push(`Page headings changed`);

  const summary = parts.length > 0 ? parts.join("; ") : "Page unchanged";

  return { urlChanged, titleChanged, contentChanged, unchanged, summary };
}

export function countConsecutiveUnchanged(events: TraceEvent[]): number {
  const observations = events.filter((e) => e.kind === "observation");
  if (observations.length < 2) return 0;

  let count = 0;
  for (let i = observations.length - 1; i >= 1; i--) {
    const prev = observations[i - 1]!;
    const curr = observations[i]!;
    const diff = computeObservationDiff(prev, curr);
    if (diff.unchanged) {
      count++;
    } else {
      break;
    }
  }
  return count;
}

// Reconfigure gate — page-state evidence for an anti-bot session swap.

/** Text markers of a real anti-bot / block / challenge page, matched against
 *  the page title and headings. */
const RECONFIGURE_BLOCK_SIGNAL =
  /captcha|are you (?:a )?human|verif(?:y|ying) you|access denied|forbidden|rate.?limit|request rate|unusual traffic|bot detection|cloudflare|just a moment|attention required|checking your browser/iu;

function reconfigureSummary(payload: JsonObject): { headings: string[]; hasContent: boolean } {
  const summary = payload.pageSummary;
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    return { headings: [], hasContent: false };
  }
  const record = summary as Record<string, unknown>;
  const headings = Array.isArray(record.headings)
    ? record.headings.filter((h): h is string => typeof h === "string")
    : [];
  let hasContent = headings.length > 0;
  if (!hasContent) {
    for (const key of ["forms", "buttons", "dialogs", "tables", "links", "inputs"]) {
      if (typeof record[key] === "number" && (record[key] as number) > 0) {
        hasContent = true;
        break;
      }
    }
  }
  return { headings, hasContent };
}

/**
 * Whether a session reconfigure (enabling a proxy/captcha solver by spinning a
 * new browser session) is justified by the current page. A reconfigure should
 * fire only when there is real block evidence on a page we actually navigated
 * to:
 *  - the initial pre-navigation `about:blank` (and other non-http(s)/internal
 *    URLs) is NOT a block — treating it as one fired spurious proxy swaps that
 *    broke otherwise-fine runs;
 *  - a page that already rendered real content with no anti-bot signal is
 *    working — a proxy swap would needlessly discard it (the SEC EDGAR
 *    self-block);
 *  - a genuine challenge page (captcha / "verify you are human" / rate limit),
 *    or a navigated page that rendered nothing, IS a plausible block.
 */
export function reconfigureJustified(observation: TraceEvent | undefined): boolean {
  if (!observation) return false;
  const url = typeof observation.payload.url === "string" ? observation.payload.url : "";
  if (!/^https?:\/\//iu.test(url)) return false;

  const { headings, hasContent } = reconfigureSummary(observation.payload);
  const title = typeof observation.payload.title === "string" ? observation.payload.title : "";
  if (RECONFIGURE_BLOCK_SIGNAL.test([title, ...headings].join(" "))) return true;

  return !hasContent;
}

interface ArtifactEnvelope {
  filename?: string;
  kind?: string;
  mimeType?: string;
  content: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function artifactEnvelopesFromValue(value: unknown): ArtifactEnvelope[] {
  if (!isObject(value)) {
    return [];
  }

  const candidates = Array.isArray(value.artifacts)
    ? value.artifacts
    : value.artifact !== undefined
      ? [value.artifact]
      : [];

  return candidates.flatMap((candidate) => {
    if (!isObject(candidate) || typeof candidate.content !== "string" || candidate.content.length === 0) {
      return [];
    }

    const envelope: ArtifactEnvelope = { content: candidate.content };
    if (typeof candidate.filename === "string") {
      envelope.filename = candidate.filename;
    }
    if (typeof candidate.kind === "string") {
      envelope.kind = candidate.kind;
    }
    if (typeof candidate.mimeType === "string") {
      envelope.mimeType = candidate.mimeType;
    }
    return [envelope];
  });
}

function sanitizeArtifactFilename(filename: string | undefined, fallback: string): string {
  const base = (filename ?? fallback).split(/[\\/]/u).pop()?.trim() ?? "";
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[^A-Za-z0-9._ -]/gu, "_")
    .replace(/\s+/gu, " ")
    .slice(0, 120)
    .trim();
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : fallback;
}

function appendArtifactEnvelope(state: LoopState, envelope: ArtifactEnvelope): void {
  const artifactId = createId("artifact") as ArtifactId;
  const filename = sanitizeArtifactFilename(envelope.filename, "artifact.txt");

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      filename,
      kind: (envelope.kind ?? "download") as ArtifactKind,
      mimeType: envelope.mimeType ?? "text/plain",
      path: `artifacts/${artifactId}-${filename}`,
      content: envelope.content,
    },
  });
}

function appendExtractedJsonArtifact(state: LoopState, value: JsonValue): void {
  const artifactId = createId("artifact") as ArtifactId;

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      kind: "json-output",
      mimeType: "application/json",
      path: `artifacts/${artifactId}-output.json`,
      content: JSON.stringify(value, null, 2),
    },
  });
}

function appendExtractedNoteArtifact(state: LoopState, content: string): void {
  const artifactId = createId("artifact") as ArtifactId;

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      kind: "note",
      mimeType: "text/plain",
      path: `artifacts/${artifactId}.txt`,
      content,
    },
  });
}

export function appendExtractedResultArtifact(state: LoopState): void {
  const result = latestCodeResult(state);
  if (!result || result.payload.ok !== true) {
    return;
  }

  if (result.payload.returnValue !== undefined) {
    const envelopes = artifactEnvelopesFromValue(result.payload.returnValue);
    if (envelopes.length > 0) {
      envelopes.forEach((envelope) => appendArtifactEnvelope(state, envelope));
      return;
    }

    appendExtractedJsonArtifact(state, result.payload.returnValue);
    return;
  }

  if (typeof result.payload.stdout === "string" && result.payload.stdout.trim().length > 0) {
    const stdout = result.payload.stdout.trim();
    try {
      const parsed = JSON.parse(stdout) as unknown;
      const envelopes = artifactEnvelopesFromValue(parsed);
      if (envelopes.length > 0) {
        envelopes.forEach((envelope) => appendArtifactEnvelope(state, envelope));
        return;
      }

      if (parsed !== null && typeof parsed === "object") {
        appendExtractedJsonArtifact(state, parsed as JsonValue);
      } else {
        appendExtractedNoteArtifact(state, stdout);
      }
    } catch {
      appendExtractedNoteArtifact(state, stdout);
    }
  }
}

export function appendTaskNoteArtifact(state: LoopState, summary: string): void {
  const artifactId = createId("artifact") as ArtifactId;
  const observation = latestObservation(state);
  const lines = [summary.trim()];

  if (observation) {
    const title = typeof observation.payload.title === "string" ? observation.payload.title : undefined;
    const url = typeof observation.payload.url === "string" ? observation.payload.url : undefined;
    if (title) {
      lines.push(`Title: ${title}`);
    }
    if (url) {
      lines.push(`URL: ${url}`);
    }
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      kind: "note",
      source: "task-summary",
      mimeType: "text/plain",
      path: `artifacts/${artifactId}.txt`,
      content: lines.join("\n"),
    },
  });
}

/**
 * Stable digest of a code-result event payload — used alongside the action
 * signature to detect "same code, same result, no progress" loops where the
 * agent is technically succeeding but learning nothing new.
 */
export function codeResultDigest(event: TraceEvent | undefined): string | undefined {
  if (!event || event.kind !== "code-result") return undefined;
  const ok = event.payload["ok"];
  const stdout = event.payload["stdout"];
  const stderr = event.payload["stderr"];
  const returnValue = event.payload["returnValue"];
  const parts: string[] = [`ok:${String(ok)}`];
  if (typeof stdout === "string") parts.push(`o:${stdout.replace(/\s+/gu, " ").slice(0, 80)}`);
  if (typeof stderr === "string") parts.push(`e:${stderr.replace(/\s+/gu, " ").slice(0, 80)}`);
  if (returnValue !== undefined) {
    let serialized: string;
    try {
      serialized = JSON.stringify(returnValue);
    } catch {
      serialized = String(returnValue);
    }
    parts.push(`r:${serialized.slice(0, 120)}`);
  }
  return parts.join("|");
}

/**
 * The "shape" of a code-result: the sorted set of top-level keys of its
 * returnValue, independent of the values. A stable shape whose values keep
 * changing is the signature of a progressing probe (e.g. polling live task
 * state) — real work, not a stuck loop. A shape that keeps morphing is the
 * signature of flailing. The sig-only loop backstop uses this to tell the two
 * apart. Returns undefined for non-object return values (scalars/arrays), where
 * shape can't be assessed.
 */
export function codeResultShape(event: TraceEvent | undefined): string | undefined {
  if (!event || event.kind !== "code-result") return undefined;
  const rv = event.payload["returnValue"];
  if (rv === undefined || rv === null || typeof rv !== "object" || Array.isArray(rv)) {
    return undefined;
  }
  return Object.keys(rv as Record<string, unknown>).sort().join(",");
}

/**
 * Stable signature for a proposed exec/raw action — used to detect when the
 * agent is re-issuing the same broken code. Matches the renderer's repeat
 * marker so what the user sees on screen and what the loop bails out on are
 * the same thing.
 */
export function execActionSignature(action: ProposedAction): string | undefined {
  if (action.kind === "exec") {
    const code = action.payload?.["code"];
    if (typeof code === "string") {
      return code.replace(/\s+/gu, " ").trim().slice(0, 80);
    }
    return undefined;
  }
  if (action.kind === "raw") {
    const method = action.payload?.["method"];
    if (typeof method === "string") return `raw:${method}`;
  }
  return undefined;
}

/** Trailing streak of consecutive successful no-progress code-results (empty/nav-only/error-shaped). Pairs with computeRepeatStreak to feed all stuck-loop signals back to the LLM. */
export function computeNoProgressStreak(events: TraceEvent[]): number {
  let streak = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!;
    if (e.kind !== "code-result") continue;
    if (e.payload.ok !== true) break;
    if (!isNoProgressResult(e)) break;
    streak += 1;
  }
  return streak;
}

/** Trailing streak of identical exec sig + result digest — fed to the LLM so it can change strategy before the loop guard bails. */
export function computeRepeatStreak(events: TraceEvent[]): { sameSig: number; sameResult: number } {
  const pairs: Array<[string, string | undefined]> = [];
  for (let i = 0; i < events.length; i++) {
    const e = events[i]!;
    if (e.kind !== "code-exec" || typeof e.payload["code"] !== "string") continue;
    const sig = (e.payload["code"] as string).replace(/\s+/gu, " ").trim().slice(0, 80);
    let result: TraceEvent | undefined;
    for (let j = i + 1; j < events.length && events[j]!.kind !== "code-exec"; j++) {
      if (events[j]!.kind === "code-result") { result = events[j]; break; }
    }
    pairs.push([sig, codeResultDigest(result)]);
  }
  if (pairs.length === 0) return { sameSig: 0, sameResult: 0 };
  const [lastSig, lastDigest] = pairs[pairs.length - 1]!;
  let sameSig = 1, sameResult = lastDigest !== undefined ? 1 : 0, broken = lastDigest === undefined;
  for (let i = pairs.length - 2; i >= 0 && pairs[i]![0] === lastSig; i--) {
    sameSig++;
    if (!broken && pairs[i]![1] !== undefined && pairs[i]![1] === lastDigest) sameResult++;
    else broken = true;
  }
  return { sameSig, sameResult };
}

/** Marker embedded in Wire's injected generic page-state capture so the loop
 *  can tell that capture apart from a task-specific extraction. */
export const VERIFICATION_PROBE_MARKER = "wire:verify";

export function buildVerificationAction(): ProposedAction {
  return {
    kind: "exec",
    summary: "Verify current task result",
    payload: {
      code: `/* wire:extract ${VERIFICATION_PROBE_MARKER} */ return { ok: true, evidence: { title: document.title, url: location.href, text: document.body?.innerText?.slice(0, 5000) ?? '' }, reason: 'Captured current page state for task verification' }`,
    } satisfies JsonObject,
  };
}

/**
 * True when the agent's most recent code action was Wire's injected generic
 * page-state capture (buildVerificationAction) rather than a task-specific
 * extraction. Used to keep that raw page dump from standing in as the final
 * deliverable — the artifact reviewer rightly rejects a generic dump.
 */
export function latestExtractionIsVerificationProbe(state: LoopState): boolean {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const event = state.events[i]!;
    if (event.kind !== "code-exec") continue;
    return typeof event.payload.code === "string" && event.payload.code.includes(VERIFICATION_PROBE_MARKER);
  }
  return false;
}
