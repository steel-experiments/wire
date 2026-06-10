# Plan 003: Close the browser session when the `onSessionCreated` hook throws

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If
> anything in the "STOP conditions" section occurs, stop and report — do not
> improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2c6f5c..HEAD -- src/agent/runtime.ts src/agent/startup-failure.ts src/browser/session.ts`
> If `src/agent/runtime.ts` changed since this plan was written, compare the
> "Current state" excerpt against the live code at the cited lines before
> proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `a2c6f5c`, 2026-06-10

## Why this matters

In `executeTask`, a browser session is created and then a caller-supplied
`onSessionCreated` hook is awaited. If that hook throws, the `catch` returns a
startup-failure result **without stopping the session that was just created** —
the cloud browser session is orphaned and stays open until it times out
server-side, wasting a paid resource and potentially counting against a
concurrent-session limit. The normal teardown path (`stopBrowserSession`) is
only reached inside `executeWithState`, which this error path never enters. The
fix is to stop the session in the `catch` before returning, but only when the
session was actually created (so a failure inside `createBrowserSession` itself,
where there is nothing to close, is unaffected).

## Current state

`src/agent/runtime.ts:198-210` (inside `executeTask`):

```ts
    let session: BrowserSession;
    if (config.existingSession) {
      session = config.existingSession;
    } else {
      try {
        session = await createBrowserSession(config.provider, config.sessionInput);
        await config.onSessionCreated?.(session);
      } catch (err) {
        return await createStartupFailureResult(task, config, err);
      }
    }

    return await executeWithState(task, config, turn, session, undefined, undefined, registry);
```

The bug: when `createBrowserSession` (line 203) succeeds but `config.onSessionCreated?.(session)`
(line 204) throws, control jumps to the `catch` (line 205), which returns
`createStartupFailureResult(...)` — `session` is never passed anywhere that calls
`stopBrowserSession`, so it leaks. When `createBrowserSession` *itself* throws,
there is no session to close and behavior must stay the same.

Supporting facts (already verified, for your fix):
- The session-close API is `stopBrowserSession(provider, sessionId)`:
  `src/browser/session.ts:11` — `export async function stopBrowserSession(provider, sessionId: SessionId)` → `return provider.stopSession(sessionId)`.
- It is already imported in `runtime.ts:24`: `import { createBrowserSession, stopBrowserSession } from "../browser/session.js";` — no new import needed.
- `BrowserSession` has an `id: SessionId` field (`src/shared/types.ts:129-130`). So the call is `stopBrowserSession(config.provider, createdSession.id)`.
- The normal teardown does the same call at `runtime.ts:862`, wrapped in its own try/catch so a stop failure does not mask the real outcome — match that defensive shape.
- `createStartupFailureResult(task, config, err)` (`src/agent/startup-failure.ts:7`) builds the failure `LoopResult`; it does not and should not stop sessions.

## Commands you will need

| Purpose    | Command                                                  | Expected on success |
|------------|----------------------------------------------------------|---------------------|
| Typecheck  | `pnpm typecheck`                                         | exit 0, no errors   |
| This file's tests | `node --import tsx --test src/agent/runtime.test.ts` | all pass        |
| Full tests | `pnpm test`                                              | `fail 0`            |
| Architecture | `pnpm run architecture`                                | exit 0              |

## Scope

**In scope** (the only files you should modify):
- `src/agent/runtime.ts` — the `try/catch` block at lines 198-208.
- `src/agent/runtime.test.ts` — add the regression test (this file exists; confirm with `ls src/agent/runtime.test.ts`). If the existing `executeTask` tests live in `src/agent/agent.test.ts` instead, add the test there next to the other `onSessionCreated` / startup tests — search both for the closest existing pattern and follow it.

**Out of scope** (do NOT touch):
- `src/agent/startup-failure.ts` — it correctly has no session responsibility; do not move teardown into it.
- The `config.existingSession` branch (line 199-200) — a caller-owned session must NOT be stopped here (it is the caller's to manage; the normal path guards this with `callerOwnsSession` at `runtime.ts:858`). Your fix must only stop a session this function created.
- The normal teardown at `runtime.ts:862` — unchanged.

## Git workflow

- Branch: `advisor/003-close-session-on-startup-hook-failure`
- One commit. Conventional Commits style (see `git log`). Use: `fix(agent): stop the browser session when onSessionCreated throws`.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Write the failing regression test first (TDD)

Add a test that drives `executeTask` with a provider whose `createSession`/session
creation succeeds, an `onSessionCreated` hook that throws, and a spy that records
whether the provider's `stopSession` was called. Model it on the nearest existing
test that already constructs a provider and uses `onSessionCreated` or asserts on
`stopSession` (search `src/agent/runtime.test.ts` and `src/agent/agent.test.ts`
for `onSessionCreated` and `stopSession`). The test asserts:
- the returned `result.run.status` is `"failed"` (startup failure), and
- the provider's `stopSession` was called exactly once with the created session's id.

**Verify**: `node --import tsx --test <the test file>` → the new test FAILS (stopSession was not called). This confirms the bug and that the test exercises the right path.

### Step 2: Fix the `catch` to stop a created session

Restructure the block so the created session is captured in a local before the
hook runs, and the `catch` stops it (only if it was created), defensively:

```ts
    let session: BrowserSession;
    if (config.existingSession) {
      session = config.existingSession;
    } else {
      let createdSession: BrowserSession | undefined;
      try {
        createdSession = await createBrowserSession(config.provider, config.sessionInput);
        session = createdSession;
        await config.onSessionCreated?.(session);
      } catch (err) {
        if (createdSession) {
          // The session was created before the failure (e.g. onSessionCreated
          // threw); stop it so it is not orphaned. A stop failure must not mask
          // the original startup error — mirror the normal teardown at the end
          // of executeWithState.
          try {
            await stopBrowserSession(config.provider, createdSession.id);
          } catch {
            // best-effort; the startup failure below is the reported outcome
          }
        }
        return await createStartupFailureResult(task, config, err);
      }
    }
