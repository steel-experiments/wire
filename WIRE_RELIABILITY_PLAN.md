# Wire Reliability Plan

Implementation plan for the improvements surfaced by the cross-agent comparison
harness (`benchmarks/compare/`). Every item is traceable to an observation from
real runs, names the files it touches, and is verified by the harness.

## Evidence base (what we observed)

| # | Observation | Source |
|---|-------------|--------|
| E1 | HN skill (`confidence: 0.93`, auto-promoted) encodes `window.location.href` → immediate scrape with a **prose** wait; reliably yields empty/partial; **overrode** the generic prompt fix. | `~/.wire/skills/news_ycombinator_com-skill_*.md`, baseline runs |
| E2 | Skill promotion activates on the LLM's self-reported `confidence` + "rediscovered across runs" — it **never re-runs the skill to confirm it works**. | `src/skills/promote.ts` (`autoPromoteMinConfidence: 0.9`, no `runTask`) |
| E3 | Completion contract ("≥5 items, JSON") only **downgrades to partial after the fact**; it never steers the agent to fix the output. | `src/agent/contract.ts`, `classify.ts` |
| E4 | Extraction returns empty `[]` from a navigate-then-scrape race; the answer was present on the page. | wire run events, baseline |
| E5 | `deriveRunResult` heuristically picks the last code-result → surfaced an evidence blob, then a nav-ack (patched two shapes reactively). | `src/agent/loop.ts` |
| E6 | A *correct* 5-item array was classified `partial-success` "does not appear to address the objective" (false negative). | original user run |
| E7 | Wire ~44–51s (Steel session) vs `cc-bare` ~16–19s (WebFetch) on static pages. | baseline |

## Guiding principle: eval loop first

The harness is the measuring stick. Establish a committed baseline **before**
changing behavior, then re-run after each phase to prove movement (or catch
regressions — it already caught one of mine). No fix is "done" until the harness
shows it.

## Cross-cutting rules (apply to every task)

- **TDD**: failing test first → minimal change → green. Unit + integration; the
  harness is the end-to-end check.
- Gate after each change: `pnpm typecheck && pnpm test` pristine, rebuild `dist`,
  update `METRICS.md`.
- Honor the manifesto: no hidden retries (waits/retries must be explicit and
  logged), no framework weight, keep core inspectable.
- Each behavioral change ships behind a fallback to current behavior where it
  could regress existing flows.

---

## Phase 0 — Lock in the baseline (foundation)

**Goal:** a trustworthy reference to measure every later phase against.

- Run the full suite, all 4 arms, Sonnet 4.6 everywhere, `--reps 3` so HN
  flakiness shows as variance: `pnpm compare -- --reps 3`.
- Commit the curated result as `benchmarks/compare/BASELINE.md` (per-arm
  success-rate, avg judge, variance, wall, cost).
- Document the residual `cc-skill` caveat (non-browser global skills present;
  competing browser skill denied) in the harness README.

**Done when:** `BASELINE.md` exists with per-task variance; numbers reproduce within noise on a re-run.

---

## Phase 1 — Stop finishing with the wrong thing (in-loop correctness)

The cluster that makes Wire reliably *produce and surface* the right output.
Tackles E3, E5.

### 1a. Explicit answer channel (E5)
- **Problem:** Wire infers the answer from the last code-result, so instrumentation
  (evidence blobs, nav-acks) leaks in; we've been patching shapes reactively.
- **Change:** let the agent emit its answer explicitly — `finish` carries an
  `answer` payload (and/or a recognized `return {answer: …}` shape).
  `deriveRunResult` prefers the explicit answer, falling back to the current
  heuristic only when none was emitted.
- **Files:** `src/agent/loop.ts` (deriveRunResult, finalize), `src/agent/actions.ts`
  (finish payload), `src/agent/prompts.ts` (instruct emitting the answer).
- **Tests:** finish-with-answer is surfaced verbatim; heuristic fallback still
  works when no explicit answer; the existing nav-ack/observation cases stay green.
- **Risk:** changes the finish contract → keep heuristic fallback; migrate prompts
  carefully. Verified the old shapes still resolve.

### 1b. Contract-steering (E3)
- **Problem:** the contract only grades; the agent finishes with 1 item when 5 are
  required and is told only afterward.
