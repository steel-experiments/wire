# Wire optimization campaigns

This directory contains developer tooling for bounded, evidence-backed Wire
optimization campaigns. The campaign engine controls deterministic scheduling,
budget accounting, evaluation, trace autopsy, and durable handoff files. Codex
controls hypotheses and candidate patches in isolated worktrees.

The engine is not a second browser-agent loop. It never edits Wire, retries a
failed live run silently, merges a candidate, pushes a branch, or spends beyond
the campaign manifest. The existing comparison harness and blind judge remain
the measuring stick and are immutable during a campaign.

Candidate changes must use Wire's normal ownership boundary:

- Knowledge true for one site or task pattern belongs in a **skill**.
- Cross-site behavior expressible as a thin callable function belongs in a
  **helper**.
- Site-independent behavior that defines how Wire itself works belongs in
  **core**.

Campaign runtime state lives under `.wire/optimizer/` and must never be
committed. Committed recipes contain hashes and public configuration only—no
credentials, cookies, raw browser content, live results, or holdout details.

## Operator protocol

Start only from a clean, committed base. Keep unrelated work in its original
checkout and create the campaign controller on its own branch/worktree. Freeze
the suite and skill snapshot, calculate their SHA-256 digests, fill an inert
recipe based on [`campaigns/template.json`](campaigns/template.json), and then
initialize it:

```bash
pnpm optimize -- init --campaign path/to/recipe.json --base <full-commit-sha>
pnpm optimize -- status --campaign <id>
```

`init` resolves every recipe path, verifies the public suite and skill-snapshot
hashes, and validates the declared non-holdout task IDs. It records the sealed
holdout path and expected hash without opening that file; holdout verification
is deliberately deferred until a candidate commit is frozen. Reusing an ID
with different inputs is an error.

After the operator authorizes the named live profile, run its base-vs-base
calibration before the first `next` so the first candidate packet can include
the resulting structural evidence:

```bash
pnpm optimize -- baseline --campaign <id>
pnpm optimize -- next --campaign <id>
```

`next` writes one numbered `next-action.json`; it will not create another until
the matching response or controller action is recorded. A scheduler may carry
these files between Codex turns, but there is no in-process daemon or model API
in the controller.

`ingest` validates the submitted worktree and commit, creates a fresh detached
controller-owned worktree at that exact commit, installs from the frozen
lockfile, and independently runs `pnpm check` and `pnpm optimize:test` there.
It does not invoke Wire or spend browser/model budget. On success it writes the
targeted-evaluation packet immediately; on rejection it writes the next
bounded proposal or stop packet.

The remaining lifecycle is explicit:

```bash
pnpm optimize -- ingest --campaign <id> --response <response.json>
pnpm optimize -- evaluate --campaign <id> --candidate <id> --cohort targeted
pnpm optimize -- evaluate --campaign <id> --candidate <id> --cohort smoke
pnpm optimize -- evaluate --campaign <id> --candidate <id> --cohort broad
pnpm optimize -- holdout --campaign <id> --candidate <id>
pnpm optimize -- cleanup --campaign <id>
```

Every live subprocess is sequential and receives a fresh absolute `WIRE_ROOT`
and `WIRE_SKILLS`. Normally both arms start from independent copies of the same
hashed skill snapshot. When the candidate commit itself changes `skills/**`,
the frozen snapshot must match the base commit's `skills/` tree; the candidate
arm then receives a separately hash-pinned copy of the candidate commit's
`skills/` tree. That explicit treatment makes a skill patch measurable without
letting one attempt's learned writes leak into another. The controller runs
`pnpm install --frozen-lockfile` and builds each exact revision once.
Candidate-controlled preparation runs in a transient sandbox. For live
measurement, the controller creates a protected attempt launcher for that
revision's `dist/index.js`, invokes the immutable TypeScript comparison harness
with the controller's exact Node executable, and reads the comparison JSONL
file rather than trusting console output. Candidate package bins never enter
the harness or judge `PATH`.

An exited child, timeout, malformed or missing record, unscorable judge, or
missing `runId` is persisted as an infrastructure failure and stops the stage.
It is never converted into a product zero or retried in the background.
`cleanup` considers only controller-created worktrees and refuses to remove a
dirty one. Candidate worktrees otherwise remain available for review.

The holdout suite is opened only after a candidate commit is frozen. Packets
contain aggregate holdout outcomes only—never holdout paths, prompts, task IDs,
answers, or traces. Stronger secrecy requires running the holdout controller in
a separate account or service.

## Authorization and budgets

A valid manifest declares maximum physical runs, candidates, wall-clock time,
and concurrency (`1`). Initialization does not authorize live spend. Before a
real run, the operator must separately authorize the named profile and its
maximum browser/model spend.