```

Keep the rest of the function identical. Note `session` is still definitely
assigned on the success path (TypeScript: the `try` assigns `session` before the
hook; the `catch` always returns), so the later `executeWithState(... session ...)`
call needs no change.

**Verify**: `pnpm typecheck` → exit 0 (confirms `session` is still considered definitely-assigned and no type errors).

### Step 3: Confirm the test now passes and nothing regressed

**Verify**:
- `node --import tsx --test <the test file>` → all pass, including the new test.
- `pnpm test` → `fail 0`.
- `pnpm run architecture` → exit 0.

## Test plan

- New test in the file identified in Scope: "executeTask stops the created session when onSessionCreated throws" — asserts failed status and exactly one `stopSession(createdId)` call.
- Confirm an existing test still covers the case where `createBrowserSession` itself throws (no session created → `stopSession` must NOT be called). If none exists, add a second small case asserting `stopSession` was not called in that path, so the `if (createdSession)` guard is covered.
- Verification: `node --import tsx --test <the test file>` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0.
- [ ] The new regression test exists and passes; it fails if the fix is reverted (verified in Step 1).
- [ ] `pnpm test` exits 0 (`fail 0`).
- [ ] `pnpm run architecture` exits 0.
- [ ] `git diff a2c6f5c..HEAD --stat` shows only `src/agent/runtime.ts` and one test file modified — no other files.
- [ ] `plans/README.md` status row for 003 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- The code at `runtime.ts:198-210` does not match the "Current state" excerpt (drift) — the surrounding control flow may have changed and the fix shape may no longer apply.
- `createBrowserSession` returns something without an `id` field, or the provider has no `stopSession` — the assumptions in "Current state" are false.
- Making the test fail-first (Step 1) is not possible because some other mechanism already stops the session on this path — then the bug may already be fixed; report it.
- The fix appears to require changes to `startup-failure.ts` or the `existingSession` branch (both out of scope).

## Maintenance notes

- A reviewer should confirm the `existingSession` (caller-owned) branch is still never stopped by this code — orphan-cleanup must apply only to sessions this function created.
- If session creation later becomes a multi-step setup (e.g. session + profile attach), each created resource needs the same best-effort cleanup-on-failure; this fix covers only the single-session case present today.
