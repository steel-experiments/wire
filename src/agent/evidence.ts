import type { TraceEvent } from "../shared/types.js";
import { redactSecrets } from "../shared/redact.js";
import { stripInjectionPatterns } from "./context.js";

const EVIDENCE_HEAD_BYTES = 8000;
const EVIDENCE_MAX_URLS = 5;
const EVIDENCE_MIN_BYTES = 40;

function evidenceHead(text: string): string {
  return text.length <= EVIDENCE_HEAD_BYTES ? text : text.slice(0, EVIDENCE_HEAD_BYTES);
}

const NAV_ACK_KEYS = new Set([
  "navigated", "clicked", "ok", "saved", "finalUrl", "url", "redirected", "status",
]);

function isNavigationAck(returnValue: unknown): boolean {
  if (!returnValue || typeof returnValue !== "object" || Array.isArray(returnValue)) return false;
  const keys = Object.keys(returnValue as Record<string, unknown>);
  if (keys.length === 0 || keys.length > NAV_ACK_KEYS.size) return false;
  return keys.every((k) => NAV_ACK_KEYS.has(k));
}

function codeResultContent(payload: TraceEvent["payload"]): string {
  const rv = payload.returnValue;
  const stdout = typeof payload.stdout === "string" ? payload.stdout : "";
  if (rv !== undefined && rv !== null) {
    if (typeof rv === "string") return rv;
    try {
      const serialized = JSON.stringify(rv);
      if (typeof serialized === "string") return serialized;
    } catch {
      // fall through to stdout
    }
  }
  return stdout;
}

function urlForCodeResult(events: TraceEvent[], execIdx: number, preExecUrl: string): string {
  for (let i = execIdx + 1; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind === "observation") {
      const url = typeof event.payload.url === "string" ? event.payload.url : undefined;
      return url || preExecUrl;
    }
    if (event.kind === "code-result") break;
  }
  return preExecUrl;
}

export function latestExtractionsPerUrl(events: TraceEvent[]): Array<{ url: string; content: string }> {
  let currentUrl: string | undefined;
  const latest = new Map<string, string>();
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.kind === "observation") {
      const url = typeof event.payload.url === "string" ? event.payload.url : undefined;
      if (url) currentUrl = url;
      continue;
    }
    if (event.kind !== "code-result") continue;
    if (event.payload.ok !== true) continue;
    if (!currentUrl) continue;
    if (isNavigationAck(event.payload.returnValue)) continue;
    const content = codeResultContent(event.payload);
    if (content.trim().length < EVIDENCE_MIN_BYTES) continue;
    const url = urlForCodeResult(events, i, currentUrl);
    latest.delete(url);
    latest.set(url, content);
  }
  const entries = [...latest.entries()].map(([url, content]) => ({
    url,
    content: evidenceHead(stripInjectionPatterns(redactSecrets(content))),
  }));
  return entries.slice(-EVIDENCE_MAX_URLS);
}
