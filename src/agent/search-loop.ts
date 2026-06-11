// ABOUTME: Pattern-level detection of semantic search loops — different actions
// ABOUTME: cycling search→dump→re-search that the action-signature guards can't see.

import type { TraceEvent } from "../shared/types.js";
import { looksLikeUnextractedPage } from "./classify.js";
import { isNavigationOnlyResult } from "./state-helpers.js";

// Search-engine hosts plus the generic query-parameter shape. No spam-domain
// denylist (it would rot); a search navigation is recognized by where it goes
// or by carrying a literal query.
const SEARCH_HOST_PATTERN = /(^|\.)(duckduckgo\.com|bing\.com|google\.[a-z.]+|startpage\.com|ecosia\.org|search\.brave\.com)$/iu;
const QUERY_PARAM_PATTERN = /[?&](q|query|search_query)=/iu;
// An encoded quote in a URL is a literal phrase query regardless of where it
// rides — SEO-spam solvers embed it in the path (observed live:
// /crossword-solver/5K-race-%22bubble-gum%22-... with no q= parameter).
const ENCODED_PHRASE_PATTERN = /%22/u;

export function isSearchNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (SEARCH_HOST_PATTERN.test(parsed.hostname)) return true;
  } catch {
    return false;
  }
  return QUERY_PARAM_PATTERN.test(url) || ENCODED_PHRASE_PATTERN.test(url);
}

function resultText(event: TraceEvent): string | undefined {
  const stdout = event.payload.stdout;
  if (typeof stdout === "string" && stdout.trim().length > 0) return stdout;
  const returnValue = event.payload.returnValue;
  if (returnValue === undefined) return undefined;
  return typeof returnValue === "string" ? returnValue : JSON.stringify(returnValue);
}

/**
 * Count search navigations since the last meaningful extraction. The
 * action-level stuck-guards key on repeated code or results; a semantic
 * search loop repeats a *pattern* (new query, new URL, new dump every turn)
 * and stays invisible to them. A "meaningful extraction" — an ok result that
 * is neither navigation-ack nor query-echo/page-dump material — resets the
 * count; observing the same search URL again does not double-count it.
 */
export function countSearchesSinceExtraction(events: TraceEvent[]): number {
  let count = 0;
  let lastCountedUrl: string | undefined;

  for (const event of events) {
    if (event.kind === "observation") {
      const url = typeof event.payload.url === "string" ? event.payload.url : undefined;
      if (url !== undefined && url !== lastCountedUrl && isSearchNavigationUrl(url)) {
        count += 1;
        lastCountedUrl = url;
      }
      continue;
    }
    if (event.kind === "code-result" && event.payload.ok === true && !isNavigationOnlyResult(event)) {
      const text = resultText(event);
      if (text !== undefined && !looksLikeUnextractedPage(text)) {
        count = 0;
        lastCountedUrl = undefined;
      }
    }
  }

  return count;
}
