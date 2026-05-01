import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { ActionId, ApprovalRequest, RunId } from "../shared/types.js";

import { createApprovalRequest, isExpired, resolveApproval } from "./approvals.js";
import { createPolicyEngine } from "./engine.js";
import type { PolicyEngine } from "./engine.js";
import {
  BASELINE_RULES,
  evaluateRules,
  classifyExecRisk,
} from "./rules.js";
import type { PolicyAction, PolicyRule } from "./rules.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAction(overrides: Partial<PolicyAction> = {}): PolicyAction {
  return {
    kind: "observe",
    summary: "Read the current page.",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// rules.ts — evaluateRules
// ---------------------------------------------------------------------------

test("evaluateRules allows benign actions", () => {
  const action = makeAction({ kind: "observe" });

  const { result, matchedRules } = evaluateRules(action);

  assert.equal(result, "allow");
  assert.deepEqual(matchedRules, []);
});

test("evaluateRules requires approval for submit actions", () => {
  const action = makeAction({ kind: "submit", summary: "Submit the form." });

  const { result, matchedRules } = evaluateRules(action);

  assert.equal(result, "require-approval");
  assert.ok(matchedRules.includes("baseline-submit-purchase-send"));
});

test("evaluateRules requires approval for purchase actions", () => {
  const action = makeAction({ kind: "purchase", summary: "Buy item." });

  const { result } = evaluateRules(action);

  assert.equal(result, "require-approval");
});

test("evaluateRules requires approval for send actions", () => {
  const action = makeAction({ kind: "send", summary: "Send email." });

  const { result } = evaluateRules(action);

  assert.equal(result, "require-approval");
});

test("evaluateRules requires approval for account changes", () => {
  const action = makeAction({ kind: "change-account", summary: "Change account." });

  const { result, matchedRules } = evaluateRules(action);

  assert.equal(result, "require-approval");
  assert.ok(matchedRules.includes("baseline-account-billing-permission"));
});

test("evaluateRules requires approval for billing changes", () => {
  const action = makeAction({ kind: "update-billing", summary: "Update billing." });

  const { result } = evaluateRules(action);

  assert.equal(result, "require-approval");
});

test("evaluateRules denies deletion actions", () => {
  const action = makeAction({ kind: "delete", summary: "Delete the record." });

  const { result, matchedRules } = evaluateRules(action);

  assert.equal(result, "deny");
  assert.ok(matchedRules.includes("baseline-deletion"));
});

test("evaluateRules denies purge actions", () => {
  const action = makeAction({ kind: "purge", summary: "Purge all data." });

  const { result } = evaluateRules(action);

  assert.equal(result, "deny");
});

test("evaluateRules requires approval for outbound messages", () => {
  const action = makeAction({ kind: "send-message", summary: "Send a message." });

  const { result, matchedRules } = evaluateRules(action);

  assert.equal(result, "require-approval");
  assert.ok(matchedRules.includes("baseline-outbound-message"));
});

test("evaluateRules denies irreversible mutations", () => {
  const action = makeAction({ kind: "overwrite", summary: "Overwrite data." });

  const { result, matchedRules } = evaluateRules(action);

  assert.equal(result, "deny");
  assert.ok(matchedRules.includes("baseline-irreversible-mutation"));
});

test("evaluateRules requires approval for privileged profile usage", () => {
  const action = makeAction({ kind: "use-privileged-profile", summary: "Use admin profile." });

  const { result, matchedRules } = evaluateRules(action);

  assert.equal(result, "require-approval");
  assert.ok(matchedRules.includes("baseline-privileged-profile"));
});

test("evaluateRules: deny wins over require-approval", () => {
  // If an action matches both a deny rule and a require-approval rule,
  // deny should win.
  const bothDenyAndApproval: PolicyRule[] = [
    {
      id: "approval-rule",
      description: "Needs approval.",
      check: () => "require-approval",
    },
    {
      id: "deny-rule",
      description: "Always deny.",
      check: () => "deny",
    },
  ];

  const { result, matchedRules } = evaluateRules(makeAction(), bothDenyAndApproval);

  assert.equal(result, "deny");
  assert.deepEqual(matchedRules, ["deny-rule"]);
});

test("evaluateRules: first require-approval wins when no deny", () => {
  const multipleApproval: PolicyRule[] = [
    {
      id: "approval-a",
      description: "Approval A.",
      check: () => "require-approval",
    },
    {
      id: "approval-b",
      description: "Approval B.",
      check: () => "require-approval",
    },
  ];

  const { result, matchedRules } = evaluateRules(makeAction(), multipleApproval);

  assert.equal(result, "require-approval");
  assert.deepEqual(matchedRules, ["approval-a"]);
});

test("evaluateRules: allow when no rules match", () => {
  const neverMatch: PolicyRule[] = [
    {
      id: "pass-through",
      description: "Never matches.",
      check: () => "allow",
    },
  ];

  const { result, matchedRules } = evaluateRules(makeAction(), neverMatch);

  assert.equal(result, "allow");
  assert.deepEqual(matchedRules, []);
});

test("evaluateRules uses custom rules when provided", () => {
  const custom: PolicyRule[] = [
    {
      id: "custom-deny",
      description: "Deny exec for specific URLs.",
      check: (action) =>
        action.kind === "exec" &&
        typeof action.payload?.url === "string" &&
        action.payload.url.includes("admin")
          ? "deny"
          : "allow",
    },
  ];

  const allowed = evaluateRules(
    makeAction({ kind: "exec", summary: "Navigate.", payload: { url: "https://example.com" } }),
    custom,
  );
  assert.equal(allowed.result, "allow");

  const denied = evaluateRules(
    makeAction({ kind: "exec", summary: "Navigate.", payload: { url: "https://example.com/admin" } }),
    custom,
  );
  assert.equal(denied.result, "deny");
  assert.deepEqual(denied.matchedRules, ["custom-deny"]);
});

test("classifyExecRisk allows read-only fetch but flags network mutations", () => {
  assert.equal(classifyExecRisk("return await fetch('/api/items').then(r => r.json())").kind, "read");
  assert.equal(classifyExecRisk("return fetch('/api/items', { method: 'POST', body: '{}' })").kind, "unknown-mutation");
});

test("classifyExecRisk flags submit and delete browser code", () => {
  assert.equal(classifyExecRisk("document.querySelector('form')!.requestSubmit()").kind, "submit");
  assert.equal(classifyExecRisk("await fetch('/items/1', { method: 'DELETE' })").kind, "delete");
});

test("classifyExecRisk treats POST to search-style endpoints as read", () => {
  // Search/query/list endpoints often use POST for body-encoded queries; these
  // are reads, not mutations, and should not trip approval.
  assert.equal(
    classifyExecRisk("fetch('https://api.example.com/v1/search', { method: 'POST', body: JSON.stringify({q:'ai'}) })").kind,
    "read",
  );
  assert.equal(
    classifyExecRisk("fetch('https://www.grants.gov/grantsws/rest/opportunities/search', { method: 'POST' })").kind,
    "read",
  );
  assert.equal(
    classifyExecRisk("fetch('/graphql', { method: 'POST', body: query })").kind,
    "read",
  );
  assert.equal(
    classifyExecRisk("fetch('/api/items?q=test', { method: 'POST' })").kind,
    "read",
  );
});

test("classifyExecRisk still flags PUT/PATCH regardless of URL", () => {
  assert.equal(
    classifyExecRisk("fetch('/api/search', { method: 'PUT' })").kind,
    "unknown-mutation",
  );
  assert.equal(
    classifyExecRisk("fetch('/api/search', { method: 'PATCH' })").kind,
    "unknown-mutation",
  );
});

test("classifyExecRisk still flags non-search POSTs and variable URLs as mutation", () => {
  // Variable URL — can't verify it's read-style, default to flagging.
  assert.equal(
    classifyExecRisk("fetch(targetUrl, { method: 'POST', body: payload })").kind,
    "unknown-mutation",
  );
  // Non-read-style URL.
  assert.equal(
    classifyExecRisk("fetch('/api/orders', { method: 'POST', body: order })").kind,
    "unknown-mutation",
  );
});

test("classifyExecRisk classifies bare .click() as input, not submit/download", () => {
  // A bare .click() on a search/nav button is just a user gesture; flagging
  // it as submit blocked legitimate read tasks.
  assert.equal(
    classifyExecRisk("document.querySelector('button.search').click()").kind,
    "input",
  );
  assert.equal(
    classifyExecRisk("btn.click()").kind,
    "input",
  );
});

test("classifyExecRisk still flags real submit code", () => {
  assert.equal(classifyExecRisk("form.submit()").kind, "submit");
  assert.equal(classifyExecRisk("form.requestSubmit()").kind, "submit");
  assert.equal(classifyExecRisk("checkout()").kind, "submit");
});

// ---------------------------------------------------------------------------
// rules.ts — BASELINE_RULES
// ---------------------------------------------------------------------------

test("BASELINE_RULES has nine rules", () => {
  assert.equal(BASELINE_RULES.length, 9);
});

test("BASELINE_RULES every rule has an id and description", () => {
  for (const rule of BASELINE_RULES) {
    assert.ok(rule.id.length > 0, `Rule missing id: ${JSON.stringify(rule)}`);
    assert.ok(rule.description.length > 0, `Rule missing description: ${rule.id}`);
    assert.equal(typeof rule.check, "function", `Rule missing check: ${rule.id}`);
  }
});

// ---------------------------------------------------------------------------
// engine.ts — createPolicyEngine
// ---------------------------------------------------------------------------

test("createPolicyEngine returns a PolicyEngine with check method", () => {
  const engine = createPolicyEngine();

  assert.equal(typeof engine.check, "function");
});

function makeActionId(): ActionId {
  return createId("action");
}

test("PolicyEngine.check returns a PolicyDecision with id", () => {
  const engine = createPolicyEngine();
  const action = makeAction({ kind: "observe" });

  const decision = engine.check(makeActionId(), action);

  assert.ok(decision.id.startsWith("policy_"));
  assert.equal(decision.result, "allow");
});

test("PolicyEngine.check returns reason for matched rules", () => {
  const engine = createPolicyEngine();
  const action = makeAction({ kind: "submit", summary: "Submit form." });

  const decision = engine.check(makeActionId(), action);

  assert.equal(decision.result, "require-approval");
  assert.ok(decision.reason?.includes("baseline-submit-purchase-send"));
});

test("PolicyEngine.check has no reason for allowed actions", () => {
  const engine = createPolicyEngine();
  const action = makeAction({ kind: "observe" });

  const decision = engine.check(makeActionId(), action);

  assert.equal(decision.result, "allow");
  assert.equal(decision.reason, undefined);
});

test("PolicyEngine.check propagates actionId into the decision", () => {
  const engine = createPolicyEngine();
  const actionId = createId("action");
  const action = makeAction({ kind: "observe", summary: "Read page." });

  const decision = engine.check(actionId, action);

  assert.equal(decision.actionId, actionId);
});

test("PolicyEngine.check uses default rules when none provided", () => {
  const engine = createPolicyEngine();
  const action = makeAction({ kind: "delete", summary: "Delete." });

  const decision = engine.check(makeActionId(), action);

  assert.equal(decision.result, "deny");
});

test("PolicyEngine.check uses custom rules when provided", () => {
  const alwaysAllow: PolicyRule[] = [
    {
      id: "always-allow",
      description: "Allow everything.",
      check: () => "allow",
    },
  ];

  const engine = createPolicyEngine(alwaysAllow);
  const action = makeAction({ kind: "delete", summary: "Delete." });

  const decision = engine.check(makeActionId(), action);

  assert.equal(decision.result, "allow");
});

test("PolicyEngine generates unique decision ids", () => {
  const engine = createPolicyEngine();
  const action = makeAction({ kind: "observe" });

  const d1 = engine.check(makeActionId(), action);
  const d2 = engine.check(makeActionId(), action);

  assert.notEqual(d1.id, d2.id);
});

// ---------------------------------------------------------------------------
// approvals.ts — createApprovalRequest
// ---------------------------------------------------------------------------

test("createApprovalRequest creates a pending ApprovalRequest", () => {
  const runId = createId("run") as RunId;
  const actionId = createId("action") as ActionId;

  const request = createApprovalRequest(
    runId,
    actionId,
    "Submit payment form.",
    ["$50 will be charged."],
  );

  assert.ok(request.id.startsWith("approval_"));
  assert.equal(request.runId, runId);
  assert.equal(request.actionId, actionId);
  assert.equal(request.summary, "Submit payment form.");
  assert.deepEqual(request.consequences, ["$50 will be charged."]);
  assert.equal(request.status, "pending");
  assert.ok(request.expiresAt !== undefined);
});

test("createApprovalRequest sets a future expiresAt", () => {
  const runId = createId("run") as RunId;
  const actionId = createId("action") as ActionId;
  const before = Date.now();

  const request = createApprovalRequest(runId, actionId, "Test.", []);

  const expiresAt = Date.parse(request.expiresAt!);
  assert.ok(expiresAt > before, "expiresAt should be in the future");
});

test("createApprovalRequest carries proposedAction detail when supplied", () => {
  const runId = createId("run") as RunId;
  const actionId = createId("action") as ActionId;

  const request = createApprovalRequest(runId, actionId, "Search posts.", [], {
    kind: "exec",
    riskKind: "unknown-mutation",
    reason: "Matched rules: baseline-exec-risk-mutation",
    codeExcerpt: "fetch('/api/search', { method: 'POST' })",
  });

  assert.deepEqual(request.proposedAction, {
    kind: "exec",
    riskKind: "unknown-mutation",
    reason: "Matched rules: baseline-exec-risk-mutation",
    codeExcerpt: "fetch('/api/search', { method: 'POST' })",
  });
});

test("createApprovalRequest omits proposedAction when not supplied", () => {
  const runId = createId("run") as RunId;
  const actionId = createId("action") as ActionId;
  const request = createApprovalRequest(runId, actionId, "Test.", []);
  assert.equal(request.proposedAction, undefined);
});

// ---------------------------------------------------------------------------
// approvals.ts — isExpired
// ---------------------------------------------------------------------------

test("isExpired returns false for a fresh request", () => {
  const runId = createId("run") as RunId;
  const actionId = createId("action") as ActionId;

  const request = createApprovalRequest(runId, actionId, "Test.", []);

  assert.equal(isExpired(request), false);
});

test("isExpired returns true when expiresAt is in the past", () => {
  const request: ApprovalRequest = {
    id: createId("approval"),
    runId: createId("run") as RunId,
    actionId: createId("action") as ActionId,
    summary: "Expired action.",
    consequences: [],
    expiresAt: nowIsoUtc(new Date(Date.now() - 1000)),
    status: "pending",
  };

  assert.equal(isExpired(request), true);
});

test("isExpired returns false for approved requests even if expired", () => {
  const request: ApprovalRequest = {
    id: createId("approval"),
    runId: createId("run") as RunId,
    actionId: createId("action") as ActionId,
    summary: "Already approved.",
    consequences: [],
    expiresAt: nowIsoUtc(new Date(Date.now() - 1000)),
    status: "approved",
  };

  assert.equal(isExpired(request), false);
});

test("isExpired returns false for rejected requests even if expired", () => {
  const request: ApprovalRequest = {
    id: createId("approval"),
    runId: createId("run") as RunId,
    actionId: createId("action") as ActionId,
    summary: "Already rejected.",
    consequences: [],
    expiresAt: nowIsoUtc(new Date(Date.now() - 1000)),
    status: "rejected",
  };

  assert.equal(isExpired(request), false);
});

test("isExpired returns false when expiresAt is undefined", () => {
  const request: ApprovalRequest = {
    id: createId("approval"),
    runId: createId("run") as RunId,
    actionId: createId("action") as ActionId,
    summary: "No expiry.",
    consequences: [],
    status: "pending",
  };

  assert.equal(isExpired(request), false);
});

// ---------------------------------------------------------------------------
// approvals.ts — resolveApproval
// ---------------------------------------------------------------------------

test("resolveApproval sets status to approved", () => {
  const runId = createId("run") as RunId;
  const actionId = createId("action") as ActionId;
  const original = createApprovalRequest(runId, actionId, "Test.", []);

  const resolved = resolveApproval(original, "approved");

  assert.equal(resolved.status, "approved");
  assert.equal(resolved.id, original.id);
  assert.equal(resolved.runId, original.runId);
  assert.equal(resolved.actionId, original.actionId);
  assert.equal(resolved.summary, original.summary);
  assert.deepEqual(resolved.consequences, original.consequences);
});

test("resolveApproval sets status to rejected", () => {
  const runId = createId("run") as RunId;
  const actionId = createId("action") as ActionId;
  const original = createApprovalRequest(runId, actionId, "Test.", []);

  const resolved = resolveApproval(original, "rejected");

  assert.equal(resolved.status, "rejected");
});

test("resolveApproval does not mutate the original", () => {
  const runId = createId("run") as RunId;
  const actionId = createId("action") as ActionId;
  const original = createApprovalRequest(runId, actionId, "Test.", []);

  const resolved = resolveApproval(original, "approved");

  assert.equal(original.status, "pending");
  assert.equal(resolved.status, "approved");
});

// ---------------------------------------------------------------------------
// rules.ts — reconfigure policy
// ---------------------------------------------------------------------------

test("evaluateRules auto-allows reconfigure with boolean useProxy", () => {
  const action = makeAction({
    kind: "reconfigure",
    summary: "Enable proxy to bypass IP block.",
    payload: { useProxy: true },
  });

  const { result } = evaluateRules(action);
  assert.equal(result, "allow");
});

test("evaluateRules auto-allows reconfigure with solveCaptcha", () => {
  const action = makeAction({
    kind: "reconfigure",
    summary: "Enable captcha solver.",
    payload: { solveCaptcha: true },
  });

  const { result } = evaluateRules(action);
  assert.equal(result, "allow");
});

test("evaluateRules requires approval for reconfigure with custom proxy server", () => {
  const action = makeAction({
    kind: "reconfigure",
    summary: "Use custom proxy server.",
    payload: { useProxy: { server: "http://custom-proxy.example.com:8080" } },
  });

  const { result, matchedRules } = evaluateRules(action);
  assert.equal(result, "require-approval");
  assert.ok(matchedRules.includes("baseline-reconfigure-custom-proxy"));
});

test("evaluateRules auto-allows reconfigure with no payload", () => {
  const action = makeAction({
    kind: "reconfigure",
    summary: "Reconfigure session defaults.",
  });

  const { result } = evaluateRules(action);
  assert.equal(result, "allow");
});
