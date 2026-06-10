# Plan 002: Make the finish-error test deterministic under load (investigate then fix)

> **Executor instructions**: This is an INVESTIGATE-THEN-FIX plan. The root
> cause is not yet pinned down — your first job is to reproduce and diagnose,
> then apply the smallest fix that removes the nondeterminism without weakening
> the test's assertions. Run every verification command. If anything in the
> "STOP conditions" section occurs, stop and report — do not improvise a fix
> that changes what the test checks. When done, update the status row for this
> plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2c6f5c..HEAD -- src/agent/agent.test.ts src/agent/runtime.ts src/agent/loop-result.ts src/agent/loop.ts`
> If `src/agent/agent.test.ts` changed since this plan was written, re-read the
> "Current state" excerpt and locate the test by name before proceeding.

## Status

- **Priority**: P1
- **Effort**: S–M (mostly investigation)
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `a2c6f5c`, 2026-06-10

## Why this matters

A test in `src/agent/agent.test.ts` passes reliably when run in isolation but
failed intermittently when the full suite (`pnpm test`, which runs test files
concurrently via the Node test runner) was run on a CPU-saturated machine. The
observed failure was an assertion mismatch on the run's *result text*: the test
expects `result.run.result` to match `/Run stopped with error: Target not found:
page/u`, and under load it did not match. A flaky test erodes trust in the green
signal and, once CI exists (plan 001), will produce spurious red builds. The fix
is either a test-isolation correction (if the flake is cross-test interference)
or a small determinism fix in the result-derivation path (if a timer/async
ordering decides which text wins) — but only after the cause is confirmed.

## Current state

The test (around `src/agent/agent.test.ts:1715-1734`) drives `executeTask` with a
model callback that returns an `observe` action on step 0 and then **throws**
`new Error("Target not found: page")` on step 1, and asserts both that the run
failed with that error text and that a "Reached Booking.com…" note artifact
exists:

```ts
const result = await executeTask(
  task,
  { provider, policyEngine: createMockPolicyEngine(), maxSteps: 2 },
  async (state) => {
    if (state.stepCount === 0) {
      return { kind: "observe", summary: "Check booking results" };
    }
    throw new Error("Target not found: page");
  },
);

assert.equal(result.run.status, "failed");
assert.match(result.run.result ?? "", /Run stopped with error: Target not found: page/u);
const noteArtifact = result.events.find((event) =>
  event.kind === "artifact" &&
  event.payload.kind === "note" &&
  typeof event.payload.content === "string"
);
assert.ok(noteArtifact);
assert.match(String(noteArtifact.payload.content ?? ""), /Reached Booking\.com search results/u);
```

Relevant facts for diagnosis:
- The run's result text is produced by `deriveRunResult(events, mode)` in `src/agent/loop-result.ts:101`. For `mode === "task"` it **prefers the progress ledger, then code-results, then a non-`task-summary` note artifact** over other text. The error string `"Run stopped with error: …"` is set on `run.result` somewhere in the failure/finalize path (search `runtime.ts` / `loop.ts` for `Run stopped with error`).
- The competing text is the note artifact content "Reached Booking.com search results" (a `task-summary`-style note). If the result-precedence logic resolves to the note instead of the error string under some ordering, the assertion fails.
- The Node test runner executes **test files** concurrently (default concurrency = CPU count). Within a file, tests run in order. So a flake that only appears in the full suite but not in isolation is either (a) timing-sensitive logic, or (b) shared mutable module-level state across concurrently-running files.

## Commands you will need

| Purpose                  | Command                                                                 | Expected on success |
|--------------------------|-------------------------------------------------------------------------|---------------------|
| Run this file in isolation | `node --import tsx --test src/agent/agent.test.ts`                     | `fail 0`            |
| Run full suite           | `pnpm test`                                                             | `pass N / fail 0`   |
| Reproduce under load     | see Step 1                                                              | a failure appears   |
| Typecheck                | `pnpm typecheck`                                                        | exit 0              |

## Scope

**In scope** (depends on the diagnosis — modify only what the cause requires):
- `src/agent/agent.test.ts` — if the cause is test isolation (shared state, missing reset, order assumption).
- `src/agent/loop-result.ts` and/or the failure-finalize path in `src/agent/runtime.ts` or `src/agent/loop.ts` — ONLY if the diagnosis proves the *product code* nondeterministically chooses between the error text and a note artifact. A test that flakes because production logic is order-dependent is a product bug; fixing the test alone would mask it.

**Out of scope** (do NOT touch):
- Any other `*.test.ts` file unless Step 2 proves it is the source of cross-file interference (then the minimal reset there is in scope, but report it first).
- Broad refactors of `deriveRunResult` — only a targeted determinism fix if warranted.
- Disabling, skipping, or adding retries to the test. A `.skip`, `t.skip`, or retry wrapper is NOT an acceptable fix.

## Git workflow

- Branch: `advisor/002-fix-flaky-finish-error-test`
- One commit. Conventional Commits style. Likely `fix(agent): make finish-error result derivation deterministic` (if product fix) or `test(agent): isolate finish-error test from cross-file state` (if test fix). Choose based on the actual cause.
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Reproduce the flake

Run the full suite under artificial CPU contention repeatedly. On most machines
the flake appears within ~20 runs when the box is loaded:

```
for i in $(seq 1 30); do
  node --import tsx --test 'src/**/*.test.ts' > /tmp/flake-$i.out 2>&1
  grep -q "Target not found: page" /tmp/flake-$i.out && grep -q "did not match" /tmp/flake-$i.out \
    && echo "run $i: FLAKED" || echo "run $i: ok"
