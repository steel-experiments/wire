# Embedded Mode

Embedded mode runs Wire **unattended, as a tool called by another program** — for
example a deep-research agent that escalates a single hard URL (an auth wall, a
JavaScript-rendered page, pagination) to Wire and gets extracted content back.

The attended CLI assumes a human is present to approve gated actions, read the
summary, and run one task at a time. Embedded mode flips those assumptions:
unattended, multi-tenant, contract-driven.

## Entry point

```ts
import { runEmbedded } from "wire/embedded";
import { createSteelProvider } from "wire/providers/steel";
import { createOpenAIProvider } from "wire/providers/openai";
import { z } from "zod";

const result = await runEmbedded(
  { url: "https://dashboard.example.com/invoices", objective: "read the latest invoice total", extract: "invoice total and date" },
  {
    provider: createSteelProvider(),
    llmProvider: createOpenAIProvider(),
    outputSchema: z.object({ total: z.number(), date: z.string() }),
    maxWallClockMs: 120_000,
  },
);

if (result.classification.kind === "task-complete") {
  console.log(result.data);          // { total, date } — validated
  console.log(result.provenance);    // { url, artifactIds, sourceEventId }
}
```

`runEmbedded` is a thin wrapper over `executeTask` that applies the
unattended-safe defaults and shapes a trimmed, typed result. The same behavior
is available on `executeTask` directly via the `RuntimeConfig` fields below.

## What embedded mode changes

| Concern | RuntimeConfig field | Embedded default | Why |
|---|---|---|---|
| Approval gates | `onApprovalRequired` | `"deny"` | No human is present; a gated action ends the run as `blocked-policy` instead of hanging on `awaiting-approval`. `"allow"` auto-grants; `"pause"` is the CLI behavior. |
| Skill writes | `skillPromotion` | `"off"` | A successful run won't mutate the shared skill store. Skill **loading** still works — embedded runs benefit from skills read-only. |
| Wall-clock | `maxWallClockMs` | unset | A hard deadline aborts the run through the cancel path; outcome is `partial-success` (with a result) or `infra-error`. |
| Output shape | `outputSchema` | unset | The result must validate against the schema; a non-conforming finish is rejected and the agent reprompted (bounded). A run that never conforms is `ambiguous`. |

## Outcomes a caller branches on

`runEmbedded` never throws for an unsatisfiable task — it returns a
`classification`. The taxonomy tells the parent what to do next:

- `task-complete` / `partial-success` — use `result.data` (and `provenance`).
- `blocked-policy` — the task needed an approval-gated action; escalate to a human path.
- `blocked-auth` — a login/captcha wall; supply a profile and retry.
- `site-error` / `infra-error` — transient; retry or fall back to a plain fetch.
- `ambiguous` — output didn't match the schema, or evidence was insufficient.

## Concurrency

`executeTask` holds no process-global state, and embedded runs default to
`skillPromotion: "off"`, so multiple `runEmbedded` calls run concurrently in one
process without interference. **If you enable skill promotion**, give each
concurrent run its own `skillDir` — the file-backed skill store has no
cross-process lock, so concurrent writers against one directory can race.

To avoid cold-booting Chrome per call, pass a shared `existingSession` (with
`releaseExistingSessionOnExit: false`) so the parent owns the session lifecycle.

## See also

- [Agent Runtime](agent-runtime.md) — the loop `runEmbedded` drives.
- [Policy Engine](policy-engine.md) — what `require-approval` gates and how `onApprovalRequired` resolves it.
