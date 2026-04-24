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
