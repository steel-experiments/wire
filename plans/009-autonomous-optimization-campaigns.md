# Plan 009: Build bounded, evidence-backed optimization campaigns

> **Executor instructions**: Read this plan completely before changing code.
> Follow the steps in order, run their verification commands, and stop on any
> condition in the "STOP conditions" section. This plan creates developer
> tooling, not a new production dependency or a second browser-agent loop.
> Update this plan's row in `plans/README.md` when the work is actually done.
>
> **Drift check (run first)**: `git diff --stat 1dc5703..HEAD -- package.json benchmarks/compare/run-compare.ts benchmarks/compare/suite.json src/cli/artifacts.ts src/shared/paths.ts src/storage docs/proposals/PROGRAM.md`
> Then run `git status --short`. This plan was authored while unrelated
> navigation-reliability work was dirty. Do not execute in that worktree:
> select a clean, committed base that contains the changes the operator wants
> measured, create a new worktree from it, and record that exact SHA in the
> campaign. If the comparison result shape no longer includes
> `native.runId`, or `WIRE_ROOT` / `WIRE_SKILLS` no longer isolate a run,
> stop: the feedback design below must be re-planned against the new contract.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: HIGH — it spends real browser/model budget and coordinates source
  changes, so its limits and provenance matter as much as its scoring.
- **Depends on**: no code plan; a clean committed base and valid Steel/LLM
  credentials are operational prerequisites.
- **Category**: evaluation / reliability / developer tooling
- **Planned at**: commit `1dc5703`, 2026-07-17

## Outcome

Give Codex a durable, bounded outer loop for improving Wire:

```text
immutable task + judge inputs
          │
          ▼
  paired live Wire evaluations ──► persisted results + traces
          │                                  │
          ▼                                  ▼
  script-computed tournament           failure autopsies
          │                                  │
          └──────── compact next-action packet ───────► Codex
                                                        │
                                  isolated candidate worktree + commit
                                                        │
                                                        └──► ingest and re-evaluate
```

The campaign engine is deterministic orchestration and measurement. Codex is
the hypothesis and patch author. A scheduler may repeatedly invoke both, so a
campaign can run 10, 100, or many more live attempts, but the engine itself
never silently edits Wire, silently retries a failure, auto-merges a patch, or
spends beyond its declared budget.

This makes feedback survive a Codex turn boundary: every completed phase emits
a small, redacted `next-action.json` with the evidence required for the next
Codex turn. It deliberately does **not** embed a specific coding-model API in
Wire. That would couple the browser agent to one operator environment and put
an opaque prompt-and-edit workflow in the product core.

## Why this matters

Wire already has the important raw ingredients, but they are disconnected:

- `benchmarks/compare/run-compare.ts` runs a shared blind judge and appends one
  JSONL record per attempt. Its Wire record includes `native.runId`, which is
  the bridge from an externally judged failure to Wire's evidence.
- `src/cli/artifacts.ts#persistExecutionArtifacts` persists the run, task,
  trace events, and artifacts. `WIRE_ROOT` and `WIRE_SKILLS` already provide
  process-level isolation points through `src/shared/paths.ts`.
- The runtime has a live `TraceSink`, but the outer loop does not need to alter
  an in-progress browser run for its first version. Post-run evidence is enough
  to make a correct, inspectable improvement loop.
- `docs/proposals/PROGRAM.md` describes an overnight experiment, but it is a
  manual serial recipe with a mutable TSV and a destructive `git reset --hard`.
  It cannot safely hand work between coding-agent turns, preserve paired
  evidence, protect holdouts, or distinguish an infrastructure failure from a
  product regression.

The project retrospective explicitly warns against building another evaluator.
This plan reuses the existing comparison harness and its judge as the measuring
stick; it adds campaign control, trace autopsy, and a handoff protocol around
them.

## Design decisions and non-negotiable invariants

