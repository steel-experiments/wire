# Wire Codebase Simplification Report

**Date:** 2026-04-25
**Method:** 7 parallel agents audited ~13.5K lines across ~70 files against MANIFESTO.md and SPECS.md

## Overall Verdict

The codebase is well-aligned with manifesto principles. Clean module boundaries, near-zero dependencies (only `zod`), no hidden retries, no prompt soup, no circular dependencies. The issues found are mostly **accumulation of dead code**, **minor boundary violations**, and **a few spots where logic leaked into the wrong layer**.

---

## CRITICAL (violates manifesto/spec principles)

| # | Issue | Location | Fix |
|---|-------|----------|-----|
| 1 | **ArtifactRegistry conflates storage with trace** | `src/trace/artifacts.ts:14-43` | Move to `storage/artifacts.ts`. Traces should reference artifact IDs, not manage storage. Violates "Separate what must not be mixed." |
| 2 | **Policy enforcement embedded in runtime** | `src/agent/runtime.ts:172-233` | Policy checks should be middleware outside the reasoning loop. Runtime calls `policyEngine.check()` directly. |
| 3 | **CLI contains business logic** | `src/cli/main.ts:16-72`, `src/cli/runner.ts:137-306` | Result derivation and experiment orchestration live in CLI. Move to their respective domain modules. |

## HIGH (dead code / unnecessary complexity)

| # | Issue | Location | Fix |
|---|-------|----------|-----|
| 4 | **checkpoints.ts is unused** | `src/storage/checkpoints.ts` | Delete entirely. Speculative infrastructure not used anywhere. |
| 5 | **custom.ts is an empty stub** | `src/providers/browser/custom.ts` | Remove or replace with documentation. Throws "not implemented" for every method. |
| 6 | **Empty logging.ts** | `src/shared/logging.ts` | File contains only `export {}`. Remove. |
| 7 | **skill-proposal event kind defined but never emitted** | `src/shared/types.ts:28-39`, `src/trace/events.ts:125-134` | Remove dead event kind and `skillProposalEvent` function until actually needed. |
| 8 | **describeTarget never used** | `src/browser/targets.ts:18-33` | Remove unused function. |

## MEDIUM (over-abstraction / boundary drift)

| # | Issue | Location | Fix |
|---|-------|----------|-----|
| 9 | **shared/types.ts is 329 lines mixing domain + boundary types** | `src/shared/types.ts` | Split: core domain types (Task, Run, Profile) vs. boundary schemas. Types are growing into a grab-bag. |
| 10 | **atomic.ts over-engineered for file ops** | `src/storage/atomic.ts` | Most functions can be replaced with direct Node.js file ops. Keep atomic write, simplify the rest. |
| 11 | **Navigation detection logic in runtime** | `src/agent/runtime.ts:319-346`, `NAVIGATION_PATTERNS` at :413-422 | Belongs in browser bridge layer, not agent runtime. |
| 12 | **Duplicated observation recording** | `src/agent/runtime.ts:513-528` and `:629-644` | Extract a shared `createObservationPayload` utility. |
| 13 | **state-helpers.ts has repetitive query functions** | `src/agent/state-helpers.ts:8-53` | `latestObservation`, `latestError`, `latestCodeResult` all do the same reverse-array pattern. One generic helper. |
| 14 | **Zod used for internal validation in policy** | `src/policy/` | Spec says "validate at boundaries only." Internal policy rules don't need schema validation. |
| 15 | **Spec drift: extra classification types** | `src/shared/types.ts` | `browser-crash`, `captcha`, `rate-limited`, `network-timeout` added beyond spec's RunClassification. Justify or align. |

## LOW (nice-to-have cleanup)

| # | Issue | Location | Fix |
|---|-------|----------|-----|
| 16 | **session.ts overly trivial** | `src/browser/session.ts:8-27` | 3 lines of logic just delegating to provider. Consider inlining. |
| 17 | **displaySafeUrl hardcodes "apiKey"** | `src/browser/session.ts:34-43` | Brittle. Should be configurable or more generic. |
| 18 | **skill loader API surface too wide** | `src/skills/loader.ts` | Too many similar functions. Consolidate. |
| 19 | **Legacy config fields add complexity** | `src/cli/config.ts:34-65` | Multiple ways to specify LLM config. Deprecate root fields in favor of `llm` object. |
| 20 | **Missing secret patterns in redact.ts** | `src/shared/redact.ts` | No AWS keys (`AKIA[0-9A-Z]{16}`), service account tokens (`ya29.[a-zA-Z0-9_-]{100,}`), Firebase keys (`AIza[0-9A-Za-z_-]{35}`). |
| 21 | **runtime.ts at 755 lines** | `src/agent/runtime.ts` | Getting large. Monitor and split if it crosses ~1000 lines. |

---

## What's Working Well

- **Zero framework weight** — no hidden abstractions, direct provider delegation
- **No hidden retries** — Steel provider retry logic is visible and logged
- **Clean dependency graph** — acyclic, no boundary violations between major layers
- **Helpers are properly thin** — return code strings for `browser.exec()`, not DSL functions
- **Profiles properly separated** — identity vs execution per manifesto principle 5
- **Traces truly immutable** — all event creators return new objects
- **Experiments are first-class** — full hypothesis/ablation/summary implementation
- **Only `zod` as runtime dep** — exactly what the spec allows

## Top 5 Actions by Impact

1. Move `ArtifactRegistry` from `trace/` to `storage/` (fixes critical boundary violation)
2. Extract policy checks out of agent runtime into middleware (restores "policy outside the loop")
3. Delete `checkpoints.ts`, `custom.ts` stub, empty `logging.ts` (removes dead weight)
4. Move result derivation and experiment logic out of CLI (fixes CLI boundary violation)
5. Split `shared/types.ts` into domain vs. boundary types (reduces grab-bag accumulation)

---

## Agent Audit Coverage

| Agent | Domain | Files Audited | Status |
|-------|--------|---------------|--------|
| agent-core | `src/agent/` | runtime, loop, context, planning, classify, branching, state-helpers, llm-parse + tests | Complete |
| browser-reviewer | `src/browser/` | bridge, observe, exec, raw, session, targets, helpers/* + tests | Complete |
| policy-skills | `src/policy/` + `src/skills/` | engine, rules, approvals, loader, parser, matcher, promote + tests | Complete |
| trace-experiments | `src/trace/` + `src/experiments/` | events, artifacts, compare, replay, hypotheses, ablations, summaries + tests | Complete |
| storage-providers | `src/storage/` + `src/providers/` | tasks, runs, artifacts, sessions, events, approvals, atomic, checkpoints, openai, anthropic, steel, custom + tests | Complete |
| shared-cli | `src/shared/` + `src/cli/` + `src/profiles/` | types, ids, logging, schemas, redact, main, args, config, runner, auth, select + tests | Complete |
| cross-cutting | All modules | package.json, import graphs, cross-module patterns, dependency analysis | Complete |
