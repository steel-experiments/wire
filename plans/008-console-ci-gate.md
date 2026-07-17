# Plan 008: Gate the console app in CI (typecheck, tests, build)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8b84c05..HEAD -- .github/workflows/check.yml console/package.json`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. (Exception: plan 004 legitimately
> adds `hls.js` to `console/package.json` — that change is expected.)

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/004-fix-root-deps-and-lockfiles.md (console/bun.lock must contain `hls.js`, or the frozen install below fails)
- **Category**: dx / tests
- **Planned at**: commit `8b84c05`, 2026-07-17

## Why this matters

`console/` is a shipped Bun + Hono + React app with six server test files and
its own typecheck and build — none of which run anywhere in CI. The root
`pnpm check` and the `Check` workflow are scoped to `src/` only. This is how
two audited defects went unnoticed: a dependency (`hls.js`) used by the
console but declared in the wrong manifest, and a broken CI install that sat
red for two weeks. With console slices still to build (approvals UI, record
view), every further slice compounds risk on an unverified base. This plan
adds a CI job so console regressions block PRs like core ones do.

## Current state

- `.github/workflows/check.yml` — single job `check`: checkout,
  `pnpm/action-setup@v4` (version 10.33.0), `actions/setup-node@v4`
  (node 22, pnpm cache), `pnpm install --frozen-lockfile`, then
  `pnpm run architecture`, `pnpm run typecheck`, `pnpm test`. Triggers:
  `push: branches: [main]` and `pull_request`. `permissions: contents: read`.

- `console/package.json` scripts (relevant): `"test": "bun test server/"`,
  `"typecheck": "tsc --noEmit"`, `"build": "vite build"`. Lockfile:
  `console/bun.lock` (Bun is the console's package manager; the root uses
  pnpm — do not mix them).

- `console/CLAUDE.md` records the console as deliberately OUTSIDE the root
  `src/` LOC budgets and `scripts/architecture-check.mjs` — do not extend
  the architecture script to it; the CI job is the whole ask.

- Local baselines verified at planning time (Bun 1.3.9): typecheck exit 0,
  `bun test server/` 15 pass / 0 fail, build not run but `console/dist` is
  gitignored. If plan 007 landed first, the test count is ≥21.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Local parity (from `console/`) | `bun install --frozen-lockfile && bun run typecheck && bun test server/ && bun run build` | all exit 0 |
| Workflow syntax | `actionlint .github/workflows/check.yml` (only if `actionlint` is installed — check with `which actionlint`; otherwise skip) | no findings |

## Scope

**In scope** (the only files you should modify):
- `.github/workflows/check.yml`
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- `scripts/architecture-check.mjs` — console exclusion is by-design.
- Root `package.json` `check` script — keep `pnpm check` core-scoped; CI is
  the console's gate. (Chaining bun into the pnpm script would force every
  core contributor to install Bun.)
- `console/**` — no app changes; if its checks fail in CI, that's a STOP.
- `.github/workflows/docs.yml`.

## Git workflow

- Branch: `advisor/008-console-ci-gate`
- Conventional commit, e.g. `ci: gate console typecheck, tests, and build`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the console job

In `.github/workflows/check.yml`, add a second job alongside `check` (same
triggers, no `needs:` — let them run in parallel):

```yaml
  console:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: console
    steps:
      - uses: actions/checkout@v4

      - name: Setup Bun
        uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.9

      - name: Install dependencies
        run: bun install --frozen-lockfile

      - name: Typecheck
        run: bun run typecheck

      - name: Tests
        run: bun test server/

      - name: Build
        run: bun run build
```

Match the existing file's step-name style (`Install dependencies`,
`Typecheck`, `Tests`). Pin `bun-version` to the version verified locally
(1.3.9) rather than `latest` — the repo pins pnpm the same way.

**Verify**: YAML is well-formed — `actionlint` if available; otherwise
`node -e "process.exit(0)"` is NOT sufficient, so at minimum re-read the
file and diff indentation against the existing job (GitHub YAML is
indentation-fatal). If `gh` is available and the operator allows pushing a
branch, the real verification is the PR run; otherwise rely on Step 2.

### Step 2: Local parity run

Run exactly what CI will, from `console/`:

**Verify**: `bun install --frozen-lockfile && bun run typecheck && bun test server/ && bun run build` → every command exits 0. If
`bun install --frozen-lockfile` fails, plan 004 has not landed — STOP
(dependency not met).

## Test plan

No new tests — this plan makes EXISTING console tests (and typecheck/build)
enforced. The gate proves itself on the first PR that runs it.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/check.yml` contains a `console` job with the five steps above
- [ ] `grep -n "working-directory: console" .github/workflows/check.yml` → 1 match
- [ ] Local parity commands (Step 2) all exit 0
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `bun install --frozen-lockfile` fails in `console/` (plan 004 not landed,
  or lockfile drift).
- Any console check fails locally — the job must land green; fixing console
  code is out of scope for this plan.
- The workflow file has structurally changed since planning (e.g. someone
  already added a matrix or a console job).

## Maintenance notes

- When console frontend tests arrive (audit finding #12, unplanned), widen
  the `Tests` step (`bun test` without the `server/` filter) in the same job.
- If the console ever gains a lint step, add it here — this job is the
  single gate for `console/`.
- Reviewer should scrutinize: the job does NOT use pnpm/node-cache steps
  (Bun app), and `bun-version` is pinned.