1. **Keep the optimizer outside `src/`.** It is research/developer tooling,
   not universal runtime behavior. Put it in `benchmarks/optimize/` and expose
   it through `pnpm optimize`, not `wire optimize`. A later, proven read-only
   autopsy helper can be promoted to the CLI if it earns that surface.

2. **Treat the existing comparison harness as immutable during a campaign.**
   The engine invokes it as a child process; it does not import or rewrite its
   judge. Candidate validation rejects a diff touching
   `benchmarks/compare/**`, `benchmarks/optimize/**`,
   `benchmarks/benchmark_tasks.json`, `benchmarks/benchmark_tasks.schema.json`,
   `package.json`, `pnpm-lock.yaml`, or a campaign's frozen suite.

3. **Compare a candidate with its exact base, not with a stale historical
   number.** Every candidate result is paired and interleaved with an isolated
   worktree at `baseCommit`, using identical model, judge, task, skill snapshot,
   and environment settings. The pair order is seeded and recorded.

4. **Keep all live state isolated and durable.** Each physical attempt receives
   fresh `WIRE_ROOT` and `WIRE_SKILLS` directories under the campaign state.
   This prevents storage collisions and learned-skill promotion in one arm from
   influencing the other. State is atomically written after every subprocess;
   an interrupted campaign can resume completed slots without re-running them.

5. **The judge, not Wire's classifier, decides a pass.** Wire's status and
   classification are useful autopsy evidence only. A subprocess error or
   unparseable judge output is an explicit infrastructure result, never a zero
   disguised as a product failure.

6. **Holdout information is withheld from the Codex handoff.** The controller
   may run it only after a candidate is frozen. It returns aggregate outcome,
   not holdout prompts, task IDs, answers, or traces. This is an honest protocol
   boundary, not adversarial secrecy: for a truly untrusted coding agent, run
   the controller and holdout fixture in a separate account/service.

7. **No hidden retry or destructive rollback.** A failed subprocess is recorded
   and surfaced. A new attempt requires an explicit campaign action. Candidate
   worktrees are preserved for review; only an explicit `cleanup` command may
   remove a worktree that the campaign created, after confirming it is clean.

8. **Promotion is a recommendation, never a merge.** A winning candidate gets
   a signed-off report and a `promote` recommendation. A human or higher-level
   release workflow reviews, commits, merges, and pushes it.

9. **Honor Wire's boundaries.** A site/task-specific conclusion belongs in a
   validated skill; a cross-site callable behavior belongs in a thin helper;
   only a site-independent property belongs in core. The handoff packet must
   make the recommended home explicit.

## Scope

**In scope** — create or change only these areas:

- `benchmarks/optimize/`
  - `cli.ts` — thin command dispatcher.
  - `model.ts` — versioned campaign, result, candidate, signature, and handoff
    contracts; validate JSON at the boundary with the existing `zod` package.
  - `state.ts` — campaign directory layout, atomic persistence, resume rules,
    and redacted result copies; reuse `src/storage/atomic.ts` rather than
    reimplementing atomic JSON writes.
  - `worktree.ts` — safe Git worktree creation/validation and protected-path
    checks, using `spawn` with argument arrays rather than a shell string.
  - `compare.ts` — the child-process adapter for the existing comparison
    harness and paired scheduling.
  - `autopsy.ts` — deterministic trace-to-signature analysis.
  - `tournament.ts` — score aggregation and promotion gates.
  - `handoff.ts` — compact Codex request/response files and Markdown reports.
  - focused `*.test.ts` files plus static fixtures; all unit/integration tests
    must be offline and use fake child processes/trace data.
  - `tsconfig.json` — an optimizer-only `noEmit` project that includes its
    imports and preserves the root project's strict compiler settings.
  - `README.md` and `campaigns/README.md` — operator protocol and manifest
    format. Committed campaign recipes contain no live results or credentials.
