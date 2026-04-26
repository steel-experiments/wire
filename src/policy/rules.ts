import type { PolicyDecisionResult } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Policy action — the shape the engine evaluates
// ---------------------------------------------------------------------------

export interface PolicyAction {
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Policy rule — a single check
// ---------------------------------------------------------------------------

export interface PolicyRule {
  id: string;
  description: string;
  check: (action: PolicyAction) => PolicyDecisionResult;
}

// ---------------------------------------------------------------------------
// Baseline rule helpers — predicate-based rule factory
// ---------------------------------------------------------------------------

function makeRule(
  id: string,
  description: string,
  result: PolicyDecisionResult,
  predicate: (action: PolicyAction) => boolean,
): PolicyRule {
  return {
    id,
    description,
    check(action) {
      return predicate(action) ? result : "allow";
    },
  };
}

// ---------------------------------------------------------------------------
// Sensitive action keywords
// ---------------------------------------------------------------------------

const SUBMIT_KINDS = new Set([
  "submit",
  "purchase",
  "send",
  "transfer",
  "pay",
  "checkout",
]);

const EXEC_RISK_APPROVAL_KINDS = new Set([
  "unknown-mutation",
  "download",
]);

const ACCOUNT_KINDS = new Set([
  "change-account",
  "change-billing",
  "change-permission",
  "change-role",
  "update-billing",
  "grant-access",
  "revoke-access",
]);

const DELETE_KINDS = new Set([
  "delete",
  "remove",
  "destroy",
  "purge",
]);

const MESSAGE_KINDS = new Set([
  "send-message",
  "post",
  "email",
  "notify",
  "tweet",
  "reply",
]);

const MUTATION_KINDS = new Set([
  "irreversible-mutation",
  "overwrite",
  "drop",
  "truncate",
  "hard-delete",
]);

const PRIVILEGED_KINDS = new Set([
  "use-privileged-profile",
  "assume-role",
  "escalate",
]);

/**
 * CDP methods that are safe to auto-allow — they inject trusted input events
 * equivalent to what a user could do physically, no more dangerous than exec.
 */
const SAFE_CDP_METHOD_PREFIXES = [
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Input.dispatchTouchEvent",
];

function isSafeCdpMethod(method: string | undefined): boolean {
  if (!method) return false;
  return SAFE_CDP_METHOD_PREFIXES.includes(method);
}

// ---------------------------------------------------------------------------
// Baseline rules
// ---------------------------------------------------------------------------

export const BASELINE_RULES: PolicyRule[] = [
  makeRule(
    "baseline-submit-purchase-send",
    "Submit, purchase, and send actions require human approval.",
    "require-approval",
    (a) => SUBMIT_KINDS.has(a.kind),
  ),
  makeRule(
    "baseline-exec-risk-mutation",
    "Exec code with unknown mutation or download risk requires human approval.",
    "require-approval",
    (a) => EXEC_RISK_APPROVAL_KINDS.has(a.kind),
  ),
  makeRule(
    "baseline-account-billing-permission",
    "Account, billing, and permission changes require human approval.",
    "require-approval",
    (a) => ACCOUNT_KINDS.has(a.kind),
  ),
  makeRule(
    "baseline-deletion",
    "Deletion actions are denied by default.",
    "deny",
    (a) => DELETE_KINDS.has(a.kind),
  ),
  makeRule(
    "baseline-outbound-message",
    "Outbound messages require human approval.",
    "require-approval",
    (a) => MESSAGE_KINDS.has(a.kind),
  ),
  makeRule(
    "baseline-irreversible-mutation",
    "Irreversible data mutations are denied by default.",
    "deny",
    (a) => MUTATION_KINDS.has(a.kind),
  ),
  makeRule(
    "baseline-privileged-profile",
    "Privileged profile usage requires human approval.",
    "require-approval",
    (a) => PRIVILEGED_KINDS.has(a.kind),
  ),
  makeRule(
    "baseline-raw-cdp",
    "Raw CDP access requires approval, except safe input methods.",
    "require-approval",
    (a) => a.kind === "raw" && !isSafeCdpMethod(a.payload?.method as string | undefined),
  ),
  makeRule(
    "baseline-reconfigure-custom-proxy",
    "Reconfigure with a custom proxy server requires human approval.",
    "require-approval",
    (a) => {
      if (a.kind !== "reconfigure") return false;
      const proxy = a.payload?.useProxy;
      // Boolean useProxy is auto-allowed (recovery action); object with server URL requires approval
      return typeof proxy === "object" && proxy !== null;
    },
  ),
];

// ---------------------------------------------------------------------------
// evaluateRules — evaluate all rules against an action
// ---------------------------------------------------------------------------

export function evaluateRules(
  action: PolicyAction,
  rules: PolicyRule[] = BASELINE_RULES,
): { result: PolicyDecisionResult; matchedRules: string[] } {
  const matchedRules: string[] = [];

  // First pass: any deny wins immediately.
  for (const rule of rules) {
    if (rule.check(action) === "deny") {
      matchedRules.push(rule.id);
      return { result: "deny", matchedRules };
    }
  }

  // Second pass: first require-approval wins.
  for (const rule of rules) {
    if (rule.check(action) === "require-approval") {
      matchedRules.push(rule.id);
      return { result: "require-approval", matchedRules };
    }
  }

  return { result: "allow", matchedRules };
}

// ---------------------------------------------------------------------------
// Exec risk classification — pattern-based code risk detection
// ---------------------------------------------------------------------------

export type ExecRiskKind =
  | "read"
  | "navigate"
  | "input"
  | "submit"
  | "download"
  | "account-change"
  | "delete"
  | "unknown-mutation";

export interface ExecRisk {
  kind: ExecRiskKind;
  reasons: string[];
}

const DELETE_PATTERNS = [
  /\b(delete|remove|destroy|purge)\b/iu,
  /\bmethod\s*:\s*["']DELETE["']/iu,
];

const ACCOUNT_PATTERNS = [
  /\b(billing|permission|role|account|password|email)\b/iu,
  /\b(change|update|grant|revoke|invite)\b/iu,
];

const SUBMIT_PATTERNS = [
  /\.submit\s*\(/u,
  /\brequestSubmit\s*\(/u,
  /\bclick\s*\(\s*\)/u,
  /\bmethod\s*:\s*["'](POST|PUT|PATCH)["']/iu,
  /\b(purchase|checkout|pay|send)\b/iu,
];

const INPUT_PATTERNS = [
  /\.value\s*=/u,
  /\.checked\s*=/u,
  /\bdispatchEvent\s*\(/u,
  /\bInput\./u,
];

const DOWNLOAD_PATTERNS = [
  /\bdownload\b/iu,
  /URL\.createObjectURL/u,
  /\.click\s*\(\s*\)/u,
];

const NAVIGATION_PATTERNS = [
  /\bwindow\s*\.\s*location\b/u,
  /\blocation\s*\.\s*(href|assign|replace|reload)\b/u,
  /\blocation\s*=/u,
  /\bdocument\s*\.\s*location\b/u,
  /\bhistory\s*\.\s*(pushState|replaceState)\b/u,
];

const NETWORK_MUTATION_PATTERNS = [
  /\bfetch\s*\([^)]*\bmethod\s*:\s*["'](POST|PUT|PATCH|DELETE)["']/isu,
  /\bXMLHttpRequest\b[\s\S]*\b(open|send)\s*\(/iu,
  /\bnavigator\s*\.\s*sendBeacon\s*\(/iu,
  /\bWebSocket\s*\(/iu,
];

export function classifyExecRisk(code: string): ExecRisk {
  const reasons: string[] = [];

  if (DELETE_PATTERNS.some((pattern) => pattern.test(code))) {
    return { kind: "delete", reasons: ["delete-like code pattern"] };
  }

  if (ACCOUNT_PATTERNS.every((pattern) => pattern.test(code))) {
    return { kind: "account-change", reasons: ["account or billing mutation terms"] };
  }

  if (NETWORK_MUTATION_PATTERNS.some((pattern) => pattern.test(code))) {
    return { kind: "unknown-mutation", reasons: ["network mutation or outbound channel"] };
  }

  if (SUBMIT_PATTERNS.some((pattern) => pattern.test(code))) {
    return { kind: "submit", reasons: ["submit/click/payment/send pattern"] };
  }

  if (DOWNLOAD_PATTERNS.some((pattern) => pattern.test(code))) {
    reasons.push("download-like pattern");
    return { kind: "download", reasons };
  }

  if (INPUT_PATTERNS.some((pattern) => pattern.test(code))) {
    return { kind: "input", reasons: ["input mutation pattern"] };
  }

  if (NAVIGATION_PATTERNS.some((pattern) => pattern.test(code))) {
    return { kind: "navigate", reasons: ["navigation pattern"] };
  }

  return { kind: "read", reasons: ["no mutation pattern detected"] };
}
