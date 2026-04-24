import type { BrowserObservation, TraceEvent } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AuthWallResult {
  detected: boolean;
  reason?: string;
  evidenceUrl?: string;
}

// ---------------------------------------------------------------------------
// Auth-wall URL patterns
// ---------------------------------------------------------------------------

export const AUTH_WALL_PATTERNS: string[] = [
  "/login",
  "/signin",
  "/auth",
  "/oauth",
  "accounts.google.com",
  "auth0.com",
  "login.",
  "signin.",
  "auth.",
];

// ---------------------------------------------------------------------------
// Keyword sets
// ---------------------------------------------------------------------------

const TITLE_KEYWORDS: ReadonlySet<string> = new Set([
  "sign in",
  "log in",
  "login",
  "sign up",
  "authenticate",
  "authentication required",
]);

const FORM_KEYWORDS: ReadonlySet<string> = new Set([
  "password",
  "email",
  "username",
]);

// ---------------------------------------------------------------------------
// Detection helpers
// ---------------------------------------------------------------------------

function urlMatchesAuthPattern(url: string): string | null {
  const lower = url.toLowerCase();
  for (const pattern of AUTH_WALL_PATTERNS) {
    if (lower.includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  return null;
}

function titleIndicatesAuth(title: string): boolean {
  const lower = title.toLowerCase();
  for (const keyword of TITLE_KEYWORDS) {
    if (lower.includes(keyword)) {
      return true;
    }
  }
  return false;
}

/**
 * Heuristic: if the page has exactly one form, very few buttons, and no
 * tables or dialogs, it is likely a login form rather than a full
 * application page.
 */
function pageLooksLikeLoginForm(observation: BrowserObservation): boolean {
  const summary = observation.pageSummary;
  if (summary === undefined) return false;

  const hasSingleForm = summary.forms === 1;
  const hasNoTables = (summary.tables ?? 0) === 0;
  const hasFewButtons = (summary.buttons ?? 0) <= 3;
  const hasNoDialogs = (summary.dialogs ?? 0) === 0;

  if (!hasSingleForm) return false;

  // Check visible text for form-related keywords
  const texts = summary.visibleTexts;
  if (texts !== undefined && texts.length > 0) {
    const combined = texts.join(" ").toLowerCase();
    const hasFormKeywords = FORM_KEYWORDS.has("password") &&
      combined.includes("password");
    if (hasFormKeywords) {
      return hasNoTables && hasFewButtons && hasNoDialogs;
    }
  }

  return hasNoTables && hasFewButtons && hasNoDialogs;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect whether the current page is an authentication wall / login page.
 *
 * Detection is based on three signals:
 * 1. URL contains known auth-related path or domain patterns.
 * 2. Page title contains login / sign-in keywords.
 * 3. Page structure resembles a standalone login form (single form, few
 *    buttons, no application content).
 *
 * Any single signal is sufficient to flag the page as an auth wall.
 */
export function detectAuthWall(observation: BrowserObservation): AuthWallResult {
  // Signal 1: URL pattern match
  const urlMatch = urlMatchesAuthPattern(observation.url);
  if (urlMatch !== null) {
    return {
      detected: true,
      reason: `URL contains auth pattern: "${urlMatch}"`,
      evidenceUrl: observation.url,
    };
  }

  // Signal 2: Title keywords
  if (titleIndicatesAuth(observation.title)) {
    return {
      detected: true,
      reason: `Page title indicates auth: "${observation.title}"`,
      evidenceUrl: observation.url,
    };
  }

  // Signal 3: Login-form-like page structure
  if (pageLooksLikeLoginForm(observation)) {
    return {
      detected: true,
      reason: "Page structure resembles a login form",
      evidenceUrl: observation.url,
    };
  }

  return { detected: false };
}