- `package.json` — add exactly these scripts:

  ```json
  "optimize": "tsx benchmarks/optimize/cli.ts",
  "optimize:test": "tsc -p benchmarks/optimize/tsconfig.json && node --import tsx --test 'benchmarks/optimize/**/*.test.ts'"
  ```

  Keep the root `check` command core-scoped; the new command is run explicitly
  by the campaign workflow until a later plan decides it belongs in CI.
- `docs/proposals/PROGRAM.md` — replace the destructive/manual loop with a
  short historical note and a pointer to the campaign engine. Remove its
  `git reset --hard` instruction entirely.
- `METRICS.md` — record the current `src/` LOC count after the code change,
  even though the new files live under `benchmarks/`.
- `plans/README.md` — change plan 009 to DONE only after every criterion below
  is met.

**Out of scope**:

- Any change to `src/agent/**`, `src/browser/**`, providers, prompts, policy,
  or Wire's production CLI. This plan measures and feeds improvements into
  Codex; it does not bundle a speculative behavior fix with the measuring
  system.
- Changes to `benchmarks/compare/run-compare.ts`, its judge rubric, task
  suites, benchmark task definitions, or a candidate's measured fixtures.
- A direct Codex/OpenAI/Claude API integration, background daemon, or automatic
  continuation scheduler. The portable file protocol is the integration point.
- Parallel live execution in v1. Start at concurrency 1 to protect rate limits,
  costs, evidence ordering, and real sites.
- Auto-merge, auto-push, `git reset --hard`, dependency additions, task/judge
  mutation, or automatic skill activation.

## Campaign state and contracts

Runtime data belongs below the already-gitignored `.wire/` directory:

```text
.wire/optimizer/<campaign-id>/
  resolved-campaign.json       # normalized immutable manifest + input hashes
  state.json                   # current phase, completed slots, budgets
  attempts/<slot>.json         # normalized pair result and subprocess metadata
  traces/<slot>/<arm>/         # WIRE_ROOT used by that physical attempt
  skills/<snapshot>/<slot>/    # identical mutable snapshot per arm/attempt
  autopsies/<run-id>.json      # redacted, structural evidence only
  candidates/<candidate-id>.json
  packets/0001-next-action.json
  packets/0001-response.json
  reports/<phase>.md
```

`resolved-campaign.json` is written once by `init` and contains:

```ts
interface CampaignSpec {
  version: 1;
  id: string;
  baseCommit: string;
  suite: { path: string; sha256: string };
  judge: { model: string; threshold: number };
  wire: { provider: "openai" | "anthropic" | "zai"; model: string; timeoutMs: number };
  cohorts: {
    smoke: Cohort;
    targeted: Cohort;
    broad: Cohort;
    holdout?: { externalSuitePath: string; sha256: string; slots: number };
  };
  budget: { maxPhysicalRuns: number; maxCandidates: number; maxWallClockMs: number; maxConcurrency: 1 };
  skillSnapshot: { path: string; sha256: string };
  seed: string;
}

interface Cohort {
  taskIds: string[];
  pairedSlots: number;
}
```

Validate task IDs against the frozen suite before any browser session opens.
Hash the suite and skill snapshot at initialization, then verify both before
every stage. Do not rely on a mutable path or a timestamp as provenance.

Each candidate must be described by a `CandidateResponse` written by Codex:

```ts
interface CandidateResponse {
  version: 1;
  campaignId: string;
  requestId: string;
  candidateId: string;
  baseCommit: string;
  worktreePath: string;
  candidateCommit: string;
  hypothesis: string;
  recommendedHome: "skill" | "helper" | "core";
  changedFiles: string[];
  testsRun: string[];
}
```

The engine independently verifies the worktree, commit ancestry, changed-file
list, protected paths, clean candidate worktree, and test results. It does not
trust the response's self-report. Existing-test edits are not automatically
assumed safe: report them prominently and require human review before a
`recommend-promote` result is acted upon.

