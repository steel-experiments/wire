# wire overnight

This is an experiment to have an AI agent autonomously improve a browser agent overnight.

## Setup

To set up a new experiment run, work with the user to:

1. **Agree on a run tag**: propose a tag based on today's date (e.g. `jun5`). The branch `overnight/<tag>` must not already exist — this is a fresh run.
2. **Create the branch**: `git checkout -b overnight/<tag>` from current main.
3. **Read the in-scope files**: The repo is well-structured. Read these files for full context:
   - `MANIFESTO.md` — the north star. Principles, refusals, the standard.
   - `SPECS.md` — architecture spec, data flow, module boundaries.
   - `WIRE_RELIABILITY_PLAN.md` — phased improvement plan with evidence citations.
   - `REPORT-LESSONS-LEARNED.md` — retrospective: what broke, what worked, what to change.
4. **Verify the environment**: Check that `.env` contains `STEEL_API_KEY` and at least one LLM key (`OPENAI_API_KEY` or `ANTHROPIC_API_KEY`). Run `pnpm build` to confirm the project compiles. Run `pnpm typecheck && pnpm test` to confirm the test suite is green.
5. **Lock the baseline**: Run the comparison harness to establish a starting measurement:
   ```bash
   npx tsx benchmarks/compare/run-compare.ts --arms wire --reps 3 --skip-build
   ```
   Record the per-task success rate and average judge score. This is your ground truth.
6. **Initialize results.tsv**: Create `results.tsv` with just the header row.
7. **Confirm and go**: Summarize baseline numbers and confirm setup looks good.

Once you get confirmation, kick off the experimentation.

## Experimentation

Each experiment runs **real browser tasks** against **real websites** using Steel cloud browsers. An experiment is a code change + a benchmark run to measure the effect.

**What you CAN do:**
- Modify any source file under `src/` — agent loop, classification, skills, extraction, prompts, browser helpers, policy, storage, eval. Everything is fair game.
- Change prompts, tune heuristics, restructure modules, add helpers, remove code.
- Add new test files or extend existing ones (TDD: failing test first).

**What you CANNOT do:**
- Modify the benchmark task definitions in `benchmarks/benchmark_tasks.json`. The tasks are the ground truth.
- Modify the comparison harness in `benchmarks/compare/`. It is the measuring stick.
- Add dependencies. `zod` is the only runtime dep. Keep it that way.
- Remove or weaken existing tests to make things pass.

**The goal: increase the verified task completion rate.** Run the harness, get scores. The metric is the wire arm's pass rate (judge score ≥ threshold) across the task suite. Higher is better. Variance matters — `--reps 3` reveals flakiness.

**Simplicity criterion**: All else being equal, simpler is better. A small improvement that adds complex heuristics is not worth it. A simplification (deleting code, removing a special case, merging two code paths) that holds or improves the pass rate is a great outcome — that's a simplification win. When evaluating whether to keep a change, weigh the complexity cost against the improvement magnitude. A 2% pass-rate improvement that adds 50 lines of fragile regex? Probably not worth it. A 2% improvement from deleting code? Definitely keep. Equal results with much simpler code? Keep.

**The first run**: Your very first run is the baseline (step 5 above). After that, every experiment is a hypothesis: "doing X will improve the pass rate." Form the hypothesis, make the change, run the harness, observe.

## The benchmark

Run the wire arm of the comparison harness:

```bash
# full suite, 3 reps for variance visibility
npx tsx benchmarks/compare/run-compare.ts --arms wire --reps 3 --skip-build

# quick smoke: just the core 6 tasks (example, hn, sec, lesswrong, httpbin, booking)
npx tsx benchmarks/compare/run-compare.ts --arms wire --tasks example-title,hn-front-page-titles,sec-edgar-apple-10k,lesswrong-front-page,httpbin-headers,booking-tokyo-hotels --skip-build

# pick a specific task to test a targeted change
npx tsx benchmarks/compare/run-compare.ts --arms wire --tasks hn-front-page-titles --reps 5 --skip-build
```

The harness loads `.env`, validates keys are present, and refuses to start if they're missing — so Wire can never be silently scored 0 by a missing key.

**Always pass `--skip-build`** if you just ran `pnpm build`. The harness rebuilds `dist` by default, which adds ~15 seconds.

## Output format

