# Plan 006: Make skill-retirement streaks count only skill-fault outcomes and honor the fair-chance floor

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8b84c05..HEAD -- src/skills/stats.ts src/skills/skills.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `8b84c05`, 2026-07-17

## Why this matters

Wire retires "ineffective" generated skills: an active skill gets
`status: rejected` (dropped from matching) and a generated proposal file is
deleted from disk. One of the two triggers — the "recent failure streak" —
fires when a skill's last 3 loaded runs each ended in anything other than
`task-complete`. That counts outcomes that say nothing about skill quality:
`blocked-auth` (auth wall on the site), `blocked-policy` (policy denial),
`site-error` (target site down), `infra-error` (including LLM-provider 429s,
reclassified in commit e203e8a), `counterexample` (a *desired* outcome for
falsification tasks, scored 0.75), and `partial-success` (the expected end
state for watch/poll tasks). Three unlucky runs — say, one auth-wall day —
permanently deletes good site knowledge. It also bypasses the
`RETIRE_MIN_LOADS = 5` "fair number of chances" floor that the comment above
it promises: the streak path fires at 3 loads total. This plan narrows the
streak to skill-attributable failures and gates it behind the floor.

## Current state

- `src/skills/stats.ts` — skill usage stats and stats-driven retirement.
  Retirement block, lines 150–169:

  ```ts
  // Retirement floor: once a skill has had a fair number of chances and runs
  // that load it almost never complete, marking it rejected takes it out of
  // matching entirely (the loader filters rejected skills) instead of letting
  // it ride along forever at a score penalty.
  const RETIRE_MIN_LOADS = 5;
  const RETIRE_MAX_SUCCESS_RATE = 0.25;
  const RETIRE_RECENT_FAILURE_STREAK = 3;

  function hasRecentFailureStreak(stats: SkillStats): boolean {
    if (stats.recentRuns.length < RETIRE_RECENT_FAILURE_STREAK) return false;
    return stats.recentRuns
      .slice(-RETIRE_RECENT_FAILURE_STREAK)
      .every((sample) => sample.outcome !== "task-complete");
  }

  function shouldRetireIneffectiveSkill(stats: SkillStats): boolean {
    const poorLifetimeRate = stats.loadedCount >= RETIRE_MIN_LOADS &&
      skillSuccessRate(stats) <= RETIRE_MAX_SUCCESS_RATE;
    return poorLifetimeRate || hasRecentFailureStreak(stats);
  }
  ```

- `retireIfIneffective` (same file, lines 171–204) acts on the verdict:
  rewrites a generated skill's `status:` line to `rejected`, or `unlink`s a
  generated proposal file. Leave it unchanged.

- Outcomes come from `mergeStats` (same file, line 70):
  `run.outcome ?? (run.succeeded ? "task-complete" : "ambiguous")` — the raw
  `RunClassificationKind`. The full kind set (`src/shared/types.ts:13-22`):
  `task-complete | partial-success | blocked-auth | blocked-policy |
  site-error | agent-error | infra-error | counterexample | ambiguous`.

- Existing test asserting the CURRENT (too-broad) behavior:
  `src/skills/skills.test.ts:1640` — "updateSkillStatsFromRun retires
  generated skills after a recent failure streak". It seeds `loadedCount: 2`
  and recentRuns `[partial-success, agent-error]`, then records a
  `partial-success` run and asserts the skill file becomes
  `status: rejected`. Under the new policy this exact scenario must NOT
  retire (outcomes not all skill-fault, and loads below the floor), so this
  test must be UPDATED, not just kept passing.

- Neighboring tests to model after: `skills.test.ts:1583` (lifetime-rate
  retirement) and `skills.test.ts:1706` ("never retires authored skills").
  Tests are `node:test` + `node:assert`, colocated, writing skills into a
  tmp dir via `writeSkillStats`/`updateSkillStatsFromRun`.

## Decision being implemented (the policy)

A streak sample counts as a skill-fault only if its outcome is `agent-error`
or `ambiguous`. Everything else — environmental blocks (`blocked-auth`,
`blocked-policy`, `site-error`, `infra-error`), desired-or-acceptable ends
(`task-complete`, `counterexample`), and `partial-success` (legitimate final
state for watch-loop tasks; also a deliberate 0.55-scored semi-credit) —
resets/never contributes to the streak. Additionally the streak only
retires once `loadedCount >= RETIRE_MIN_LOADS`, honoring the documented
floor. The lifetime-rate path is unchanged.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 |
| Skills tests only | `node --import tsx --test src/skills/skills.test.ts` | all pass |
| Full gate | `pnpm check` | exit 0 |

## Scope

**In scope** (the only files you should modify):
- `src/skills/stats.ts` (streak predicate + floor gate + comment)
- `src/skills/skills.test.ts` (update the 1640 test, add new cases)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- `retireIfIneffective` file-rewriting/deletion mechanics.
- `skillSuccessRate`, `RETIRE_MAX_SUCCESS_RATE`, the lifetime-rate path.
- `src/skills/promote.ts`, `loader.ts` (shadowing/pruning are separate
  mechanisms).