The reciprocal `NextActionPacket` is deliberately small: campaign/phase/base
revision; remaining physical-run and time budget; paired score summary; top
three structural failure clusters; redacted evidence pointers (`runId`, local
autopsy path, last relevant URL/title/action summary); and the exact candidate
contract. It must never include environment values, cookies, authorization
headers, screenshot base64, full HTML, or a holdout task.

## Evaluation and promotion policy

Use a lexicographic score. The engine reports all dimensions, but a lower one
can never compensate for a failed higher one:

1. **Hard validity**: clean base/candidate provenance; protected inputs
   unchanged; candidate `pnpm check` and `pnpm optimize:test` pass; no new
   policy/approval violation or infrastructure fabrication.
2. **Verified completion**: paired blind-judge successes on the relevant
   non-holdout cohort.
3. **Holdout completion**: only for candidates that pass stage 2.
4. **Reliability**: lower task-level variance and fewer explicit failures.
5. **Efficiency**: lower median/p90 wall time and fewer steps where available.
   Report model cost when Wire eventually surfaces it; do not invent a cost
   number while it is `null` in comparison records.
6. **Simplicity**: fewer production lines/changed behaviors wins an otherwise
   equivalent result. Record this as a reviewer-visible tie-breaker, not an
   opaque model judgment.

For a candidate to advance, require all of the following:

- no hard-validity failure;
- a targeted paired win that exceeds the manifest's minimum (default: at least
  two more successful paired slots than the base and mean judge delta ≥ 0.05),
  or a documented simplification with no success or judge regression beyond
  `0.02`;
- no smoke-cohort success regression; and
- a broader-cohort result that is non-regressing before holdout is spent.

The holdout gate may recommend promotion only when its aggregate verified
completion is non-regressing and the broader win persists. An inconclusive
result is not a win: preserve the candidate and emit a request for either more
declared budget or a different hypothesis.

## Git workflow

- Create a clean isolated worktree and branch, e.g.
  `advisor/009-autonomous-optimization-campaigns`, from the explicitly chosen
  base commit. Never start by resetting the operator's working tree.
- Keep campaign runtime data under `.wire/optimizer/`; it is intentionally
  untracked. Commit only code, fixtures, docs, and stable recipe examples.
- Use conventional commits, e.g.
  `feat(eval): add bounded optimization campaigns`.
- Do not push, open a PR, or remove any worktree without explicit operator
  instruction.

## Steps

### Step 1: Establish the safe execution boundary

Before implementing the tool, create the dedicated worktree, run
`pnpm install --frozen-lockfile`, `pnpm check`, and record the selected base
SHA. Check required live credentials by presence only; never print their
values. Confirm that the existing comparison harness still writes:

- a JSONL record for every attempt;
- `native.runId` for the Wire arm; and
- result files below `benchmarks/compare/results/<stamp>/`.

Write the `benchmarks/optimize/README.md` boundary statement before writing
code: this tool controls campaigns and evidence, while Codex controls
hypotheses and patches. Include the core/helper/skill routing rule from
`AGENTS.md`.

**Verify**: the new worktree is clean before edits; root `pnpm check` passes;
no credential value appears in terminal capture, docs, fixtures, or Git diff.

### Step 2: Add versioned manifests and durable campaign state

Create `model.ts` and `state.ts`. Use the existing `zod` dependency to reject
unknown manifest versions, missing hashes, duplicate task IDs, empty budgets,
non-positive timeouts, non-`1` concurrency, unsafe campaign IDs, and a holdout
that has no external path/hash. Keep JSON data flat enough to inspect by hand.

Add `benchmarks/optimize/tsconfig.json`, extending the root strict settings,
with `rootDir` set to the repository root, `noEmit: true`, and includes for
`./**/*.ts` plus `../../src/**/*.ts`. This makes imports from Wire's storage and
redaction primitives typecheck without changing the production build's
`rootDir` or emitted `dist/` layout.