Candidate verification, preparation, and live Wire execution require Linux
with a working systemd user manager and unprivileged user namespaces. Before
running candidate-controlled code, the controller behaviorally probes a
transient service: declared read-only paths must reject writes, declared
read-write paths must accept them, and undeclared home paths and the
controller's user-manager sockets must be inaccessible. A host that merely
accepts the hardening properties without enforcing them is rejected.
Unsupported hosts fail closed before verification or live spend;
initialization, status, packet handling, and optimizer tests remain available.

Offline checks and builds can write only their exact worktree and isolated
offline home. A live Wire service sees its exact worktree read-only and can
write only its fresh `WIRE_ROOT` and `WIRE_SKILLS`; it receives the Steel key
and selected Wire-provider environment, not the judge's unrelated provider
credentials. The comparison harness and blind judge stay controller-side. A
Claude judge runs through a canonically resolved, scrubbed controller-owned
launcher; a Gemini judge uses the stateless Interactions REST endpoint with its
key only in the request header. A systemd control-group owns every Wire
descendant, including detached children. This is a strong same-account
accident and tampering boundary, but genuinely hostile candidates or sealed
holdouts still belong in a separate account or service.

The authored plan's nominal 100- and 190-run arithmetic did not count the
mandatory per-survivor smoke gate. The executable profiles below preserve the
declared ceilings by reallocating some broader-cohort pairs to smoke: the
100-run profile uses four rather than eight broad pairs per survivor, and the
190-run profile uses ten rather than fifteen. This is an explicit accounting
correction, not permission to expand either budget.

- **Smoke profile — 10 physical Wire runs.** Use one smoke pair for the
  base-vs-base calibration and four targeted pairs for one committed no-op
  candidate, such as a documentation-only commit outside protected paths
  (`maxCandidates: 1`, `maxPhysicalRuns: 10`). The required broad cohort may
  remain at one pair, but the budget prevents reaching it; the expected
  targeted tie stops first. This validates credentials, exact-binary selection,
  state/skill isolation, trace recovery, resume, and packet flow. It makes no
  product claim and never recommends a merge.
- **Initial campaign — at most 100 physical Wire runs.** Configure four smoke,
  four targeted, four broad, and eighteen holdout pairs. The executable upper
  bound is 8 base-vs-base calibration runs; three candidates × four targeted
  pairs (24 runs); two survivors × (four smoke + four broad pairs) (32 runs);
  and one frozen winner × eighteen sealed-holdout pairs (36). Smoke is counted
  explicitly because it is a mandatory promotion gate.
- **Higher-confidence campaign — at most 190 physical Wire runs.** Declare it
  separately with five smoke, five targeted, ten broad, and forty holdout
  pairs: 10 calibration runs; four candidates × five targeted pairs (40);
  two survivors × (five smoke + ten broad pairs) (60); and forty winner pairs
  (80). Never expand a 100-run manifest in place.

The first reliability campaign must freeze the exact observed failing task and
its success contract. The generic comparison suite must not be described as a
reproduction unless it actually reproduces the incident.

## Failure evidence and promotion

Trace autopsies emit conservative structural signatures with bounded redacted
event pointers. They are investigation hypotheses, not causal diagnoses.
Tournament decisions are script-computed and lexicographic: provenance and
tests, verified completion, sealed holdout completion, reliability,
efficiency, then simplicity. Lower dimensions cannot compensate for a failure
above them.

`recommend-promote` means only that the declared gates passed. Review the
candidate diff, raw comparison output, autopsies, existing-test changes, and
scope placement before any human-controlled merge or push.

## Deliberate controller weight

This controller is more substantial than a shell wrapper because the expensive
failure modes are orchestration failures: concurrent spend, orphaned children,
mutable build output, forged evaluator evidence, leaked credentials, and
double-spent work after a crash. The recovery and attestation code is deliberate
developer-tooling weight under `benchmarks/`; it adds no production command,
runtime dependency, browser loop, retry framework, or background service.

The module boundaries keep that weight inspectable: `model.ts` owns public file
contracts, `state.ts` owns durable state and hashes, `lock.ts` serializes
campaign mutations, `worktree.ts` owns Git provenance and isolation,
`compare.ts` owns one supervised comparison-child adapter and restart
accounting, `sandbox.ts` owns the fail-closed transient-service boundary,
`autopsy.ts` derives structural evidence, `tournament.ts` performs only
arithmetic gates, `handoff.ts` writes bounded packets/reports, and `cli.ts`
coordinates those domains. If these areas grow again, split at those
process/recovery seams rather than adding a framework or hiding behavior behind
automatic retries.