- **Change:** on a finish attempt, validate the contract; if unmet **and** budget
  remains, inject a corrective observation ("returned N items, task needs ≥M —
  extract again") and continue the loop instead of finishing. Bounded by the step
  budget (no infinite loop).
- **Files:** `src/agent/loop.ts` (finish gate), `src/agent/contract.ts` (expose a
  reusable validate), `src/agent/prompts.ts` (corrective message text).
- **Tests:** finish blocked + corrective message emitted when contract unmet and
  budget remains; finish allowed when met; finish allowed (with partial) when
  budget exhausted — never loops past the budget.
- **Risk:** loops → strictly bounded by existing step/budget guards; reuse the
  stalled/stuck detectors already in `prompts.ts`.

**Verify Phase 1:** harness HN/sec/booking judge scores rise and "no answer"
disappears; pass-rate variance narrows vs Phase 0.

---

## Phase 2 — Stop scraping too early (extraction robustness)

Tackles E4.

### 2a. Wait-before-extract as structure, not advice
- **Problem:** generic prompt nudge for `waitForSelector` is ignored when a skill
  prescribes navigate-then-scrape.
- **Change:** make the extraction helper settle explicitly — an inspectable,
  logged `waitForSelector`/retry-on-empty wrapper the agent uses, so an empty
  first read triggers one explicit, visible wait+retry rather than returning `[]`.
  (Explicit + logged → manifesto-compliant, not a hidden retry.)
- **Files:** `src/browser/helpers.ts` (extraction helper surface), `src/agent/prompts.ts`
  (point extraction at it).
- **Tests:** helper returns content once the selector appears; surfaces a clear
  error/empty signal (not silent `[]`) when it never appears; the wait is recorded
  in the trace.
- **Risk:** added latency on genuinely-empty pages → cap the wait (e.g. 5s), log it.

**Verify Phase 2:** HN `--reps 3` empty-extraction draws drop toward zero.

---

## Phase 3 — Stop learning the wrong thing (skill system)

Tackles E1, E2. Depends on Phases 1–2 (so validation has a correct bar to check).

### 3a. Executable waits in generated skills (E1)
- **Change:** the skill-proposal prompt asks for **selector-based** waits, and the
  renderer emits `await waitForSelector("<sel>", 5000)` under `## Wait Patterns`
  instead of prose.
- **Files:** `src/skills/promote.ts` (proposal prompt ~L180, wait render ~L271).
- **Tests:** a candidate with selectors renders an executable wait line; no
  selectors → no bogus wait.

### 3b. Validate-before-promote (E2) — the big one
- **Problem:** brittle skills auto-promote at 0.93 on self-reported confidence.
- **Change:** before flipping an auto-promotion to `active`, **re-run the skill's
  own objective once** and require the completion contract to pass (or judge ≥
  threshold). Fail → keep as proposal, not active. Gate behind a config flag so
  promotion stays cheap when desired.
- **Files:** `src/skills/promote.ts` (promotion path), a small validation runner
  reusing `src/cli/runner.ts#runTask`, `src/skills/promote.ts` policy.
- **Tests:** skill that passes its contract promotes; skill that fails stays a
  proposal; flag off preserves current behavior.
- **Risk:** adds a browser run + cost to promotion → flag-gated, auto-promote only,
  single validation run, timeout-bounded. Document the cost.

**Verify Phase 3:** re-running the HN task no longer re-promotes the brittle
pattern; the promoted HN skill carries an executable wait and passes its contract.

---

## Phase 4 — Calibrate self-assessment (classifier)

Tackles E6. Depends on Phase 0 (needs labeled data).

- **Change:** treat the harness's `(objective, answer, judge-score)` records as a
  labeled set; tune `classify.ts` to remove the false-negative path that flags a
  correct, on-format answer as "does not appear to address the objective." Add a
  classifier-vs-judge **agreement metric** to the eval output.
- **Files:** `src/agent/classify.ts`, `src/eval/metrics.ts` (agreement metric),
  fixtures from `benchmarks/compare/results/*/results.jsonl`.
- **Tests:** the specific false-negative fixture now classifies correctly; no
  regression on true partials; agreement metric computed.
- **Risk:** over-fitting to judge → keep the change conservative (remove a clearly
  wrong heuristic, don't chase the judge).

---

## Phase 5 — Conscious stance on real-browser cost (E7)

- **Decision, likely no code:** Wire always uses a real browser by design. Record
  the tradeoff (static-page overhead vs JS/interactive correctness) explicitly in
  `MANIFESTO.md`/`docs/`. Only consider a documented fast-path if the data later
  justifies it. Lowest priority.

---

## Sequencing & dependencies

```
Phase 0 (baseline) ─┬─> Phase 1 (answer channel + contract-steering)
                    │        └─> Phase 2 (wait-before-extract)
                    │                 └─> Phase 3 (skill: exec waits + validate-before-promote)
                    └─> Phase 4 (classifier calibration)   [needs Phase 0 data]
Phase 5 (doc decision) — anytime, independent
```

- 1 and 4 can proceed in parallel after 0.
- 3 must follow 1–2 (validation needs a correct contract + reliable extraction).
- Re-run the harness after **each** phase; compare to `BASELINE.md`.

## Definition of done (whole plan)

- All phases merged with tests; `pnpm typecheck && pnpm test` pristine.
- Harness `--reps 3` shows: Wire "no answer" eliminated, HN pass-rate variance
  materially reduced, no regression on example/httpbin/lesswrong/sec.
- Skill promotion no longer activates a skill that fails its own contract.
- Classifier-vs-judge agreement reported and improved on the false-negative case.
- `BASELINE.md` refreshed as the new reference; `METRICS.md` current.