Implement these commands in `cli.ts` first:

```bash
pnpm optimize -- init --campaign <recipe.json> --base <commit>
pnpm optimize -- status --campaign <id>
pnpm optimize -- next --campaign <id>
```

`init` resolves relative paths once, verifies SHA-256 hashes, snapshots the
manifest into `.wire/optimizer/<id>/resolved-campaign.json`, and atomically
writes state. It must fail if the campaign directory already belongs to a
different base/manifest; require an explicit new campaign ID rather than
overwriting history. `status` is read-only and machine-readable with `--json`.
`next` writes a new monotonically numbered packet only when no unanswered
packet exists.

Add a documented recipe template, not a silently active campaign. The first
real navigation-reliability recipe must freeze the exact user-reported task and
its success contract from a captured failing trace; do not claim that the
generic six-task comparison suite reproduces that incident unless it actually
does.

**Verify**: unit tests cover valid initialization, every invalid boundary above,
hash mismatch, crash-safe/idempotent re-open, and refusal to overwrite a
different campaign. Inspect the resulting JSON by hand; it must contain no
secrets or raw browser artifacts.

### Step 3: Isolate base/candidate worktrees and live-run state

Implement `worktree.ts` with argument-array subprocesses for Git. It creates
one detached base worktree and accepts a candidate worktree only after it
proves all of the following:

- its candidate commit descends from `baseCommit`;
- `git diff --name-only <baseCommit>...<candidateCommit>` matches the response
  and touches no protected benchmark, campaign-controller, harness, task,
  judge, package-script, or lockfile path;
- the candidate worktree has no uncommitted changes;
- it does not add a dependency or modify lockfiles; and
- it records a concrete hypothesis and one of `skill`, `helper`, or `core` as
  the proposed home.

For every physical harness invocation, allocate distinct absolute paths for
`WIRE_ROOT` and `WIRE_SKILLS`. Seed both arms from the same hashed skill
snapshot, but copy it into a fresh mutable directory for each attempt so skill
proposal/promotion writes cannot leak across arms. Prepend that worktree's
`node_modules/.bin` to `PATH` so the comparison child executes the candidate's
rebuilt `wire`, not an unrelated globally installed binary.

Provide only an explicit `cleanup --campaign <id>` command. It may remove
worktrees listed in that campaign's state only after `git status --porcelain`
is empty; otherwise it reports the path and stops. It must never remove an
operator-created worktree or use `git reset --hard`.

**Verify**: a temporary test repository demonstrates protected-path rejection,
uncommitted-worktree rejection, incorrect-base rejection, and safe cleanup
refusal. A fake run proves base and candidate receive different `WIRE_ROOT` and
`WIRE_SKILLS` paths while retaining the same snapshot hash.

### Step 4: Wrap the existing comparison harness in paired slots

Implement `compare.ts` as a narrow adapter. It must call the existing script
from the relevant base or candidate worktree, for example:

```bash
pnpm compare -- --arms wire --suite <absolute-frozen-suite> --tasks <task-id> \
  --reps 1 --stamp <campaign-slot-arm> --skip-build
```

Build each immutable revision once with `pnpm run build` before its first slot;
then use `--skip-build` only while that same commit is being evaluated. Parse
the JSONL file the harness writes, not console prose. Copy the normalized result
and immutable provenance into `attempts/<slot>.json`, including `runId`, judge
score, success, wall time, native status/classification, harness output path,
base/candidate commit, and sanitized child stderr.

Generate a deterministic interleaved schedule from the manifest seed. A paired
slot is exactly two physical runs of the same task/repetition: base→candidate
or candidate→base, alternating according to the recorded seeded order. Start
at `maxConcurrency: 1`. If a child fails, times out, produces no record, or
has no `runId`, persist an `infrastructure-failure` attempt and stop the stage;
do not retry it in the background or score it as a failed task.