The harness writes results to `results/<timestamp>/results.jsonl` and a `report.md` summary. The report includes per-task pass rate and judge scores.

For quick extraction:

```bash
# per-task results from the latest run
cat results/$(ls -t results/ | head -1)/results.jsonl | jq '{task: .task_id, score: .judge_score, answer: .final_answer[:80]}'
```

Each run record in the JSONL has these key fields:

- `task_id` — which benchmark task
- `arm` — always `wire` in this context
- `judge_score` — 0..1, the blind judge's score
- `success` — boolean, true if `judge_score >= threshold`
- `final_answer` — what Wire returned
- `wall_ms` — wall-clock time
- `rep` — repetition number (1-indexed)

## Logging results

When an experiment is done, log it to `results.tsv` (tab-separated).

The TSV has a header row and 6 columns:

```
commit    pass_rate    avg_judge    wall_avg_s    status    description
```

1. git commit hash (short, 7 chars)
2. pass rate as fraction (e.g. `0.83` for 83%) — use `0.00` for crashes
3. average judge score across all tasks and reps (e.g. `0.71`) — use `0.00` for crashes
4. average wall-clock per task in seconds (e.g. `45.2`) — use `0.0` for crashes
5. status: `keep`, `discard`, or `crash`
6. short text description of what this experiment tried

Example:

```
commit	pass_rate	avg_judge	wall_avg_s	status	description
a1b2c3d	0.83	0.71	45.2	keep	baseline
b2c3d4e	0.89	0.76	44.8	keep	explicit answer channel in finish payload
c3d4e5f	0.78	0.68	62.1	discard	contract-steering: too aggressive, blocks valid completions
d4e5f6g	0.00	0.00	0.0	crash	bad import broke build
```

## The experiment loop

The experiment runs on a dedicated branch (e.g. `overnight/jun5`).

LOOP FOREVER:

