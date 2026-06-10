# Plan 001: CI enforces `pnpm check` on every push and pull request

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat a2c6f5c..HEAD -- .github/ package.json scripts/`
> If `package.json` scripts or `scripts/architecture-check.mjs` changed since
> this plan was written, re-read the "Current state" excerpts below and confirm
> the command names still match before proceeding. On a mismatch, treat it as a
> STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none (but see Maintenance notes — plan 002 fixes a test flake that can make this gate red intermittently; this plan pins test concurrency to neutralize that until 002 lands)
- **Category**: dx
- **Planned at**: commit `a2c6f5c`, 2026-06-10

## Why this matters

The repository has a complete local verification command — `pnpm check` runs the
architecture boundary check, the typechecker, and 927 tests — but nothing runs it
automatically. The only GitHub Actions workflow (`.github/workflows/docs.yml`)
deploys documentation and triggers only on `docs/**` changes. The project's own
alignment plan states the working mode is "every commit runs `pnpm check`," yet
that is currently honor-system: a contributor (or an automated commit) that skips
the local run can merge code that fails typecheck, breaks a test, or violates an
architecture import boundary, and nothing catches it. Adding a CI workflow makes
the existing quality bar self-enforcing on every push and pull request.

## Current state

- `.github/workflows/` contains exactly one file, `docs.yml` (docs deploy, triggers on `push` to `main` with `paths: docs/**`). There is **no** workflow that runs tests, typecheck, or the architecture check.
- `package.json` defines the verification scripts (do not change these):
  ```json
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "check": "pnpm run architecture && pnpm run typecheck && pnpm run test",
    "test": "node --import tsx --test 'src/**/*.test.ts'",
    "typecheck": "tsc --noEmit",
    "architecture": "node scripts/architecture-check.mjs"
  }
  ```
- Runtime/toolchain facts (from `package.json`): `"packageManager": "pnpm@10.33.0"`, `"engines": { "node": ">=22" }`, ESM (`"type": "module"`). The repo uses `tsx` to run TypeScript tests directly (no build step needed for `pnpm check`). A `pnpm-lock.yaml` exists at the repo root.
- Convention to match: the existing `docs.yml` uses `actions/checkout@v4`. Match that major version for consistency.

## Commands you will need

| Purpose            | Command                       | Expected on success                  |
|--------------------|-------------------------------|--------------------------------------|
| Install deps       | `pnpm install --frozen-lockfile` | exit 0                            |
| Full check (local) | `pnpm check`                  | architecture ok, typecheck 0 errors, all tests pass |
| Typecheck only     | `pnpm typecheck`              | exit 0, no output                    |
| Architecture only  | `pnpm architecture`           | exit 0                               |
| Tests only         | `pnpm test`                   | `pass 927 / fail 0` (count may grow) |
| YAML sanity        | `node -e "require('fs').readFileSync('.github/workflows/check.yml','utf8')"` | exit 0 (file readable) |

(Exact commands verified during recon at commit `a2c6f5c`.)

## Scope

**In scope** (the only files you should create/modify):
- `.github/workflows/check.yml` (create)
- `README.md` (optional: add a CI status badge — only if a badge section is natural; do not restructure the README)

**Out of scope** (do NOT touch):
- `.github/workflows/docs.yml` — unrelated docs-deploy workflow; leave it exactly as is.
- `package.json` scripts — the `check`/`test`/`typecheck`/`architecture` commands are correct and used locally; do not rename or modify them.
- `scripts/architecture-check.mjs` — the check logic is out of scope here.
- Any source file under `src/`.

## Git workflow

- Branch: `advisor/001-ci-check-pipeline`
- One commit. Message style is Conventional Commits (see `git log`: `feat(arch): enforce import-graph boundaries…`). Use: `ci: run pnpm check on push and pull request`.
- End the commit message with the repo's co-author trailer if one is in use (check recent commits); otherwise omit.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the CI workflow

Create `.github/workflows/check.yml` with the content below. It installs pnpm at
the pinned version, sets up Node 22 with pnpm caching, installs with a frozen
lockfile, and runs the full check. The test step pins single-file concurrency
(`--test-concurrency=1`) to neutralize the known timing flake (see plan 002)
without weakening coverage — every test still runs.

```yaml
name: Check

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Install pnpm
        uses: pnpm/action-setup@v4
        with:
          version: 10.33.0

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      - name: Architecture boundaries
        run: pnpm run architecture

      - name: Typecheck
        run: pnpm run typecheck

      - name: Tests
        run: node --import tsx --test --test-concurrency=1 'src/**/*.test.ts'