Expose:

```bash
pnpm optimize -- baseline --campaign <id>
pnpm optimize -- ingest --campaign <id> --response <response.json>
pnpm optimize -- evaluate --campaign <id> --candidate <id> --cohort targeted
```

`ingest` validates the candidate response but does not run it. `evaluate`
checks the remaining budget before every physical run and is resumable at slot
granularity.

**Verify**: use a fake harness fixture to prove argument construction, JSONL
parsing, alternating order, exact physical-run accounting, restart/resume with
no duplicate completed slot, and explicit handling of a malformed/empty child
result. Then run one real no-op paired slot against the selected base commit:
both sides must have independent trace roots and valid `runId`s. A no-op is
expected to be a tie/inconclusive result, never auto-promoted.

### Step 5: Turn persisted traces into conservative failure autopsies

Implement `autopsy.ts` using `loadRun`, `listTraceEvents`, and `listArtifacts`
against the attempt's own `WIRE_ROOT`. Autopsy after each result with a valid
`runId`; if trace data is unavailable, record `trace-unavailable` rather than
guessing.

Emit zero or more structural signatures, each with a short explanation and
evidence event IDs. Start only with patterns that persisted trace data can
support:

- `nav-404` — a post-navigation observation with a not-found/404 title or the
  conservative title-plus-empty-page shape;
- `navigation-only-stall` — repeated navigation-only code results with no
  meaningful extraction;
- `empty-extraction` — an attempted extraction with a semantically empty
  result;
- `repeated-action-stall` — normalized repeated code/action fingerprints with
  no observation progress;
- `auth-or-antibot`, `reconfigured-without-content`, and
  `runtime-or-network-error` when their persisted evidence is explicit;
- `judge-rejected` — the independent judge failed an otherwise completed run.

Reuse existing redaction before storing snippets. Limit URL/title/action text
and trace tails; store artifact IDs and local paths, never screenshot bytes or
full page content. Do not assign causal blame or declare a fix from one
signature. The next Codex request should state that signatures are hypotheses
to investigate, not truth.

**Verify**: fixture traces cover every signature, a normal successful
extraction emits none of the failure signatures, ambiguous data stays
unclassified, and secret-looking strings are absent from serialized autopsies
and handoff packets. Add a regression fixture for the original “guessed URL →
not-found → another guessed URL” trajectory once its exact trace is available.

### Step 6: Implement tournament scoring and gates

Implement `tournament.ts` with only script-computed arithmetic. Pair records by
task/repetition/slot and report success delta, mean judge delta, per-task
variance, median/p90 wall time, and explicit failure counts. Do not ask an LLM
to summarize a score or decide whether a candidate wins.

Implement the hard gates and lexicographic ordering above. Keep the defaults in
the manifest, not magic code constants. `evaluate` may mark a candidate:

- `rejected` — invalid provenance, protected input mutation, failed checks, or
  an explicit regression;
- `inconclusive` — insufficient budget/evidence or a real-site/infrastructure
  interruption;
- `survives-targeted` / `survives-broad` — eligible for the next declared
  cohort; or
- `recommend-promote` — passed broader and sealed holdout gates, pending human
  review.

The holdout command reads its external suite only after a candidate commit is
frozen. `next-action.json` and the candidate worktree receive no holdout
details; the report gives aggregate deltas and the gate decision only.

**Verify**: unit tests cover a clear win, one lucky slot, a smoke regression,
a judge-score tie resolved by simpler code, a high-variance candidate, an
unscorable judge, and a holdout failure. Confirm no test can produce
`recommend-promote` without a broader result and a holdout result.

### Step 7: Close the feedback loop with Codex-safe packets

Implement `handoff.ts` and complete the `next` / `ingest` protocol. A typical
cycle is:

