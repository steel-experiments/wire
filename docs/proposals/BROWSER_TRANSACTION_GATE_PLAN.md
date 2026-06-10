# Wire Browser Transaction Gate Plan

## Thesis

Wire should not become a password manager for agents, a coding-agent permission wrapper, or a generic approval layer. Its strongest primitive is already present:

> Let agents operate websites freely until they approach externally meaningful finality, then mediate that transition with policy, evidence, approval, and receipts.

The product category is not "credential vault." It is a browser transaction gate for AI agents.

Agents should be able to browse, search, compare, draft, fill, and prepare. They should not be able to submit, pay, send, delete, invite, publish, or otherwise commit the user without an outside runtime deciding that the transition is allowed.

This maps cleanly to how the web already works. Most real-world authority is embedded in logged-in browser sessions and final-action buttons. If a browser agent controls the session, it inherits too much authority. Wire can become the layer that lets the agent use the session for preparation while keeping finality inspectable and gated.

## What Wire Already Has

Wire is already close to this shape:

- Real browser execution through Steel.
- A runtime loop outside the model.
- Append-only traces and artifacts.
- A policy engine outside the reasoning loop.
- Approval pause/resume.
- Auth-wall detection.
- Skills for durable site knowledge.
- Run classification and scoring.
- Secret redaction.
- A trusted `wire.click` path with target metadata and sensitive-target policy.

This is a better starting point than a new AgentPass-style credential product because it operates where most non-coding agents actually need help: websites, logged-in sessions, forms, carts, portals, dashboards, CRMs, support tools, travel sites, banks, SaaS admin panels, and procurement flows.

## Current Gap

The architecture says "policy gates destructive ops," but enforcement is not yet uniform.

There are multiple ways for the agent to interact:

- `wire.click(...)`
- raw CDP input
- helper calls such as `clickVisibleText(...)`
- arbitrary DOM APIs such as `element.click()`
- form APIs such as `form.submit()` or `requestSubmit()`
- network APIs such as `fetch()`

Only some of these paths carry enough semantic context for policy to make a good decision. The most important immediate gap is that `clickVisibleText()` currently uses DOM `el.click()` directly. That means the model can use the recommended helper to click a visible "Confirm", "Checkout", "Send", or "Delete" button without going through the `wire.click` target policy.

The product cannot honestly claim mediated finality until every user-facing click and submit-like path goes through the same policy boundary.

## Product Definition

Wire should be positioned as:

> A browser agent runtime that lets agents prepare real-world web actions, while gating final actions with policy, evidence, and approval.

Avoid positioning it as:

- a secret manager
- a CAPTCHA solver
- a generic browser automation library
- a coding-agent tool
- an approval framework
- an MCP security layer

The core loop is:

```text
objective
  -> agent explores and prepares in browser
  -> runtime observes and traces
  -> policy classifies risky transitions
  -> approval only when finality is reached
  -> action executes or is blocked
  -> receipt shows what happened
```

## Design Principles

1. Preparation should be fast.

   Reading pages, searching, comparing, filling drafts, navigating, extracting, and staging should not prompt the user.

2. Finality should be mediated.

   Actions like submit, purchase, pay, send, delete, publish, invite, refund, transfer, change permissions, and change billing should cross a runtime boundary.

3. Policy must be outside the model.

   The model can describe intent and propose code, but the runtime decides whether execution is allowed.

4. The gate must be uniform.

   A risky action should not be allowed just because it used a different browser primitive.

5. Receipts matter more than prompts.

   The user should normally review a short trace after the run. Approval prompts should appear only at meaningful transitions.

6. Policies should be behavioral, not endpoint-oriented.

   Users understand "send message" and "confirm checkout" better than DOM selectors, CDP methods, and URL path globs.

7. Site skills should improve both capability and safety.

   A skill should capture not only selectors and routes, but also site-specific finality markers: which buttons commit, which screens are review-only, which URL means payment, which modal is irreversible.

## Phase 1: Make The Finality Gate Real

Goal: every normal user-facing click path goes through one policy-enforced interaction broker.

### 1. Route `clickVisibleText()` through `wire.click`

Change the helper so it finds the element but delegates the actual click:

```js
await wire.click(el);
```

This preserves the good devex of label-based clicking while ensuring target metadata reaches the policy gate.

Required tests:

- `clickVisibleText("Search")` is allowed.
- `clickVisibleText("Continue")` is allowed unless context says otherwise.
- `clickVisibleText("Checkout")` requires approval.
- `clickVisibleText("Confirm order")` requires approval.
- `clickVisibleText("Send")` requires approval.
- `clickVisibleText("Delete")` is denied.

### 2. Treat arbitrary DOM `.click()` as lower-trust

The current classifier treats bare `.click()` as input, which was useful for avoiding approval spam. Keep that behavior only for clearly benign contexts, or introduce a middle state:

```text
input-unknown-target
```

Initial behavior can be:

- allow `.click()` during unauthenticated/read-only browsing
- require approval when the current page has forms, checkout/payment/account URLs, or sensitive labels in the observed DOM
- strongly steer prompts toward `wire.click`

This does not need to be perfect in phase 1. The key is to stop treating all `.click()` as equally safe.

### 3. Add a submit-event interception layer

DOM click policy is not enough. A site can submit through:

- `form.submit()`
- `requestSubmit()`
- Enter key
- button click with submit default
- app framework event handlers

Add a page-side guard that observes submit attempts and sends metadata to the runtime before allowing them. If full blocking is hard with the current CDP shape, start by recording and requiring approval for model-authored explicit submit APIs.

Target shape:

```text
wire.submitGuard:
  form action
  method
  visible form labels
  submitter text
  current URL
  decision: allow / approval / deny
```

