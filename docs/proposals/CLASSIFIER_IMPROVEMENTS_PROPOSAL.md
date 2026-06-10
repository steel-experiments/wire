# Classifier Improvements — Proposal

## Goal

Make `classifyRun()` measurably accurate instead of measurably reactive. Today the classifier defends against failure modes that have happened; we want to know how often it's right and have a path to make it better grounded in data, not anecdotes.

## Non-Goals

- No LLM in the classification hot path. The classifier's value is that it's a pure function over the trace — deterministic, testable, cheap.
- No new dependencies (embedding libraries, scoring frameworks).
- No reshape of `RunClassificationKind`. The 7-kind taxonomy is stable.
- No automatic calibration (Platt, isotonic). Run volume doesn't justify it yet.

## Current State

`agent/classify.ts:140` — `classifyRun()` is a cascading rule tree over the accumulated trace plus stop-condition flags. Returns `{ kind, confidence, notes }`.

**Architecture (solid):**
- Pure function. No LLM call. No I/O.
- Evidence-driven: `task-complete` requires artifacts or ≥2 observations, plus a terminal event that is observation/artifact/successful code-result with output — not thought-summary or skill events.
- Mode-aware: `task` mode adds an objective-relevance check that `investigate`/`experiment` modes skip.
- Three guards against false-positive `task-complete`:
  - `resultAddressesObjective()` — keyword/verb match against the original objective.
  - `hasMostlyEmptyFields()` — schema-built-but-not-filled detector (cites grants.gov `run_48b5ae4d` in the inline comment).
  - `applyStagnationDowngrade()` — downgrades to `partial-success` if ≥2 consecutive unchanged observations preceded completion.

**Downstream consumers**: bench reports (`wire bench --json` exit code), skill proposer (only distills from successful runs above a confidence threshold), trace UI.

## Problems

| Issue | Severity | Where |
|---|---|---|
| Objective-relevance is bag-of-words; no semantic notion of "right entity" | medium | `resultAddressesObjective`, `agent/classify.ts:102` |
| `hasMostlyEmptyFields` catches one shape only — misses `"TBD"`, `"N/A"`, `"unknown"`, templated rows, placeholder numbers | medium | `agent/classify.ts:81` |
| Confidence numbers (0.85, 0.7, 0.6, 0.3) are hand-tuned, never measured | low-to-medium | throughout |
| `errorCount > 5` threshold is arbitrary | low | `agent/classify.ts:226` |
| Terminal-event filter is a denylist of 4 kinds; adding a new kind silently changes behavior | medium | `agent/classify.ts:271` |
| No "did the agent verify its own work?" signal | medium | success path |
| Heuristics written from incidents → catches past failures, misses new ones | structural | by design |

The pattern: each guard defends a known failure mode. There is no way today to know whether the classifier is right on a representative sample of runs.

## Proposed Sequence

Ranked by leverage. Earlier items are preconditions for later ones.

### 1. Build a labeled run corpus

**Highest-leverage change. Precondition for everything else.**

Pull 50–100 representative runs from `.wire/runs/`. Hand-label each with the kind a human would assign. Store labels in `benchmarks/classifier-labels.json`:

```json
{
  "runs": [
    {
      "runId": "run_abc123",
      "trace": "path/to/events.jsonl",
      "objective": "...",
      "mode": "task",
      "human": { "kind": "task-complete", "confidence": 0.9 },
      "rationale": "Extracted target data, terminal observation confirms state."
    }
  ]
}
```

Add a test (`agent/classify.test.ts`) that runs `classifyRun()` over the corpus and reports per-kind precision/recall plus a confusion matrix.

**Acceptance criteria:**
- 50+ runs labeled across all 7 kinds (with at least 5 of each common kind).
- Test produces per-kind precision/recall.
- Baseline numbers committed to the repo as the bar to beat.

Without this, every subsequent change is a guess.

### 2. Extend `hasMostlyEmptyFields` with placeholder detection

Small, mechanical. Catches a real class of false-positive `task-complete`.

```ts
const PLACEHOLDER_VALUES = new Set([
  "tbd", "n/a", "unknown", "todo", "placeholder", "...", "none", "null"
]);

// inside hasMostlyEmptyFields, treat a string as empty if
// PLACEHOLDER_VALUES.has(value.trim().toLowerCase())
```

