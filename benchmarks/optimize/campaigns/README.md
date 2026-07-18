# Campaign recipes

This directory contains versioned, inert campaign recipes. A recipe is only an
input template: it does not activate itself, contain live results, or grant
permission to spend browser or model budget.

Copy `template.json` outside the measured candidate worktree, replace every
placeholder, freeze the suite and skill snapshot, and calculate their digests.
Paths are resolved relative to the recipe when `init` runs and persisted as
absolute paths. The campaign ID is immutable: use a new ID for any different
base, suite, snapshot, model, gate, cohort, or budget.

Do not commit credentials, live outputs, candidate responses, or holdout task
content here. Runtime data belongs under `.wire/optimizer/<campaign-id>/`.

## Manifest contract

Recipes are strict versioned file contracts. Version 1 accepts these fields:

- `id` is a lowercase, filesystem-safe identifier of at most 64 characters. It
  starts and ends with a letter or digit and may contain `.`, `_`, or `-`.
- `baseCommit` is the full 40-character lowercase commit SHA. The commit
  selected by `init --base` must resolve to this exact value, and the source
  worktree must be clean.
- `suite.path` names the frozen public suite and `suite.sha256` pins it. Every
  smoke, targeted, and broad task ID must exist in that suite; duplicates are
  rejected.
- `judge` declares the existing blind-judge model and a threshold from `0` to
  `1`. It does not install a second evaluator.
- `wire` declares `openai`, `anthropic`, or `zai`, the exact model, and a
  positive per-run timeout in milliseconds.
- `cohorts.smoke`, `cohorts.targeted`, and `cohorts.broad` each contain at
  least one task ID and a positive `pairedSlots` count. The optional holdout
  contains only an external suite path, its expected digest, and a positive
  slot count.
- `budget` contains positive physical-run, candidate, and wall-clock ceilings.
  `maxConcurrency` is exactly `1`. Preparation and verification consume wall
  time; only launched Wire arms consume the physical-run budget.
- `skillSnapshot.path` names the frozen skills directory copied independently
  into every attempt. Its digest covers relative names and contents, and
  symbolic links are rejected. Freeze the selected base commit's repository
  `skills/` tree if skill candidates are allowed; a candidate that changes
  `skills/**` is rejected when that base tree and the frozen snapshot differ.
- `seed` is a non-empty recorded scheduling seed. Changing it requires a new
  campaign ID.
- `gates` is required; there are no hidden defaults. Targeted success delta is
  a non-negative integer. Both smoke and broad success-regression allowances
  are exactly `0`; a manifest cannot authorize promotion through a success
  regression. Judge deltas and the simplification tolerance are numbers from
  `0` to `1`.

Unknown fields, unsupported versions, unsafe IDs, malformed hashes, non-positive
slots/timeouts/budgets, and concurrency above one are rejected at the boundary.
Candidate worktrees must descend from `baseCommit`; they cannot redefine any of
these campaign inputs.

## Hashes, paths, and sealed input

All recipe paths are relative to the recipe file unless already absolute. Use
the controller's deterministic hasher for both files and directories:

```bash
node --import tsx --input-type=module -e \
  'import { sha256Path } from "./benchmarks/optimize/state.ts"; console.log(await sha256Path(process.argv[1]));' \
  path/to/frozen-input
```

Digests are 64-character lowercase SHA-256 values. `init` resolves all paths
and verifies the public suite and skill snapshot. It records the holdout path
and expected digest but does not open or hash the sealed suite until the
holdout command has independently revalidated a frozen candidate commit. Keep
the holdout outside the measured candidate worktree and never copy its content
into a packet or committed recipe.

## Slots and budget arithmetic

One paired slot is two sequential physical Wire runs of the same task and
repetition: one exact base arm and one exact candidate arm. The recorded seed
chooses and alternates their order. Each arm receives a fresh `WIRE_ROOT` and
`WIRE_SKILLS` copy.

`baseline` reuses the smoke schedule with the base revision on both arms, so it
costs `2 × smoke.pairedSlots` runs without consuming a candidate. In the worst
case, every allowed candidate runs targeted, the strongest two candidates run
smoke and broad, and one winner runs holdout. Therefore the executable upper
bound is:

```text
2 × smoke slots                                      baseline
+ 2 × max candidates × targeted slots               targeted
+ 2 × min(2, max candidates) × smoke slots          survivor smoke
+ 2 × min(2, max candidates) × broad slots          broader cohort
+ 2 × holdout slots                                  sealed winner
```

The committed template is the corrected 100-run profile: 8 baseline + 24
targeted + 16 survivor-smoke + 16 broad + 36 holdout = 100 physical runs. Its
four broad pairs per survivor deliberately replace the authored plan's eight,
whose arithmetic omitted the mandatory smoke stage. A 190-run profile uses
five smoke, five targeted, ten broad, and forty holdout pairs with four
candidates: 10 + 40 + 20 + 40 + 80 = 190. Never enlarge a resolved campaign;
use a new ID and obtain new authorization.

## Live credentials

Initialization, status, packet generation, candidate verification, and
`pnpm optimize:test` are offline and do not authorize or spend browser/model
budget. Before `baseline`, `evaluate`, or `holdout`, the live preflight requires
credentials by presence only:

- `STEEL_API_KEY` for the browser;
- `ANTHROPIC_API_KEY` for the existing blind judge; and
- the selected Wire provider key: `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or
  `ZAI_API_KEY`.

Never put keys in a recipe, response, fixture, packet, or candidate worktree.
Offline install/build/check subprocesses receive a scrubbed environment and
run only inside the required Linux systemd sandbox. Live Wire services receive
only the Steel and selected-provider values required for that declared run;
the controller-side judge receives only its own Anthropic credential through a
scrubbed launcher. Secret values are never placed in transient-unit argv.
Candidate execution fails closed when the host cannot behaviorally enforce the
declared filesystem, user-manager-socket, and control-group boundaries.
