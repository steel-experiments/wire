import { redactSecrets } from "./redact.js";
import { stripInjectionPatterns } from "./sanitize.js";
import type { BrowserLinkSample } from "./types.js";

export const BROWSER_LINK_SAMPLE_LIMITS = {
  maxItems: 30,
  maxCandidates: 300,
  maxLabelChars: 120,
  maxHrefChars: 500,
  maxTotalChars: 4000,
} as const;

const REDACTED_MARKER = "[REDACTED]";

function normalizeText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function safeHttpHref(value: string): string | undefined {
  const raw = value.trim();
  if (!raw || raw.length > BROWSER_LINK_SAMPLE_LIMITS.maxHrefChars) return undefined;
  if (raw.includes(REDACTED_MARKER)) return undefined;
  if (stripInjectionPatterns(redactSecrets(raw)) !== raw) return undefined;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    const href = url.href;
    if (href.length > BROWSER_LINK_SAMPLE_LIMITS.maxHrefChars) return undefined;
    if (href.includes(REDACTED_MARKER)) return undefined;
    if (stripInjectionPatterns(redactSecrets(href)) !== href) return undefined;
    return href;
  } catch {
    return undefined;
  }
}

/**
 * Normalize untrusted provider link samples before they enter agent context.
 * Secret-bearing or already-redacted hrefs are dropped instead of exposing a
 * broken navigation target.
 */
export function normalizeBrowserLinkSamples(value: unknown): BrowserLinkSample[] {
  if (!Array.isArray(value)) return [];

  const samples: BrowserLinkSample[] = [];
  const seenHrefs = new Set<string>();
  let totalChars = 0;

  for (let index = 0; index < value.length && index < BROWSER_LINK_SAMPLE_LIMITS.maxCandidates; index++) {
    const item = value[index];
    if (samples.length >= BROWSER_LINK_SAMPLE_LIMITS.maxItems) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const candidate = item as Record<string, unknown>;
    if (typeof candidate.label !== "string" || typeof candidate.href !== "string") continue;

    const label = normalizeText(candidate.label)
      .slice(0, BROWSER_LINK_SAMPLE_LIMITS.maxLabelChars)
      .trimEnd();
    const href = safeHttpHref(candidate.href);
    if (!label || !href || seenHrefs.has(href)) continue;

    const itemChars = label.length + href.length;
    if (totalChars + itemChars > BROWSER_LINK_SAMPLE_LIMITS.maxTotalChars) continue;
    seenHrefs.add(href);
    samples.push({ label, href });
    totalChars += itemChars;
  }

  return samples;
}