done
```

If it does not reproduce, raise contention: run the loop while a `yes > /dev/null
&` (or several) burn CPU in the background; kill them after (`kill %1 …`). Capture
the failing `/tmp/flake-*.out` — the "Input:" line in the assertion error shows
what `result.run.result` actually was (the error string truncated? the note
content? empty?). **This captured actual value is the key to the diagnosis.**

**Verify**: you have at least one captured failure showing the actual `result.run.result` value, OR after a determined effort (≥60 loaded runs) you cannot reproduce — in which case go to the STOP conditions.

### Step 2: Diagnose — which class is it?

From the captured actual value:
- **If `result.run.result` was the note content** ("Reached Booking.com…") or empty: the failure path's result-precedence is racing with note-artifact creation/flush. This is a **product** determinism issue in the failure-finalize → `deriveRunResult` path. Trace where `run.result` is set on the error path and why a note can win.
- **If the error string was present but truncated/reworded**: the error message is being post-processed nondeterministically; find that.
- **If a *different test file's* state leaked** (e.g., a module-level counter, a shared mutable singleton, an env var set by another test and not reset): this is **test isolation**. Grep for module-level `let`/mutable singletons touched by tests; confirm with `node --import tsx --test src/agent/agent.test.ts src/<suspect>.test.ts` (two files together) reproducing it.

Write down the confirmed cause before writing any fix.

**Verify**: you can state, in one sentence, the exact mechanism that makes the result text nondeterministic, with a `file:line` reference.

### Step 3: Apply the smallest fix for the confirmed cause

- Product determinism: make the failure path set/choose the result text deterministically (e.g., the error string always wins over a `task-summary` note on a failed run — mirror the existing `task-summary` exclusion already present in `deriveRunResult` at `loop-result.ts:157-166`). Keep the test's assertions unchanged.
- Test isolation: reset the leaked state in a `beforeEach`/`afterEach` or stop the cross-file leak at its source. Keep the test's assertions unchanged.

**Verify**: re-run the Step 1 reproduction loop (≥30 loaded runs) → every run prints `ok`.

### Step 4: Confirm no regression

**Verify**:
- `node --import tsx --test src/agent/agent.test.ts` → `fail 0`
- `pnpm test` → `fail 0`
- `pnpm typecheck` → exit 0
- `pnpm run architecture` → exit 0

## Test plan

- No new test is required if the existing test now passes deterministically; the existing assertions already cover the behavior.
- If the cause was a product determinism bug, ADD one focused unit test in `src/agent/loop-result.test.ts` (it exists — model the new case after its neighbors) asserting that on a failed run, an error-result string is chosen over a `task-summary` note artifact regardless of event order. Run: `node --import tsx --test src/agent/loop-result.test.ts` → all pass including the new case.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] The Step 1 reproduction loop (≥30 runs under load) shows zero `FLAKED` lines.
- [ ] `node --import tsx --test src/agent/agent.test.ts` exits 0.
- [ ] `pnpm test` exits 0 (`fail 0`).
- [ ] `pnpm typecheck` exits 0 and `pnpm run architecture` exits 0.
- [ ] The test's assertions in `agent.test.ts` are unchanged (no skip, no retry, no weakened regex) — `git diff a2c6f5c..HEAD -- src/agent/agent.test.ts` shows only isolation/setup changes if any.
- [ ] If a product fix was made, a regression test exists in `src/agent/loop-result.test.ts`.
- [ ] `plans/README.md` status row for 002 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- You cannot reproduce the flake after ≥60 loaded runs — report this; the fix may be unjustifiable without a confirmed cause, and forcing one risks masking nothing or breaking the test.
- The diagnosis points to a product determinism bug whose correct fix would change the run's *status* or *result semantics* for failed runs (not just the text precedence) — that is a larger behavioral decision; report it.
- The only way you can make it pass is to skip the test, add a retry, or relax the assertion — none of these are acceptable; report instead.
- Fixing it appears to require touching files outside the In-scope list.

## Maintenance notes

- Plan 001's CI workflow pins `--test-concurrency=1` to dodge this flake. Once this plan lands and `pnpm test` is green under default concurrency repeatedly, a follow-up can remove that pin from `.github/workflows/check.yml`.
- If the cause was cross-file shared state, a reviewer should look for the same pattern elsewhere (other module-level mutable singletons touched by tests) — note any found as a follow-up, do not fix them here.
