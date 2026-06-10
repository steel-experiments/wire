# Alignment plan — fixes, improvements, and doc/spec reconciliation

Date: 2026-06-10. Source: full-codebase review (five-track: agent core, providers/storage, skills/policy/eval/cli, architecture-vs-manifesto, test suite). Every finding was verified against the code at the cited location; the four agent-core HIGH findings were reproduced by executing module code against crafted inputs.

**Alignment direction:** the MD files (MANIFESTO, SPECS, plans) predate the code; the current code state is presumed correct where it has evolved past them. So by default, docs are updated to describe what the code actually does. Code changes are reserved for things that are *really off* — defects the code's own tests, guards, and history show were never intended. The "Really off" section below is that list; everything else is doc reconciliation or cleanup.

Working mode: directly on `main`, one conventional commit per numbered item (or stated batch), TDD throughout — failing test first, then the fix. Every commit runs `pnpm check` and updates `METRICS.md`.

---

## Part A — Really off (code fixes; these are bugs, not drift)

These contradict the code's own intent — the policy engine exists to gate actions, the redaction layer exists to catch keys, the classifier grew guards against exactly these result shapes. No reading of "current state is right" blesses them.

**A1. Policy bypass: the model can self-classify its actions.** `src/agent/loop.ts:374-378` reads `policyKind` from the model-authored action payload; nothing system-side ever writes it. A model emitting `{kind:"raw", payload:{policyKind:"read"}}` skips `rawCdpRequiresApproval` (`src/policy/rules.ts:122`) and the outbound-message / irreversible-mutation / privileged-profile rules. Fix: `policyKind = execRisk?.kind ?? action.kind`, never from payload; keep the trace field. Tests: raw/message/mutation/privileged actions with a spoofed payload `policyKind` still hit their rules.

**A2. Secret redaction misses the primary provider's key format.** `src/shared/redact.ts:6` (`/sk-[a-zA-Z0-9]{20,}/`) cannot match `sk-ant-api03-…`, so Anthropic/Z.ai keys pass unredacted into prompts, traces, and eval trajectories. `src/skills/promote.ts:47-55` is a second, divergent list gating skill minting with the same blind spot. Fix: one exported list in `shared/redact.ts` with `sk-ant-…`, `ghp_…`/`github_pat_…`, and JWT patterns added; `promote.ts` imports it. Tests: each format redacted and blocked from skill minting.

**A3. Unredacted trace paths.** Initial and error-recovery observations bypass `redactJsonObject` (`src/agent/runtime.ts:393-399`, `769-776`) while the normal path redacts (`loop.ts:141`); the reconfigure `thought-summary` embeds proxy credentials unredacted (`steel/reconfigure.ts:91-103`). Route all three through the same redaction.