```

Note: the test step intentionally inlines the command (with `--test-concurrency=1`)
rather than calling `pnpm test`, so the concurrency pin lives only in CI and the
local `pnpm test` is unchanged. Do not edit the `test` script in `package.json`.

**Verify**: `node -e "const s=require('fs').readFileSync('.github/workflows/check.yml','utf8'); if(!/pnpm run architecture/.test(s)||!/pnpm run typecheck/.test(s)||!/--test/.test(s)) throw new Error('missing a check step'); console.log('ok')"` → prints `ok`

### Step 2: Confirm the commands the workflow runs actually pass locally

Run the same three gates the workflow runs, to prove the workflow will be green:

```
pnpm install --frozen-lockfile
pnpm run architecture
pnpm run typecheck
node --import tsx --test --test-concurrency=1 'src/**/*.test.ts'
```

**Verify**: each exits 0; the test command ends with a `fail 0` line.

### Step 3 (optional): Add a CI badge to the README

Only if the README already has a badge row or an obvious header spot. Add:
`[![Check](https://github.com/<owner>/<repo>/actions/workflows/check.yml/badge.svg)](https://github.com/<owner>/<repo>/actions/workflows/check.yml)`
Determine `<owner>/<repo>` from `git remote get-url origin`. If you cannot
determine it confidently, SKIP this step — it is optional.

**Verify**: `pnpm typecheck` still exits 0 (README change cannot affect this, but confirms you touched nothing else).

## Test plan

This plan adds CI configuration, not application code, so there are no new unit
tests. The verification is that the three existing gates pass under the exact
commands the workflow uses (Step 2). Do not add or modify any `*.test.ts` file.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `.github/workflows/check.yml` exists and references `pnpm run architecture`, `pnpm run typecheck`, and a `--test` invocation (Step 1 verify command prints `ok`).
- [ ] `pnpm run architecture` exits 0.
- [ ] `pnpm typecheck` exits 0.
- [ ] `node --import tsx --test --test-concurrency=1 'src/**/*.test.ts'` exits 0 with a `fail 0` summary line.
- [ ] `.github/workflows/docs.yml` is unchanged (`git diff --stat a2c6f5c..HEAD -- .github/workflows/docs.yml` shows no changes).
- [ ] No files under `src/` or `package.json` modified (`git status`).
- [ ] `plans/README.md` status row for 001 updated.

## STOP conditions

Stop and report back (do not improvise) if:

- `pnpm install --frozen-lockfile` fails because the lockfile is out of date — do NOT regenerate the lockfile; report it (it indicates an unrelated dependency drift).
- `pnpm run architecture` or `pnpm typecheck` fails on the clean checkout — the gate is already broken on `main`; report rather than "fixing" source to make CI green.
- The test command fails repeatedly even at `--test-concurrency=1` — that is a real test failure, not the flake plan 002 targets; report it.
- You discover an existing `.github/workflows/check.yml` (or similarly-named test workflow) already present — the gap may have been closed; report and stop.

## Maintenance notes

- Plan 002 investigates and fixes a timing flake in `src/agent/agent.test.ts` that surfaces only under CPU contention. Once 002 lands, the `--test-concurrency=1` pin in this workflow's test step can be relaxed to the default for faster CI; leave a comment in `check.yml` noting this link so a reviewer knows why the pin exists.
- A reviewer should confirm the pnpm version in the workflow (`10.33.0`) matches `packageManager` in `package.json`; if `package.json` bumps pnpm, this workflow must follow.
- If the test suite grows slow, splitting `check.yml` into parallel jobs (architecture / typecheck / test) is the natural next step — out of scope here.
