import type { PolicyDecisionResult } from "../shared/types.js";

// Policy action — the shape the engine evaluates

export interface PolicyAction {
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
  metadata?: PolicyActionMetadata;
}

export interface PolicyActionMetadata {
  riskKind?: ExecRiskKind;
  riskReasons?: string[];
  cdpMethods?: string[];
}

// Policy rule — a single check

export interface PolicyRule {
  id: string;
  description: string;
  check: (action: PolicyAction) => PolicyDecisionResult;
}

// Baseline rule helpers — predicate-based rule factory

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

// Sensitive action keywords

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
 * CDP methods that are safe to auto-allow. Input methods mirror physical user
 * gestures, and navigation methods match exec navigation risk.
 */
const SAFE_CDP_METHOD_PREFIXES = [
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.insertText",
  "Input.dispatchTouchEvent",
  "Page.navigate",
  "Page.reload",
  "Page.navigateToHistoryEntry",
];

function isSafeCdpMethod(method: string | undefined): boolean {
  if (!method) return false;
  return SAFE_CDP_METHOD_PREFIXES.includes(method);
}

function actionRiskKind(action: PolicyAction): string | undefined {
  return typeof action.metadata?.riskKind === "string" ? action.metadata.riskKind : undefined;
}

function rawCdpRequiresApproval(action: PolicyAction): boolean {
  if (action.kind !== "raw") return false;

  const methods: string[] = [];
  if (Array.isArray(action.metadata?.cdpMethods)) {
    methods.push(...action.metadata.cdpMethods);
  }
  if (typeof action.payload?.method === "string") {
    methods.push(action.payload.method);
  }

  const commands = action.payload?.commands;
  if (Array.isArray(commands)) {
    for (const command of commands) {
      if (!command || typeof command !== "object" || Array.isArray(command)) {
        return true;
      }
      const method = (command as Record<string, unknown>)["method"];
      if (typeof method !== "string") {
        return true;
      }
      methods.push(method);
    }
  }

  return methods.length === 0 || methods.some((method) => !isSafeCdpMethod(method));
}

// Baseline rules

export const BASELINE_RULES: PolicyRule[] = [
  makeRule(
    "baseline-submit-purchase-send",
    "Submit, purchase, and send actions require human approval.",
    "require-approval",
    (a) => SUBMIT_KINDS.has(a.kind) || actionRiskKind(a) === "submit",
  ),
  makeRule(
    "baseline-exec-risk-mutation",
    "Exec code with unknown mutation or download risk requires human approval.",
    "require-approval",
    (a) => EXEC_RISK_APPROVAL_KINDS.has(a.kind) || EXEC_RISK_APPROVAL_KINDS.has(actionRiskKind(a) ?? ""),
  ),
  makeRule(
    "baseline-account-billing-permission",
    "Account, billing, and permission changes require human approval.",
    "require-approval",
    (a) => ACCOUNT_KINDS.has(a.kind) || actionRiskKind(a) === "account-change",
  ),
  makeRule(
    "baseline-deletion",
    "Deletion actions are denied by default.",
    "deny",
    (a) => DELETE_KINDS.has(a.kind) || actionRiskKind(a) === "delete",
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
    rawCdpRequiresApproval,
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

// evaluateRules — evaluate all rules against an action

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

// Exec risk classification — pattern-based code risk detection

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

// Submit-style verbs are flagged only when they look like a *call* and not a
// *declaration*. The bare-word match `\b(purchase|checkout|pay|send)\b` was
// catching innocuous helper names like `function send(dir){...}` (a keyboard
// dispatch helper) and blocking gameplay tasks at approval. "send" is dropped
// entirely because it is too commonly a synonym for `dispatch` in input code.
const SUBMIT_PATTERNS = [
  /\.submit\s*\(/u,
  /\brequestSubmit\s*\(/u,
  // Method call: o.purchase(), order.pay(), etc.
  /\.\s*(?:purchase|checkout|pay)\s*\(/iu,
  // Free-standing call like checkout(), excluding declarations.
  /(?<!function\s)(?<!const\s)(?<!let\s)(?<!var\s)\b(?:purchase|checkout|pay)\s*\(/iu,
];

// Bare zero-arg .click() is a user-input gesture, not inherently a submit.
// Real submits are caught by .submit()/requestSubmit(), purchase/checkout/pay
// keywords, or by the surrounding fetch verb.
const INPUT_PATTERNS = [
  /\.value\s*=/u,
  /\.checked\s*=/u,
  /\bdispatchEvent\s*\(/u,
  /\bInput\./u,
  /\bclick\s*\(\s*\)/u,
];

const DOWNLOAD_PATTERNS = [
  /\bdownload\b/iu,
  /URL\.createObjectURL/u,
];

const NAVIGATION_PATTERNS = [
  /\bwindow\s*\.\s*location\b/u,
  /\blocation\s*\.\s*(href|assign|replace|reload)\b/u,
  /\blocation\s*=/u,
  /\bdocument\s*\.\s*location\b/u,
  /\bhistory\s*\.\s*(pushState|replaceState)\b/u,
];

// Read-style endpoints that legitimately accept POST as a query verb (search
// APIs, GraphQL, RPC list/lookup). Used to downgrade POST fetches from
// "unknown-mutation" to "read" so search tasks don't trip approval.
const READ_STYLE_URL_PATTERNS = [
  /\/(?:search|query|lookup|filter|list|find|browse|count|aggregate)\b/iu,
  /\bgraphql\b/iu,
  /\?(?:[^"'\s)]*&)?(?:keyword|keywords|q|query|search|term|filter)=/iu,
];

function isMutatingNetwork(code: string): boolean {
  if (/\bfetch\s*\([\s\S]*?\bmethod\s*:\s*["'](?:PUT|PATCH|DELETE)["']/iu.test(code)) return true;
  if (/\bnavigator\s*\.\s*sendBeacon\s*\(/iu.test(code)) return true;
  if (/\bWebSocket\s*\(/iu.test(code)) return true;
  if (/\bXMLHttpRequest\b[\s\S]*\b(?:open|send)\s*\(/iu.test(code)) return true;
  const postFetches = code.match(/\bfetch\s*\([\s\S]*?\bmethod\s*:\s*["']POST["']/giu) ?? [];
  if (postFetches.length === 0) return false;
  return !postFetches.every((expr) => {
    const m = expr.match(/\bfetch\s*\(\s*['"`]([^'"`]+)['"`]/u);
    return !!m && READ_STYLE_URL_PATTERNS.some((p) => p.test(m[1]!));
  });
}

export function classifyExecRisk(code: string): ExecRisk {
  const reasons: string[] = [];

  if (DELETE_PATTERNS.some((pattern) => pattern.test(code))) {
    return { kind: "delete", reasons: ["delete-like code pattern"] };
  }

  if (ACCOUNT_PATTERNS.every((pattern) => pattern.test(code))) {
    return { kind: "account-change", reasons: ["account or billing mutation terms"] };
  }

  if (isMutatingNetwork(code)) {
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
