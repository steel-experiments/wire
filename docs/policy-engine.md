# Policy Engine

The policy engine gates destructive and privileged actions. Policy is outside the reasoning loop — the model proposes actions; policy decides what is allowed.

## Architecture

```ts
interface PolicyEngine {
  check(actionId: ActionId, action: PolicyAction): PolicyDecision;
}
```

The engine evaluates a list of `PolicyRule` objects against each proposed action:

```ts
interface PolicyAction {
  kind: string;
  summary: string;
  payload?: Record<string, unknown>;
  metadata?: {
    riskKind?: ExecRiskKind;
    riskReasons?: string[];
    cdpMethods?: string[];
  };
}

interface PolicyRule {
  id: string;
  description: string;
  check: (action: PolicyAction) => PolicyDecisionResult;
}
```

Evaluation order:
1. **Deny first** — any rule returning `"deny"` wins immediately
2. **Approval second** — first rule returning `"require-approval"` wins
3. **Default allow** — no matching rules means the action is allowed

## Baseline rules

Wire ships with 9 baseline rules in `src/policy/rules.ts`:

| Rule ID | Action | Result |
|---------|--------|--------|
| `baseline-submit-purchase-send` | `submit`, `purchase`, `send`, `transfer`, `pay`, `checkout` | require-approval |
| `baseline-exec-risk-mutation` | `unknown-mutation`, `download` | require-approval |
| `baseline-account-billing-permission` | `change-account`, `change-billing`, `change-permission`, etc. | require-approval |
| `baseline-deletion` | `delete`, `remove`, `destroy`, `purge` | **deny** |
| `baseline-outbound-message` | `send-message`, `post`, `email`, `notify`, `tweet`, `reply` | require-approval |
| `baseline-irreversible-mutation` | `irreversible-mutation`, `overwrite`, `drop`, `truncate`, `hard-delete` | **deny** |
| `baseline-privileged-profile` | `use-privileged-profile`, `assume-role`, `escalate` | require-approval |
| `baseline-raw-cdp` | Raw CDP access (except safe input methods) | require-approval |
| `baseline-reconfigure-custom-proxy` | Reconfigure with a custom proxy server URL | require-approval |

## Exec risk classification

Before an `exec` action reaches the policy engine, the runtime classifies its risk level by analyzing the JavaScript code:

```ts
type ExecRiskKind =
  | "read"           // no mutation detected
  | "navigate"       // window.location, history.pushState
  | "input"          // .value =, .click(), dispatchEvent
  | "submit"         // .submit(), purchase/checkout/pay calls
  | "download"       // download keyword, URL.createObjectURL
  | "account-change"  // billing/permission/role mutations
  | "delete"         // delete/remove/destroy patterns
  | "unknown-mutation" // mutating fetch (PUT/PATCH/DELETE/POST), WebSocket, XMLHttpRequest
```

The runtime sends this classification as `PolicyAction.metadata.riskKind` even when an action payload declares a different `policyKind`. Baseline rules inspect both the action kind and metadata, so a mislabeled exec cannot downgrade delete or mutation risk.

Classification priority (first match wins):
1. **Delete** — `delete`, `remove`, `method: "DELETE"` patterns
2. **Account change** — billing/permission/role keywords
3. **Unknown mutation** — `fetch()` with PUT/PATCH/DELETE, `sendBeacon()`, `WebSocket`, `XMLHttpRequest`
4. **Submit** — `.submit()`, `purchase()`, `checkout()`, `pay()` calls
5. **Download** — `download` keyword, `URL.createObjectURL`
6. **Input** — `.value =`, `.click()`, `dispatchEvent`
7. **Navigate** — `window.location`, `history.pushState`
8. **Read** — no mutation pattern detected

### Read-style POST exemptions

POST requests to read-style endpoints are downgraded from `unknown-mutation` to `read`:

- URLs containing: `search`, `query`, `lookup`, `filter`, `list`, `find`, `browse`, `count`, `aggregate`, `graphql`
- URLs with query parameters: `keyword`, `keywords`, `q`, `query`, `search`, `term`, `filter`

This prevents search and GraphQL tasks from triggering unnecessary approval gates.

### Safe CDP methods

These CDP methods are auto-allowed without approval:

- `Input.dispatchKeyEvent`
- `Input.dispatchMouseEvent`
- `Input.insertText`
- `Input.dispatchTouchEvent`
- `Input.dispatchDragEvent`
- `Page.navigate`
- `Page.reload`
- `Page.navigateToHistoryEntry`

Input methods are equivalent to physical user input, and navigation methods match the normal exec-navigation risk. Other raw CDP methods require approval.

## Approval flow

When an action requires approval:

1. The runtime creates an `ApprovalRequest` with the action details
2. A `RunCheckpoint` is saved with the full loop state
3. The run status becomes `awaiting-approval`
4. The session is kept alive (not stopped)
5. The CLI or API user approves with `wire approve --run-id <id>`
6. The checkpoint is loaded, the approved action is re-executed (with policy check skipped), and the loop resumes

### Approval request

```ts
interface ApprovalRequest {
  id: ApprovalId;
  runId: RunId;
  actionId: ActionId;
  summary: string;
  consequences: string[];
  expiresAt?: string;
  status?: ApprovalStatus;
  proposedAction?: ProposedActionDetail;
}
```

### Auto-approval (`--yes` mode)

The `--yes` / `--non-interactive` flag wraps the policy engine in a decorator that auto-approves any `require-approval` result. Used for CI and automated pipelines.

### Expired approval cleanup

Abandoned approvals keep browser sessions alive. The `reapExpiredApprovals()` function:
1. Lists all pending approval requests
2. Checks if any have passed their `expiresAt` timestamp
3. Stops the associated browser session
4. Deletes the checkpoint
5. Marks the approval as `expired`

This runs automatically at the start of every new task.

## Custom rules

Pass custom rules to `createPolicyEngine(rules)` to override or extend the baseline. Each rule is a `PolicyRule` with an `id`, `description`, and `check` function.

```ts
const customRules: PolicyRule[] = [
  {
    id: "deny-social-media",
    description: "Block all social media interactions",
    check: (action) => {
      const code = String(action.payload?.code ?? "");
      return /twitter\.com|facebook\.com|instagram\.com/.test(code)
        ? "deny"
        : "allow";
    },
  },
];

const engine = createPolicyEngine([...BASELINE_RULES, ...customRules]);
```

## Scope: action kinds, not destinations

The baseline policy is deliberately about *what the agent does* (action kinds
and code-derived risk), not *where it goes*: there is no built-in per-domain
allowlist or denylist. Wire is a general browser agent — site scoping belongs
to the task objective and the operator, not a baked-in core list. Callers that
need a navigation boundary can express one as a custom rule (like the
social-media example above) without any core change. Decision recorded
2026-06-10 so future audits don't re-flag the absence as a gap.