**Acceptance criteria:**
- ~10 LOC change.
- Existing tests pass.
- New tests cover each placeholder value.
- Corpus precision on `task-complete` does not drop; ideally rises.

### 3. Add verification-step confidence boost

If `task-complete` is about to fire **and** the agent did an `observe` after the answer-producing `code-result`, bump confidence by 0.05–0.10.

Reasoning: verified extractions are higher quality. The agent confirmed page state matches the extracted answer.

```ts
const verifiedExtraction = (() => {
  if (!terminalEventHasExtractedAnswer) return false;
  const idx = events.lastIndexOf(terminalEvent);
  return events.slice(idx + 1).some((e) => e.kind === "observation");
})();
```

**Acceptance criteria:**
- Conservative boost (0.05–0.10), never above 0.95.
- Only applies inside the existing `task-complete` branch.
- Test fixtures cover verified vs unverified runs.

### 4. Replace terminal-event denylist with allowlist

```ts
// current (denylist)
const terminalEvent = events.reverse().find((e) =>
  e.kind !== "thought-summary" &&
  e.kind !== "skill-load" &&
  e.kind !== "policy-check" &&
  e.kind !== "skill-proposal"
);

// proposed (allowlist)
const EVIDENCE_KINDS = new Set([
  "observation", "code-exec", "code-result", "artifact", "error", "approval-result"
]);
const terminalEvent = events.reverse().find((e) => EVIDENCE_KINDS.has(e.kind));
```

When a new event kind ships (e.g. `user-message`), adding it to the codebase forces a conscious decision about whether it counts as evidence. The current denylist silently accepts new kinds.

**Acceptance criteria:**
- Allowlist defined as a `const Set` near the function.
- A test that fails loudly if a new event kind is added without an allowlist update.

### 5. Hold the line

Specifically **do not** ship without data:

- **LLM judge as second opinion.** Violates pure-function principle. Adds non-determinism and cost. Justified only if corpus shows deterministic classifier is wrong ≥10% on `task-complete`.
- **Embedding-based objective relevance.** New dependency, new latency, hard to debug. Same gating.
- **Confidence calibration (Platt/isotonic).** Overkill for current run volume. Real budget when volume is 100× larger.

These belong in a future iteration of this doc, gated on what the corpus reveals.

## Sequence in Practice (This Week)

1. **Day 1**: Pull 50 runs, hand-label. Write `benchmarks/classifier-labels.json`.
2. **Day 1–2**: Write the precision/recall harness in `agent/classify.test.ts`. Commit baseline numbers.
3. **Day 2**: Ship the placeholder-value extension (#2). Verify corpus precision holds.
4. **Day 3**: Ship the verification-step boost (#3). Verify confidence calibration improves.
5. **Day 4**: Ship the allowlist refactor (#4).
6. **Day 5**: Re-run corpus, document deltas, decide whether anything from "Hold the line" needs lifting.

Total scope: ~150 LOC of new code, mostly the labeled corpus and one test file. Bounded.

## Success Criteria

- `wire bench --json` reports include a `classifier` block with corpus-derived precision/recall.
- `task-complete` precision ≥ 0.85 on the labeled corpus (set baseline first, then aim above it).
- No `task-complete` false positive from any of the three known shapes: empty fields, placeholder values, stuck-then-finished.
- Adding a new event kind without updating the allowlist breaks tests.
- New incidents producing false positives are reproducible from the corpus before any fix is merged.

## Open Questions

1. Where does the labeled corpus live long-term? Inside the repo (small, version-controlled) or in `.wire/` (grows with use, not committed)? Lean toward repo for the seed; in-repo corpus stays small if curated.
2. Should bench runs auto-append to the corpus as unlabeled cases, surfacing diffs for review? Possibly — but only after #1 lands.
3. Does the skill proposer need its own confidence threshold tied to this work, or does it ride on the existing `classification.confidence`? Defer until corpus data exists.

## What's Out of Scope

- Run replay / compare view changes.
- Skill effectiveness signal changes (tracked separately in `SKILLS_v2.md`).
- LLM-side prompt changes to improve self-classification (we don't trust self-classification).
- Cross-run trend analytics.

## References

- Implementation: `src/agent/classify.ts`
- Manifesto line that defines the principle: `MANIFESTO.md` — *"A run is not complete because the agent says so. It is complete when the artifacts prove what happened."*
- Bench harness: `src/eval/bench.ts`
- Skill consumer: `src/skills/promote.ts` (reads classification confidence)