### 4. Tighten raw CDP input policy

Raw coordinate clicks are useful but semantically opaque. They should remain available, but the policy should know they are lower-trust than `wire.click`.

Recommended rule:

- raw keyboard/mouse input is allowed for ordinary navigation and games
- raw click near sensitive visible text requires approval
- raw input on known finality pages requires approval
- raw unsafe CDP remains approval-required

This likely requires a lightweight pre-click page snapshot around the coordinate.

## Phase 2: Introduce Transaction Receipts

Goal: make Wire's output useful for trust after the run, not just debugging during the run.

Add a first-class receipt summary to `wire review` and persisted run metadata.

Receipt fields:

```text
Run
- run id
- objective
- started/finished
- sites visited
- profile used

Actions
- read/navigation count
- inputs/fills
- clicks
- submit attempts
- network mutations
- approvals requested
- denied actions
- final external effects

Evidence
- screenshots/artifacts
- extracted result
- relevant URLs

Safety
- raw credentials exposed: no/unknown
- approval required actions
- denied actions
- policy rules matched
```

The receipt should answer:

```text
What did the agent do?
What did it try to do but could not?
What final actions happened?
Was anything irreversible?
What evidence supports the result?
```

This is the user-facing trust surface. It is more valuable than a stream of prompts.

## Phase 3: Site-Specific Finality Skills

Goal: let Wire get safer over time without becoming a giant hand-coded rules engine.

Extend skills so they can include finality knowledge:

```yaml
finality:
  approvalLabels:
    - Confirm order
    - Send message
    - Submit application
  denyLabels:
    - Delete account
    - Remove workspace
  reviewOnlyRoutes:
    - /checkout/review
  finalRoutes:
    - /checkout/complete
  sensitiveRoutes:
    - /billing
    - /settings/users
```

Generated skill proposals should be allowed to suggest finality markers, but promotion should be conservative:

- require high confidence
- never auto-promote destructive allowances
- prefer approval/deny markers over allow markers
- surface finality additions clearly in review

This turns Wire's learning system into both a capability layer and a safety layer.

## Phase 4: Domain Profiles

Goal: avoid hand-managing policy while still adapting to common work domains.

Introduce simple run profiles:

```text
research
shopping-prepare
procurement
support
travel
admin-readonly
form-fill
```

Profiles should change thresholds, not rewrite the architecture.

Examples:

`research`
- reads and navigation allowed
- form submissions approval-required
- purchases denied

`shopping-prepare`
- search, compare, add-to-cart allowed
- checkout/payment approval-required
- purchase completion approval-required

`support`
- read tickets allowed
- draft replies allowed
- send reply approval-required
- refunds approval-required or denied depending on constraints

`admin-readonly`
- reads allowed
- settings changes denied
- invites/role changes denied

The CLI can infer a profile from the objective later, but v1 should accept an explicit flag.

## Phase 5: Evaluation Harness For Finality

Goal: measure whether Wire actually prevents unsafe final actions without ruining normal browsing.

Create benchmark tasks for:

- benign search and extraction
- newsletter signup stop-before-submit
- e-commerce cart preparation stop-before-payment
- travel booking stop-before-purchase
- email/contact form draft stop-before-send
- account settings page read-only audit
- destructive button denial
- prompt injection asking the agent to submit/pay/delete

Metrics:

```text
task completion
unnecessary approval rate
missed finality rate
denied destructive action rate
receipt completeness
steps to completion
false positive friction
```

The most important metric is not raw task success. It is:

```text
successful preparation without unauthorized finality
```

## Phase 6: Product UX

Goal: make the safety model visible without making the workflow feel bureaucratic.

CLI output should distinguish:

```text
preparing
blocked
needs approval
completed
```

Approval prompts should be action-shaped:

```text
Wire needs approval

Action: Confirm checkout
Site: example.com
Button: "Place order"
Amount: $84.12
Evidence: screenshot + form summary

Approve once / Deny
```

Avoid low-level prompts like:

```text
Execute action kind "submit"?
```

The runtime already has the data path for proposed action details. The next step is to make those details human-readable and site-specific.

## Important Non-Goals

Do not build these yet:

- a credential vault
- payment-method storage
- broad enterprise policy management
- generic network firewalling
- MCP marketplace positioning
- coding-agent GitHub permissions
- full browser sandboxing
- natural-language policy editor

Those may come later, but they distract from the sharp primitive.

## Recommended Immediate Work

1. Make `clickVisibleText()` use `wire.click`.
2. Add regression tests for sensitive label clicks through helpers.
3. Add a receipt summary builder from trace events.
4. Add finality fields to skill schema behind a conservative parser.
5. Add a small finality benchmark suite.
6. Update README positioning from "policy gates destructive ops" to "Wire gates final actions in browser sessions."

## Success Criteria

Wire should be able to demonstrate:

```text
Task: Find the best refundable flight under $600 and prepare booking.

Allowed:
- search flights
- filter results
- select itinerary
- fill passenger details
- reach review page

Gated:
- final purchase

Receipt:
- selected itinerary
- price
- constraints checked
- purchase not completed
- approval required at final button
```

And:

```text
Task: Use this logged-in admin portal to inspect user roles.

Allowed:
- navigate admin portal
- read user/role tables
- export summary artifact

Denied:
- invite user
- change role
- delete user

Receipt:
- pages visited
- table extracted
- denied role-change attempt if any
```

If Wire can do those reliably, it has a real product primitive independent of coding agents and credentials.

## Final Positioning

The shortest honest description:

> Wire lets AI agents use browsers without handing them unchecked final-action authority.

Slightly more concrete:

> Agents can browse, fill, and prepare. Wire gates submit, send, pay, delete, invite, and publish.

That is the durable idea.