1. Look at the git state: the current branch/commit we're on. Read `results.tsv` to see where we are.
2. Form a hypothesis. What specific problem are you attacking? (Check the reliability plan, the lessons-learned report, or patterns you've noticed in the results.)
3. Write a failing test that demonstrates the problem (TDD).
4. Make the minimal change to fix it.
5. Verify: `pnpm typecheck && pnpm test`. Must be pristine. No shortcuts.
6. `pnpm build` to refresh `dist/`.
7. Run the benchmark: `npx tsx benchmarks/compare/run-compare.ts --arms wire --reps 3 --skip-build` (redirect output — do NOT let it flood your context).
8. Extract the results from the latest `results/` directory.
9. Record the results in `results.tsv` (NOTE: do not commit `results.tsv` or the `results/` directory — leave them untracked by git).
10. If pass rate improved, you "advance" the branch — commit the code change. If pass rate is equal but code is simpler, also advance (simplification wins count).
11. If pass rate is worse, `git reset --hard` back to where you started.
12. Update `METRICS.md` with the current LOC count after any code change that advances.

The idea is that you are a completely autonomous reliability engineer trying things out. If they work, keep. If they don't, discard. You're advancing the branch so you can iterate. If you feel like you're getting stuck, you can rewind — but do this sparingly.

**Timeout**: The full suite (`--reps 3`) takes ~30 minutes. A quick smoke (6 tasks, 1 rep) takes ~5 minutes. Use quick smokes for rapid iteration; run the full suite before recording a result. If a single run exceeds 10 minutes per task, kill it and treat it as a failure.

**Crashes**: If a run crashes (build error, Steel API timeout, unhandled rejection), use your judgment. If it's a dumb fix (typo, missing import), fix and re-run. If the idea itself is fundamentally broken, log "crash" in the TSV and move on.

**Flakiness**: Real websites change. A task that passed last run may fail this run because the page changed. Mitigate with `--reps 3` — look at the trend, not a single data point. A change is "keep" only if the pass rate improvement is consistent across reps.

**NEVER STOP**: Once the experiment loop has begun (after the initial setup), do NOT pause to ask the human if you should continue. Do NOT ask "should I keep going?" or "is this a good stopping point?". The human might be asleep, or gone from a computer and expects you to continue working *indefinitely* until you are manually stopped. You are autonomous. If you run out of ideas, think harder — re-read the reliability plan, re-read the lessons-learned report, analyze the failing tasks' JSONL traces for new patterns, try combining previous near-misses, try more radical structural changes. The loop runs until the human interrupts you, period.

As an example use case, a user might leave you running while they sleep. If each full-suite experiment takes ~30 minutes (5 min smoke + 25 min full suite), you can run approximately 2/hour, for a total of about 16 over the duration of an average human sleep. The user then wakes up to experimental results, all completed by you while they slept!

## Where to look for ideas

Not sure what to try next? Here's a prioritized list, drawn from the reliability plan and lessons learned:

### High-value (known bugs, clear fix path)

1. **Explicit answer channel** (`WIRE_RELIABILITY_PLAN.md` Phase 1a): `deriveRunResult` infers answers from the last code-result and leaks nav-acks. Add a `finish` payload with an explicit `answer` field. Fall back to current heuristic only when none was emitted.

2. **Contract-steering** (Phase 1b): On `finish` with an unmet contract and remaining budget, inject a corrective observation ("returned N items, task needs ≥M") and continue the loop instead of finishing. Bounded by the step budget.

3. **Wait-before-extract** (Phase 2): Make extraction helpers settle explicitly — `waitForSelector` + retry-on-empty. Cap at 5s. Log it.

### Medium-value (systemic improvements)

4. **Executable waits in skills** (Phase 3a): Skills auto-generated with prose "wait for the page to load" instead of `await waitForSelector("sel", 5000)`. Fix the skill proposal prompt and renderer.

5. **Validate-before-promote** (Phase 3b): Before flipping a skill to `active`, re-run the skill's own objective once. Fail → keep as proposal. The HN skill auto-promoted at 0.93 confidence while being broken.

6. **Classifier calibration** (Phase 4): The classifier scored correct answers as "does not appear to address the objective." Tune the false-negative path. Add a classifier-vs-judge agreement metric.

### Exploratory (open questions)

7. **Reconfigure reflex**: `about:blank` was misread as anti-bot → reflexive proxy/captcha reconfigure on 13/18 runs, fatal on SEC EDGAR. Gate reconfigure behind positive evidence.

8. **Query-echo / page-dump detection**: The agent sometimes echoes the query back or dumps raw HTML as the answer. Detect and reject these patterns in `deriveRunResult`.

9. **Prompt tuning**: The system prompt is the most impactful single file. Experiment with different instruction strategies for extraction, navigation, and answer formulation.

10. **Progress ledger**: The new `classify.ts` replaced heuristics with a progress ledger. Tune the scoring weights based on benchmark results.

### Simplification (equal results, simpler code)

11. **Remove dead heuristic paths**: `classify.ts` and `deriveRunResult` accumulated special cases. If the explicit answer channel makes some of them unreachable, delete them.

12. **Consolidate extraction helpers**: Browser helpers for extraction are spread across files. Unify into one clear surface.

13. **Reduce prompt length**: The system prompt is large. If sections are redundant or contradicted by helpers, trim. Every token in the prompt is a token the model must parse on every step.

## Rules of engagement

These are non-negotiable. Violating any of them means the experiment is invalid.

1. **The test suite must be green.** `pnpm typecheck && pnpm test` after every change. No exceptions.
2. **The measuring stick must be trustworthy.** Never modify the harness, the task definitions, or the judge. Never skip `--reps 3` for a recorded result.
3. **No hidden retries.** Every wait, retry, or retry-like behavior must be explicit and logged in the trace. The manifesto demands it.
4. **No new dependencies.** Only `zod` as a runtime dep. If you need something, build it thin.
5. **Update METRICS.md.** After any code change that advances the branch, recount LOC.
6. **Never use `--no-verify`.** Pre-commit hooks are quality gates. If they fail, fix the root cause.
7. **The agent lies to itself.** Never trust the classifier's self-assessment. Never trust a skill's confidence score. The harness results are the truth.

## What "done" looks like

The experiment is never truly done — you keep going until interrupted. But the branch tells a story. A good overnight run produces:

- A `results.tsv` with 10–20 experiments
- 3–5 "keep" commits that materially improve the pass rate
- A few "discard" entries documenting what didn't work (valuable negative knowledge)
- A branch that, when diffed against main, shows clear, tested, simple improvements
- Updated `METRICS.md` and green tests throughout

The human wakes up, reads `results.tsv`, and decides what to merge.