- `src/agent/classify.ts` — outcome kinds are inputs here, not targets.

## Git workflow

- Branch: `advisor/006-skill-retirement-fault-streak`
- Conventional commit, e.g. `fix(skills): retirement streak counts only skill-fault outcomes and honors the min-loads floor`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Update and extend the tests (red)

In `src/skills/skills.test.ts`:

1. Rewrite the test at line 1640 so it still proves streak retirement works,
   but under the new policy: seed `loadedCount: 4` (so the recorded run makes
   5) and recentRuns `[agent-error, agent-error]`, record a run classified
   `agent-error`, assert `status: rejected`.
2. Add "environmental streak does not retire": `loadedCount: 5+`, recentRuns
   `[blocked-auth, site-error]`, record an `infra-error` run → skill file
   still `status: active`.
3. Add "fault streak below the floor does not retire": `loadedCount: 2`,
   recentRuns `[agent-error, agent-error]`, record an `agent-error` run →
   still `status: active`.
4. Add "counterexample runs do not retire": `loadedCount: 5+`, recentRuns
   `[counterexample, counterexample]`, record a `counterexample` run →
   still `status: active`.

Copy the fixture structure (frontmatter skill file + `writeSkillStats` +
`updateSkillStatsFromRun` + `readFile` assertion) from the existing 1640
test verbatim, changing only counts/outcomes/expectations.

**Verify**: `node --import tsx --test src/skills/skills.test.ts` → the new
assertions FAIL against current code (cases 2–4 currently retire), while
case 1's scenario passes trivially. That failure pattern confirms the tests
bite.

### Step 2: Implement the policy (green)

In `src/skills/stats.ts`:

```ts
// Only outcomes the skill can plausibly be blamed for count toward the
// streak: environmental blocks (auth walls, policy denials, site/infra
// errors), counterexamples (a desired outcome), and partial success (the
// expected end state for watch-loop tasks) say nothing about skill quality.
const STREAK_FAULT_OUTCOMES: ReadonlySet<RunClassificationKind> =
  new Set(["agent-error", "ambiguous"]);

function hasRecentFailureStreak(stats: SkillStats): boolean {
  if (stats.recentRuns.length < RETIRE_RECENT_FAILURE_STREAK) return false;
  return stats.recentRuns
    .slice(-RETIRE_RECENT_FAILURE_STREAK)
    .every((sample) => STREAK_FAULT_OUTCOMES.has(sample.outcome));
}

function shouldRetireIneffectiveSkill(stats: SkillStats): boolean {
  const poorLifetimeRate = stats.loadedCount >= RETIRE_MIN_LOADS &&
    skillSuccessRate(stats) <= RETIRE_MAX_SUCCESS_RATE;
  return poorLifetimeRate ||
    (stats.loadedCount >= RETIRE_MIN_LOADS && hasRecentFailureStreak(stats));
}
```

Import `RunClassificationKind` from `../shared/types.js` if not already
imported (check the file's existing imports). Keep the retirement-floor
comment at lines 150–153 and extend it with one line noting the streak is
fault-only. Match surrounding style (this file uses 2-space indent, no
semicolon omissions).

**Verify**: `node --import tsx --test src/skills/skills.test.ts` → all pass.

### Step 3: Full gate

**Verify**: `pnpm typecheck` → exit 0; `pnpm check` → exit 0. If OTHER test
files fail after this change, read them before touching anything: a failure
elsewhere means some test depended on the broad streak (drift since
planning) — that is a STOP condition, not a green-light to edit more files.

## Test plan

Covered in Step 1 — four cases: fault-streak-at-floor retires,
environmental streak doesn't, below-floor fault streak doesn't,
counterexample streak doesn't. Model after `skills.test.ts:1583-1706`.
Verification: `pnpm test` → all pass including the new/updated cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "STREAK_FAULT_OUTCOMES" src/skills/stats.ts` → declaration + use
- [ ] `node --import tsx --test src/skills/skills.test.ts` exits 0 with the 4 cases from Step 1 present (grep the test titles)
- [ ] `pnpm check` exits 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `stats.ts` lines 150–204 no longer match the "Current state" excerpt.
- Any test OUTSIDE `skills.test.ts` fails after Step 2.
- You discover the streak predicate is exercised anywhere besides
  `shouldRetireIneffectiveSkill` (grep first: `grep -rn hasRecentFailureStreak src/`
  should show exactly the definition and one call).

## Maintenance notes

- Policy knob for the future: if genuinely bad skills now linger too long
  (they only retire via the lifetime-rate path or a 3-run fault streak),
  consider counting *repeated* `partial-success` over a longer window — but
  check watch-loop task behavior first (`memory: watch-loop tasks end
  partial by design`; see `docs/` on watch mode).
- The `mergeStats` fallback maps legacy `succeeded: false` calls to
  `ambiguous`, which IS a fault outcome — intentional, since those callers
  predate classification kinds.
- Reviewer should scrutinize: the updated 1640 test still proves retirement
  CAN happen (don't let the suite lose its only positive streak case).
