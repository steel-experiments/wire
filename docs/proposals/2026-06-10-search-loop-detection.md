# Proposal — detect semantic search loops and query-echo SERP traps

**Status: IMPLEMENTED 2026-06-11.** Finding 1 → `src/agent/search-loop.ts`
(`countSearchesSinceExtraction`) wired into the runtime guard block: nudge at 3
search navigations without a meaningful extraction, abort to re-plan at 6
(conservative defaults per Open Question 1; classification unchanged per Open
Question 2 — the run finishes through the normal evidence path). Finding 2 →
guidance-only (the lean option): a conditional `query-echo-trap` entry in
`action-guidance.ts` ships when the latest result trips `looksLikeQueryEcho`.
Escalation beyond guidance deferred until the harness shows the agent ignoring it.

Date: 2026-06-10. Source: live test `run_3383faa5` (task `task_f88c4f9d`), objective
*"What was the name of the 5K race hosted at the old Great America theme park in
California that had 'bubble gum' in its title?"* — a question whose answer is not
directly extractable on the open web. The run spent 30 steps oscillating between
DuckDuckGo and SEO-spam crossword sites (`wordplays.com`, `g5.com`), never
extracted an answer, and finished `partial-success (55%)`.

This proposal covers the two findings from that run that are **design additions,
not defects** — they need a design decision before code. The one genuine defect
surfaced by the same run (the completion-contract reprompt was unbounded and
ground the run to `maxSteps`) was already fixed: `finish-flow.ts`
`CONTRACT_REPROMPT_LIMIT`, completing the intent of
[`WIRE_RELIABILITY_PLAN.md` §1b](./WIRE_RELIABILITY_PLAN.md).

---

## Finding 1 — the semantic search loop is invisible to all three stuck-guards

**Observed:** the agent cycled *search → open a spam result → `innerText` dump →
re-search with a tweaked query → repeat*. Every turn used a **new** URL and **new**
exec code with **new** non-empty content, so none of the existing guards in
`src/agent/runtime.ts` (the `noProgressCount`, `sigOnlyCount`, `stuckCount`,
`repeatFailCount` block) ever fired:

- `noProgressCount` (`runtime.ts` ~621) resets on any non-empty `ok` result, and a
  SERP/JSON dump is non-empty (`isNoProgressResult` is false), so it never accrued.
- `sigOnlyCount` / `stuckCount` / `repeatFailCount` key on `execActionSignature`
  (the code text) plus result digest/shape. A different URL and different code each
  turn means a fresh signature every turn — nothing repeats.

The guards catch *"the same action repeated."* They are blind to *"different
actions cycling through the same dead-end **pattern**"* — here, the repeating shape
is `navigate(SERP) → dump → navigate(result) → dump`, not any single action.

**Why this is core, not a skill** (per `docs/skills-vs-core.md`): "the agent is
going in circles at the task level" is a property of how wire runs, true regardless
of site or task. It belongs next to the existing stuck-guards.

**Proposed approach (needs a decision):** add a **pattern-level** stall signal
alongside the action-level ones. Candidate signal: a rolling window of the last N
steps classified into coarse *kinds* — `search` (navigate to a known search engine
or a `?q=`/`?query=` URL), `open-result`, `page-dump` (an exec whose result trips
`looksLikeUnextractedPage`), `extract`. If the window contains ≥K `search` kinds
with zero `extract` that produced a contract-satisfying result, bail to re-plan with
a distinct nudge ("you have searched K times without extracting an answer — the
sources you are reaching may not contain it; state that you could not find it, or
try a fundamentally different source"). Bounded and additive; reuses the existing
"abort to force re-plan" path so classification is unchanged.

**Open questions for Niko:**
1. Window/threshold (K searches, N-step window) — tune against the harness, or pick
   conservative defaults (e.g. K=3) and let the eval loop adjust?
2. Should the bail produce an explicit *"answer not found on reachable sources"*
   outcome rather than `partial-success`? That overlaps Finding 2.

---

## Finding 2 — no notion of a query-echo / SERP-trap source

**Observed:** `wordplays.com` and `g5.com` synthesize a page for *any* literal query
string in the URL. The agent treated *"there is a page titled with my exact query"*
as a real lead and chased it three times. The final artifact is DuckDuckGo's own UI
chrome with the query reflected back, percent-encoded:
`"...?q=%22Bubble%20Gum%20Challenge%22%205K%20%22Great%20America%22..."`.

wire already **detects** query-echo *after the fact* — `looksLikeQueryEcho` /
`looksLikeUnextractedPage` (`src/agent/classify.ts`) reject `%22`-bearing results at
the contract and classifier. What's missing is **in-loop awareness**: nothing tells
the agent *while it is choosing the next link* that a result whose title is just its
own query reflected back is a trap, not a source.

**Proposed approach (needs a decision):** a thin, additive guidance entry in
`src/agent/action-guidance.ts` (sibling to the existing `serp-target-check` /
`search-engine-choice` entries), surfaced when the latest observation/result trips
`looksLikeQueryEcho`: *"This page's title/URL just reflects your search query back
(query-echo). It is almost certainly an auto-generated result farm, not a source.
Do not extract from it — pick a different result or refine the query."* Reuse the
existing detector; no new domain list (a hardcoded spam-domain denylist would
violate the zero-weight / inspectable principles and rot quickly).

**Open question for Niko:** guidance-only (cheap, advisory) vs. a harder signal that
actively declines to record a query-echo page as evidence. I lean guidance-only
first, measured on the harness, escalating only if the agent ignores it.

---

## What was already shipped from this run

- **Bounded contract reprompt** (`src/agent/finish-flow.ts`): the completion
  contract previously reprompted on every failed finish with no cap, so a
  never-satisfiable contract bounced finish→reject→finish until `maxSteps`. Now
  capped at `CONTRACT_REPROMPT_LIMIT` (2) with an escalating steering message, then
  the run finishes with the unmet result (still classified `partial-success` via the
  recorded contract-check failure). Test:
  `agent.test.ts` → "caps contract-failed finish reprompts instead of grinding to
  maxSteps".

## Explicitly **not** changing

- **Classification of query-echo / raw-page results as `partial-success (0.55)`.**
  This is a deliberate, recently-tuned decision with dedicated tests
  (`classify.test.ts` lines ~230–324, including one for this exact bubble-gum task)
  and is recorded as a prior fix. If 0.55 feels too generous for a zero-extraction
  run, that is a separate, intentional re-tuning — flagged for Niko, not changed
  unilaterally here.