1. `next` writes `packets/NNNN-next-action.json` and a readable phase report.
2. A Codex scheduler or a new Codex turn reads that packet, creates a candidate
   worktree, makes one minimal hypothesis-driven patch, commits it, runs local
   checks, and writes the matching `CandidateResponse` file.
3. `ingest` independently validates the response and emits either a rejection
   packet or a targeted-evaluation action.
4. After scoring, `next` emits the next bounded action: inspect a cluster,
   propose a candidate, broaden a survivor, run sealed holdout, or stop because
   budget/convergence was reached.

Make the packet sufficiently compact to be placed directly in a new Codex turn:
top clusters, five-or-fewer evidence pointers per cluster, score deltas,
allowed scope, prohibited files, remaining budget, and the candidate response
schema. It must explicitly tell Codex to use a validated skill/helper/core
home and to leave the evaluator immutable.

Do not add an infinite in-process daemon. An external scheduler can call
`pnpm optimize -- next` and dispatch Codex again after every state transition;
the file protocol makes that reliable without assuming a particular Codex CLI,
model, credential model, or continuation API.

**Verify**: a fixture campaign completes `init → next → ingest → evaluate →
next` with no network. An outdated, duplicate, wrong-campaign, or altered
response is rejected. Inspect a generated packet manually: it has no holdout
details, secrets, raw screenshots, or unbounded instruction such as “keep
trying forever.”

### Step 8: Document budgets, run a small live pilot, and retire the old loop

Document two explicit campaign profiles in `benchmarks/optimize/README.md`:

- **Smoke (10 physical Wire runs)**: validates credentials, state isolation,
  `runId` trace recovery, no-op pairing, and packet flow. It makes no product
  claim.
- **Initial 100-run campaign**: 8 baseline calibration runs; up to three
  candidates × four paired targeted slots (24 physical runs); up to two
  survivors × eight paired broader slots (32); and one frozen winner × eighteen
  paired sealed-holdout slots (36). Total maximum: 100 physical Wire runs.
  The manifest may lower any stage; it may never exceed the declared total.

For higher confidence, document the 190-run configuration separately rather
than silently expanding the 100-run budget: 10 baseline runs, four candidates
× five pairs, two survivors × fifteen pairs, then forty winner pairs.

Use the exact failing navigation task as the first real campaign only after its
fixture has been frozen. It should examine URL-guessing/not-found/navigation
failure clusters, but it must permit a skill, helper, or core recommendation
based on cross-site evidence rather than prejudging the answer.

Rewrite `docs/proposals/PROGRAM.md` as a historical note pointing here. Keep
its useful motivation, but remove stale path references, mutable `results.tsv`
as the source of truth, and every destructive rollback instruction. The new
source of truth is campaign state plus the immutable comparison output.

**Verify**: run the smoke profile with real credentials only after the operator
authorizes its stated spend. The final report must show physical-run count,
wall-clock usage, all isolated roots, and an explicit `inconclusive`/`tie` if
the no-op candidate does not improve. It must not recommend a merge.

### Step 9: Final checks and handoff

Run:

```bash
pnpm check
pnpm run optimize:test
pnpm run metrics
git diff --check
git status --short
```

Update `METRICS.md` with the current source/test LOC totals and record that
the optimizer itself is outside `src/`. Re-read every changed file against the
scope list. Commit only the implementation/docs/fixtures; never add `.wire/`,
comparison result directories, credential files, or a candidate worktree.

**Verify**: all commands exit 0; `git diff --check` has no whitespace errors;
the only modified files are in scope; `plans/README.md` says DONE only after
the smoke flow and all automated checks above have passed.

## Test plan

All automated tests must be deterministic and offline. Use fixture JSONL,
fixture trace events, temporary directories, a temporary Git repository, and a
fake harness executable; never spend Steel/API budget in a unit test.

