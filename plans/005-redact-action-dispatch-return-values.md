# Plan 005: Redact exec return values on the wireActions and raw dispatch paths

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8b84c05..HEAD -- src/agent/action-dispatch.ts src/shared/redact.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: security
- **Planned at**: commit `8b84c05`, 2026-07-17

## Why this matters

Wire redacts secrets from trace events before they are persisted to
`~/.wire/state` and streamed to consumers (including the web console). The
main exec path does this (`src/agent/loop.ts` wraps its `code-result` payload
in `redactJsonObject(...)`), and even the `code-exec` event inside
`action-dispatch.ts` does it — but the two `code-result` events built in
`src/agent/action-dispatch.ts` do NOT. Their `returnValue` is whatever the
LLM-authored page code produced (commonly DOM-scraped content: tokens, session
values, form-field contents), so secrets can land on disk and in the console
stream unredacted. This closes the gap so all three exec-result emitters
redact identically.

## Current state

- `src/agent/action-dispatch.ts` — helpers for dispatching CDP commands that
  the agent's page code requested (a `wireActions` envelope in the exec
  return value, or a raw-CDP command list). Already imports the redaction
  helper at line 4: `import { redactJsonObject } from "../shared/redact.js";`

- Unredacted site 1 — `executeWireActionsEnvelope`, lines 151–165:

  ```ts
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "code-result",
    payload: {
      ok: result.ok,
      durationMs: Date.now() - cdpStart,
      source: "wireActions",
      commandsExecuted: envelope.commands.length,
      commandsRequested: envelope.requested,
      truncated: envelope.requested > envelope.commands.length,
      returnValue: result.returnValue as JsonValue,
    },
  });
  ```

- Unredacted site 2 — `executeRawActionCommands`, lines 189–203 (same shape,
  `source: "raw"`, with a conditional `commandsExecuted` spread).

- The correct pattern, in the SAME file at lines 175–185 (the `code-exec`
  event): `payload: redactJsonObject({ ... })`. The main exec path in
  `src/agent/loop.ts` (search for `redactJsonObject(resultPayload)`) does the
  same. Match this pattern exactly.

- `src/shared/redact.ts` — `redactJsonObject(obj: JsonObject): JsonObject`
  recursively replaces matches of `SECRET_PATTERNS` in string values with
  `[REDACTED]`. Note both `returnValue` fields are typed `as JsonValue`; the
  surrounding payload object literal is a `JsonObject`, so wrapping the whole
  literal (not just `returnValue`) typechecks and also covers error-message
  strings that flow into `returnValue` on the failure path
  (`executeCdpCommands` returns `{ ok: false, returnValue: <error message> }`).

- How the dispatch reaches a provider (needed for the test): the internal
  `executeCdpCommands` (action-dispatch.ts:105–137) prefers a provider
  `rawBatch(sessionId, commands)` method when the envelope has multiple
  commands or `batchSingleCommand: true` (which `executeWireActionsEnvelope`
  always sets), and its resolved value becomes `returnValue` verbatim. So a
  fake provider exposing only `rawBatch` fully controls `returnValue`.

- `wireActionCommands` (action-dispatch.ts:85–103) accepts a return value of
  shape `{ wireActions: [{ method: string, params?: object }, ...] }` (object
  or JSON string), filters out `Runtime.evaluate`, and produces the commands.

