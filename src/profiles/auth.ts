import type { BrowserObservation, TraceEvent } from "../shared/types.js";

// Types

export interface AuthWallResult {
  detected: boolean;
  reason?: string;
  evidenceUrl?: string;
}

// Auth-wall URL patterns

export const AUTH_WALL_PATTERNS: string[] = [
  "/login",
  "/signin",
  "/auth",
  "/oauth",
  "/sorry/index",
  "/captcha",
  "/recaptcha",
  "/cdn-cgi/challenge",
  "accounts.google.com",
  "auth0.com",
  "login.",
  "signin.",
  "auth.",
];

// Keyword sets

const TITLE_KEYWORDS: ReadonlySet<string> = new Set([
  "sign in",
  "log in",
  "login",
  "sign up",
  "authenticate",
  "authentication required",
  "captcha",
  "recaptcha",
  "verify you are human",
  "unusual traffic",
  "checking your browser",
]);

const FORM_KEYWORDS: ReadonlySet<string> = new Set([
  "password",
  "email",
  "username",
]);

// Detection helpers

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
 *
 * Key anti-pattern: a real page with a cookie consent overlay also has one
 * form and few visible buttons. We reject the login-form hypothesis when
 * the page has substantial content (many links, multiple headings, or a
 * dialog element which cookie banners sometimes use).
 */
function pageLooksLikeLoginForm(observation: BrowserObservation): boolean {
  const summary = observation.pageSummary;
  if (summary === undefined) return false;

  const forms = summary.forms ?? 0;
  const tables = summary.tables ?? 0;
  const buttons = summary.buttons ?? 0;
  const dialogs = summary.dialogs ?? 0;
  const links = summary.links ?? 0;
  const inputs = summary.inputs ?? 0;
  const headings = summary.headings ?? [];

  // A real login page has exactly one form
  if (forms !== 1) return false;

  // Dialog present → likely a cookie/consent overlay, not a login page
  if (dialogs > 0) return false;

  // Many links → this is a real page with content, not a bare login form
  if (links > 15) return false;

  // Multiple headings → page has structured content beyond a login form
  if (headings.length > 2) return false;

  const noTables = tables === 0;
  const fewButtons = buttons <= 3;

  // Check headings for password keyword — strong auth signal
  const combined = headings.join(" ").toLowerCase();
  if (combined.includes("password")) {
    return noTables && fewButtons;
  }

  // Without password evidence, also require few inputs (login ≈ 2-3 fields)
  return noTables && fewButtons && inputs <= 3;
}

// Public API

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