| Area | Required coverage |
|---|---|
| Manifest/state | schema validation, hash pinning, atomic resume, duplicate/changed campaign rejection |
| Worktrees | base ancestry, protected paths, dirty state, no destructive cleanup, per-attempt isolation |
| Harness adapter | argument arrays, candidate-local binary path, paired seeded order, parse/result failures, physical-budget accounting |
| Autopsy | each conservative signature, benign trace, unavailable trace, redaction/no screenshot payload |
| Tournament | hard gates, minimum win threshold, variance, simplification tie-break, holdout withholding and rejection |
| Handoff | packet compaction, response matching, stale/duplicate rejection, no secrets/holdout contents |
| End-to-end fake | init → packet → candidate response → paired score → next action, including a restart mid-stage |
| Real smoke | one authorized no-op pair, isolated traces, valid `runId`, non-promotion outcome |

## Done criteria

All of the following must be true:

- [ ] `benchmarks/optimize/` is a small, documented, versioned campaign engine
  with no new dependency and no production-core change.
- [ ] It reuses the current comparison harness/judge without modifying either,
  and rejects candidate tampering with protected evaluator inputs.
- [ ] Every physical run has isolated `WIRE_ROOT`/`WIRE_SKILLS`, a durable
  normalized result, and trace-backed autopsy when available.
- [ ] Campaigns are bounded by explicit physical-run, time, candidate, and
  concurrency budgets; failures are recorded rather than retried invisibly.
- [ ] Baseline/candidate comparisons are paired, seeded, interleaved, and
  evaluated by deterministic gates with holdout isolation.
- [ ] Codex can resume from `next-action.json` and return a candidate response
  without receiving secrets or holdout details.
- [ ] The 10-run real smoke has been run only with authorization and produces a
  transparent report; it does not auto-promote or auto-merge anything.
- [ ] `pnpm check`, `pnpm run optimize:test`, `pnpm run metrics`, and
  `git diff --check` pass; `METRICS.md` is current.
- [ ] `docs/proposals/PROGRAM.md` no longer instructs destructive resets, and
  plan 009 is marked DONE in `plans/README.md`.

## STOP conditions

Stop and report rather than improvising if any of these occur:

- The selected base is dirty, the planned current navigation change has not
  been intentionally committed/preserved, or the comparison/storage contracts
  in the drift check changed materially.
- The harness cannot identify the candidate's actual `wire` binary, does not
  return a `runId`, or cannot be made to store traces in the isolated root.
- A candidate changes a protected benchmark, judge, suite, package dependency,
  lockfile, or test solely to make an evaluation pass.
- A campaign would exceed its declared run/time/concurrency budget, credentials
  are missing, or a real site asks for an action outside the existing policy.
- A scoring rule requires an LLM opinion, a hidden retry, a fabricated token
  cost, or a conclusion from an unavailable trace.
- Holdout details would be included in the Codex packet, or raw artifacts could
  leak secrets/PII.
- The implementation needs to modify `src/` merely to operate. Reassess the
  boundary instead of turning an evaluator into production runtime behavior.
- The live smoke produces a harness/environment failure. Record it separately;
  do not call it a Wire regression or spend the remaining campaign budget.

## Maintenance notes

- Treat campaign manifests and result schemas as public file contracts. Bump
  `version` and add a migration/reader path; never silently reinterpret an old
  campaign.
- When Wire exposes reliable token/cost metrics, add them as a reported
  efficiency dimension behind fixtures and tests. Do not retrofit estimates.
- Do not add parallelism until repeated sequential campaigns show that Steel
  quota, skill isolation, and site rate limits remain stable. Make any future
  concurrency a manifest field with a tested scheduler, not a background retry.
- If the file handoff becomes a proven bottleneck, add a separate adapter for
  the chosen Codex scheduler outside Wire. Preserve the same packet/response
  schema so the evaluator remains inspectable and provider-neutral.
- Review every `recommend-promote` with the candidate diff, autopsies, raw
  comparison results, and a human decision. A campaign is evidence, not merge
  authority.