- Repo conventions: tests are colocated `*.test.ts` using `node:test` +
  `node:assert` (run via `node --import tsx --test`). Redaction test fixtures
  exist in `src/agent/context.test.ts:118` ("assembleSystemPrompt redacts API
  keys") — reuse the same style of fake secret string used there rather than
  inventing a new one. Shared agent test fixtures live in
  `src/agent/fixtures.test.ts` — check it first for a `LoopState` builder and
  reuse it if one exists.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Full tests | `pnpm test` | all pass (959 at planning time) |
| Just this file's tests | `node --import tsx --test src/agent/action-dispatch.test.ts` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/agent/action-dispatch.ts` (two payload wraps)
- `src/agent/action-dispatch.test.ts` (create)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- `src/agent/loop.ts` — its exec path already redacts.
- `src/shared/redact.ts` — pattern coverage is not this plan's concern.
- `src/storage/**` — do not add redaction at the persistence layer; the
  repo's design redacts at event-construction sites.
- Already-persisted traces under `~/.wire/state` — out of reach of code.

## Git workflow

- Branch: `advisor/005-redact-action-dispatch-return-values`
- Conventional commit, e.g. `fix(agent): redact code-result payloads on wireActions and raw dispatch paths`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the failing tests (red)

Create `src/agent/action-dispatch.test.ts` (this repo practices TDD; see the
Test plan section for the cases). Use a fake provider object with a
`rawBatch` method and a minimal `LoopState` (reuse the fixture builder from
`src/agent/fixtures.test.ts` if present; otherwise build the smallest object
the functions touch: `run.id`, `sessionId`, `events: []` — cast via
`as unknown as LoopState` only if the existing tests do the same).

**Verify**: `node --import tsx --test src/agent/action-dispatch.test.ts` →
the redaction assertions FAIL (secrets present in the pushed event payloads).

### Step 2: Wrap both payloads (green)

In `src/agent/action-dispatch.ts`, wrap the two `code-result` payload object
literals in `redactJsonObject(...)`:

- `executeWireActionsEnvelope` (line ~156): `payload: redactJsonObject({ ok: result.ok, ... }),`
- `executeRawActionCommands` (line ~194): same wrap.

Change nothing else about the payload shape or field order.

**Verify**: `node --import tsx --test src/agent/action-dispatch.test.ts` →
all pass. `pnpm typecheck` → exit 0.

### Step 3: Full gate

**Verify**: `pnpm check` → exit 0, no other test regressed.

## Test plan

New file `src/agent/action-dispatch.test.ts`, `node:test` style, covering:

1. **wireActions path redacts**: call `executeWireActionsEnvelope(state,
   fakeProvider, { wireActions: [{ method: "Page.navigate", params: { url:
   "https://example.com" } }] })` where `fakeProvider.rawBatch` resolves to an
   object containing a secret-bearing string (same fake-secret style as
   `src/agent/context.test.ts:118`). Assert the pushed `code-result` event's
   `payload.returnValue` contains `[REDACTED]` and not the raw secret.
2. **raw path redacts**: call `executeRawActionCommands(state, fakeProvider,
   [{ method: "Network.getAllCookies" }, { method: "Page.reload" }])` (two
   commands so `rawBatch` is used) with the same secret-bearing resolution;
   same assertion on the `source: "raw"` `code-result` event.
3. **failure path redacts**: `rawBatch` rejects with an `Error` whose message
   contains the fake secret; assert the event's `payload.returnValue` has it
   redacted and `payload.ok === false`.
4. **Non-secret passthrough**: a plain return value (e.g. `{ title: "hello" }`)
   survives unchanged (guards against over-redaction).

Verification: `pnpm test` → all pass, including the 4 new tests.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "payload: redactJsonObject" src/agent/action-dispatch.ts` → 3 matches (the existing `code-exec` one plus the two new wraps)
- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm check` exits 0; `src/agent/action-dispatch.test.ts` exists with the 4 cases above passing
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The code at lines ~151–165 / ~189–203 no longer matches the excerpts.
- Wrapping the payload breaks typechecking in a way not fixable by keeping
  the object literal a plain `JsonObject` (e.g. someone changed the payload
  to a non-JSON type since planning).
- You find yourself wanting to modify `redact.ts` or `loop.ts` to make a
  test pass — that's out of scope; report instead.

## Maintenance notes

- Any future event-construction site whose payload can carry page-derived
  strings must wrap in `redactJsonObject` — this is a per-site convention,
  not enforced centrally. Reviewers should check for it whenever a new
  `state.events.push` appears.
- This fixes newly captured runs only; traces persisted before the fix may
  contain unredacted values (operator hygiene concern, not code).
- Deferred: a lint-style architecture check that flags `kind: "code-result"`
  pushes without redaction was considered and not planned — revisit if a
  third gap of this class appears.