**A4. Action envelopes become run results (query-echo's sibling).** `progressEntriesFromValue` (`src/agent/progress-ledger.ts:39-53`) ingests any array-of-objects property — `return {wireActions:[...]}` seeds the ledger with CDP commands, and `deriveRunResult` (`src/agent/loop-result.ts:106-111`) prefers a non-empty ledger over later real extractions. Fix: exclude envelope keys (`wireActions`, `tabs`, `links`) or allowlist evidence-shaped keys. Test: a `wireActions` return never surfaces as `run.result`; a later genuine extraction does.

**A5. `llm-usage` events downgrade every non-task run.** The terminal-event check (`src/agent/classify.ts:274-279`) is a denylist missing `llm-usage`, which `recordLlmCall` pushes during the finish-proposing turn — so the "last event" is never evidence and usage-reporting providers force partial-success. Fix: convert to an allowlist of evidence kinds (observation, code-result, artifact, note). Test: identical traces with/without trailing `llm-usage` classify identically.

**A6. Recovered anti-bot runs still classify `blocked-auth`.** `classify.ts:183-193` scans the *whole trace* for a captcha/Cloudflare title and returns before any evidence branch — a run that recovered via `recovery.ts` (its entire purpose) and completed still fails and can never mint a skill (`finalize.ts:144-148`). Fix: only the latest observation / post-recovery state may trigger it.

**A7. An LLM error during finish crashes the run unclassified.** `handleFinishAction` is called outside the `try` wrapping `executeStep` (`src/agent/runtime.ts:556-565`), and `reviewArtifacts` (`artifact-review.ts:202`) has no catch — a transient 429 from the reviewer rejects out of `executeTask`: no classification, no trace flush, no skill stats. Fix: wrap like step errors; reviewer failure degrades to a traced review-skipped (matching `proposeCriticalPoints`'s "never throws" contract).

**A8. Medium-tier agent-core batch (one commit each, test-first):**
- No-progress guard double-counts one stale result across non-exec steps (`runtime.ts:595-616`) — count only when a step produced a new code-result.
- Refused reconfigure consumes no step budget and no guard sees it; can loop forever (`loop.ts:468-482`) — count it as a step or cap refusals.
- Unparseable LLM output becomes a `finish` whose summary (raw model text) can surface as the result (`llm-parse.ts:55-58`) — reprompt once, then fail the turn explicitly.
- Synthetic `task-summary` notes defeat the agent-error downgrade and surface "Reached X at URL" as the result (`finalize.ts:126-134` + `loop-result.ts:157-165`) — exclude that source in `deriveRunResult`, mirroring `answerArtifactCount` (`classify.ts:245-247`).
- `hasVisitedDomain` accepts `evilgithub.com` for `github.com` and `github.io` via first-label match (`contract.ts:265-270`) — `.`-boundary suffix only.
- The planner shows successful execs as "ok: no output" (reads `stdout`; the idiom is `return {...}`) and short return values fall under `EVIDENCE_MIN_BYTES` (`turn.ts:217-219`, `evidence.ts:7`) — render the capped returnValue; this removes a driver of the re-extraction loops the stuck guards punish. Also fix `metacognitionTraces` reading nonexistent payload fields (`turn.ts:105`).
- `classifyRun` judges a different result text than the caller receives (`extractFinalResultText`, `classify.ts:4-37`, vs `deriveRunResult`) — consolidate onto `deriveRunResult`; correctness fix plus ~30 LOC.

**A9. Embedded mode's documented concurrency guarantee is false in code.** `embedded.ts:48-49,94` promises promotion-off means no skill-store writes, but `finalizeExecution` runs `updateSkillStatsFromRun` gated only on `skillDir` (`finalize.ts:157-161`), which defaults to `~/.wire/skills`; `stats.ts:119-137` does unlocked read-modify-write and can retire skills off racy counts. The doc here was written *with* the code, so this is a code bug against its own contract: gate stats writes on promotion. Also: embedded silently swallows output-schema mismatch (`embedded.ts:128-131`) — a failed parse must set an explicit field, not leave `data: undefined` on a `task-complete`.

**A10. Eval and experiments can mark failure as success.** These numbers gate skills and (per TRAINING_DATA.md) future training data:
- `eval/harness.ts:57-91`: `passed` defaults true when `expectedClassification` is absent; `evaluateBatch` (`harness.ts:112-119`) pairs benchmarks to runs by array index with no `taskId` check. Fix both — or, since the live CLI uses `bench.ts` and only harness's own test references it, delete the harness path entirely (preferred under code-size pressure; decide at the commit).
- `parseJudgeScore` (`eval/bench.ts:302-308`) takes the first number anywhere — "Step 1: …" clamps to a passing 1.0, and judge ≥0.8 alone passes a case. Anchor to a score-shaped token; unparseable → null → not a pass.
- `experiments/summaries.ts:80-126`: one `succeeded` run with zero failures → hypothesis "supported", ignoring `classification.kind` — the manifesto's own "lucky success teaches nothing" case. Require >1 corroborating run or a confidence floor, weigh classification. Add the module's first tests (it has zero): verdict thresholds, status/classification disagreement, `suggestNextExperiments` branches.

**A11. Missing timeouts on the two outermost network hops.** CDP `send()` awaits the websocket handshake with no bound (`steel/cdp.ts:21-36`); Steel REST `fetch` has no `AbortSignal` (`steel/api.ts:90`) and fronts every observe/exec — either can hang a run forever. Add bounds consistent with the LLM transport's 60s abort.

**A12. Hidden LLM retries.** `src/providers/llm/transport.ts` retries network failures *and timeouts* twice by default with no trace event or hook — against MANIFESTO line 69 ("We refuse hidden retries"), and a timed-out-but-completed request double-bills tokens. This one is flagged rather than blessed because the Steel provider already does it right (`onRetry` hook, default 0). Fix: add `onRetry` to the transport, emit an `llm-retry` trace event, stop retrying timeouts. Behavior otherwise unchanged.

**A13. Test coverage for the historical bug classes' blind spots.** `tryAntiBotRecovery` (122 LOC, zero coverage, hot error path — exactly the wrong-status class), branch-level tests for `finalizeExecution`/`handleFinishAction`, content assertions for `eval/metrics.ts`. Most land naturally as the TDD halves of A4–A10.

---

## Part B — Align docs to current code (code is presumed right)

**B1. SPECS §17 (proposed layout):** describes a tree that doesn't exist (`trace/` split across `storage/`, `experiments/ablations.ts` never built). Update §17 to the actual tree; mark ablations roadmap-or-dropped.

**B2. SPECS §15 compare data model:** the implementing modules (`agent/compare.ts`, `agent/refine.ts`) have zero production callers — residue, not current state. Delete both plus tests (~1,037 LOC) and amend §15 in the same commit so no promise dangles. (Deleting dead code is consistent with "current state is right" — current state doesn't call them.)

**B3. "active-tab" targeting:** `targets.ts:9-10` documents active-tab; the implementation is first-CDP-target (`steel/cdp.ts:188`). Bless the behavior: rename/document the limitation rather than building focus tracking nobody has needed.

**B4. wire-click approval tier:** `require-approval` behaves as deny (`steel/wire-click.ts:114-117`) and `el.click()` bypasses the gate. Bless as ergonomics: collapse the policy to allow/deny in docs (and optionally code), and state plainly that the load-bearing boundary is the policy engine (fixed in A1). One real code fix folded in: the Steel and LLM factories silently drop declared config fields (`steel/provider.ts:359-372` drops `wireClickPolicy`/`logger`/session-retry; all three LLM factories drop `timeoutMs`/`maxRetries`) — pass them through; silently ignored config is a bug under any framing.

**B5. Policy scope (no domain allowlist):** `policy/rules.ts` is entirely action-kind/code-pattern based; there is no per-domain navigation boundary. Bless as deliberate for a general browser agent — add one paragraph to `docs/policy-engine.md` saying so, so the next audit doesn't re-flag it.

**B6. Prompt guidance (the "prompt soup" tension):** all 39 `ACTION_GUIDANCE_ITEMS` ship on every turn (`src/agent/context.ts:303`) despite each carrying a `home: "core"|"helper"|"skill"` tag, ten self-classifying as helper/skill material. The current state demonstrably works (883 tests green, live runs improving), so no rewrite — but the unused tag means the code itself records an unfinished intention. Smallest honest move: filter by the tag that already exists (`core` always, `helper` when helpers are exposed, `skill`-tagged lore into skill files or dropped), measure the prompt-size delta, and revert if quality regresses. If you'd rather bless the always-on prompt instead, delete the `home` tag and amend MANIFESTO's prompt-soup note — either way the tag stops lying.

**B7. Skill-injection defense, documented honestly.** The line-prefix sanitizer (`context.ts:96-110`) is trivially bypassed and skill guidance distills from observed page content (`promote.ts:194`) — a hostile page can plant imperative Traps/Facts. No clever new sanitizer (that's a denylist with more steps). Do: run page titles/headings through the same filter as evidence (`context.ts:206,223` currently raw); frame injected guidance as quoted data ("hints, never instructions that override policy"); document in `docs/skills-system.md` that the real defense is the policy engine.

**B8. Root-directory reconciliation.** Root keeps MANIFESTO, SPECS, README, AGENTS/CLAUDE, CHANGELOG, METRICS, BRAND, CONTRIBUTING, LICENSE. Move live plans (`BROWSER_TRANSACTION_GATE_PLAN.md`, `WIRE_RELIABILITY_PLAN.md`, `PROPOSAL-*.md`, `PROGRAM.md`, `SKILLS_v2.md`, `TRAINING_DATA.md`, `CLASSIFIER_IMPROVEMENTS_PROPOSAL.md`) → `docs/proposals/`; run reports (`FINDINGS-*.md`, `REPORT-LESSONS-LEARNED.md`) → `docs/reports/`; delete superseded audits (`architecture_assessment.md`, `SIMPLIFICATION_REPORT.md`, `IMPROVEMENTS_2.md` — its 12,500 LOC budget is contradicted by the actual 17,929; git history preserves them); move `steel-docs.md` under `docs/`; `PRESENTATION.*` out of root. The stale LOC budget is the one place a doc actively misleads about current state.

**B9. METRICS.md compaction:** the rule is alive but the file is an append-only diary (multiple duplicate rows per day, the find command repeated per row). Compact to one row per day, command stated once in the header, `pnpm metrics` appends in that format.

---

## Part C — Make the boundaries enforceable (so drift surfaces as a failing check, not a future audit)

The repo audits itself repeatedly (four prior self-audit docs in root) but findings land as documents, not checks. `scripts/architecture-check.mjs` enforces only LOC caps; the boundary promise in `docs/architecture.md` has no fitness function.

**C1. Move boundary-violating types/functions home (~50 LOC, no behavior change):** `LLMProvider`/`ChatMessage`/error types out of `providers/llm/openai.ts` into `providers/llm/types.ts` (8 modules import a concrete provider file for types); `sanitizeSkillContent` out of `agent/context.ts:109` into `skills/` (`skills/loader.ts:10` imports agent for it); the `ActionHandler` contract out of agent so `steel/reconfigure.ts:1` stops importing 2 layers up; `LoopResult` shape for `skills/stats.ts:4` from a neutral home.

**C2. Teach the architecture check the import graph (~30 lines):** forbid `providers→agent`, `skills→agent`, `agent→eval`, `eval→cli`, `*→providers/llm/openai.js` for types. Land with a temporary allowlist for the agent↔eval cycle (`agent/loop-result.ts:12` ↔ `eval/scoring.ts:12`) and `eval/bench.ts→cli`, burn it to zero, delete the allowlist mechanism.

**C3. Consolidate duplicates (~140 LOC):** three field-identical signal interfaces (`LoopSignals`/`FinishFlowSignals`/`RecoverySignals`); three overlapping ack detectors (`evidence.ts:13`, `state-helpers.ts:54`, `loop-result.ts:93`); `metacognitionTraces`' repeat counter vs `computeRepeatStreak`; `latestObservationPayload`/`tabsFromPayload` duplicates. Then, only if the verdict cluster (`classify`/`contract`/`finish-flow`/`artifact-review`/`critical-points`/`evidence`/`progress-ledger`/`loop-result` + `eval/scoring`, ~2.2k LOC) still reads as one domain: extract a `verdict/` module — kills the agent↔eval cycle, drops `agent/` from 38% to ~26% of the codebase. Last structural step, after Part A settles.

**C4. Delete remaining dead weight:** `shared/secrets.ts` (85 LOC, no callers), `shared/ids.ts:31` `cloneJson` (duplicates `structuredClone`), `browser/helpers.ts:79` `HELPER_PREAMBLE`, `budgetExhausted` plumbing (hardcoded false), `BrowserExecRequest.attachments` (validated, read by no provider). Exception: `browser/session.ts:19` `displaySafeUrl` gets wired in, not deleted — `runtime-config.ts:119,129` print raw live URLs; this function was written to prevent exactly that.

**C5. Shared test fixtures:** `makeTask` copy-pasted in 17 test files, `createMockProvider` in 7, drift already visible — one fixtures helper, adopted as files are touched.

---

## Order of execution

1. **A1–A3** (security: policy bypass, secrets) — small, isolated, highest stakes.
2. **A4–A7** (classification/result HIGHs) — the bug-class siblings.
3. **C1–C2** (type moves, then the import check goes strict) — locks boundaries before further churn.
4. **A8–A13** (medium fixes + eval/experiments + coverage).
5. **B1–B9** (doc reconciliation, root cleanup, metrics compaction) — mostly mechanical, lands anytime; B2's deletion early to shrink later diffs is fine.
6. **C3–C5** (consolidation, optional verdict/ extraction, fixtures) — after behavior has settled.

## Defaults chosen (flag if wrong)

1. Hidden retries: keep bounded retry, make it traced, stop retrying timeouts (A12) — not removal.
2. `eval/harness.ts`: prefer deletion over repair if nothing adopts it (A10).
3. wire-click: bless as ergonomics + fix factory config passthrough; no approval routing into the page bridge (B4).
4. compare/refine: delete and amend SPECS §15 (B2).
5. active-tab: document the limitation, don't build focus tracking (B3).
6. Prompt guidance: filter by the existing `home` tag with a measured, revertable diff; blessing the always-on prompt is the stated alternative (B6).

## Expected end state

- Policy decisions derive only from system-classified action kinds; every provider key format redacted on all trace paths and blocked from skills.
- Classification uses evidence allowlists and latest-state checks; no path surfaces an action envelope, parse garbage, or synthetic note as `run.result`; the finish flow cannot crash a run unclassified.
- `pnpm run architecture` enforces import boundaries with an empty allowlist; LOC caps stay as pressure signals.
- SPECS/docs describe the system as built; root holds only durable docs; the one actively-misleading doc (12.5k LOC budget) is gone.
- Eval/experiments outputs safe to gate skills and training data on.
- Production LOC down ~1.3k net from 17,929.

---

## Execution log (2026-06-10)

Implemented same-day on `main`, one conventional commit per item/batch; every
commit passed `pnpm check` (architecture + typecheck + tests). Deviations and
judgment calls made during execution:

- **A10 harness:** deleted rather than repaired (the plan's stated default) —
  `eval/harness.ts` had no consumers and no test file; docs now point at
  `bench.ts`, the real runner.
- **A8 hasVisitedDomain:** the first-label match turned out to be deliberate
  redirect tolerance (railway.app → railway.com lives in the test fixtures),
  so only the dot-boundary bug was fixed and the label rule was documented.
- **A8 task-summary notes:** excluded from `deriveRunResult` as planned, but
  non-succeeded runs still surface the latest note as a *diagnostic* result —
  it remains invisible to `hasMeaningfulDerivedResult`, so it cannot ride a
  burned step budget to partial-success. One test that had encoded the old
  note-to-partial behavior was updated to expect `agent-error`.
- **B6 guidance filter:** helper-tagged items ship unconditionally because the
  helper preamble is unconditionally available in exec — the honest filter is
  skill-tagged items only when skills are loaded.
- **C3 ack detectors:** NOT merged. The three detectors have genuinely
  different semantics (key-set ack vs boolean-flag ack vs event-level
  nav-only) and each is regression-locked; merging risked behavior change for
  ~20 LOC. Recorded here instead of silently skipped.
- **C3 verdict extraction:** deferred. The motivating defect (agent↔eval
  cycle) was resolved by moving `scoring.ts` into `agent/` and `bench.ts`
  into `cli/` (it is the `wire bench` command); the import-graph allowlist is
  empty. A separate `verdict/` module remains an option if `agent/` keeps
  growing, but is no longer needed for boundary hygiene.
- **C4 attachments:** `BrowserExecRequest.attachments` deletion deferred —
  `shared/schemas.ts` was concurrently being modified by parallel work
  (screenshot capture); remove it in a follow-up touch of that file.
- **C5 fixtures:** `src/agent/fixtures.test.ts` created and adopted by the
  suites added in this plan (runtime-guards, finalize, recovery); remaining
  suites adopt incrementally as they are touched, per plan.
