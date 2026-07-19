# Cross-agent comparison harness

Runs the **same web tasks** through four agent configurations and scores them
with **one shared blind LLM judge**, so the only thing that varies is the agent.

## Arms

| Arm | What runs | Lever |
|-----|-----------|-------|
| `wire` | `wire "<obj>" --json --quiet` | Wire alone (Steel cloud browser) |
| `cc-skill` | `claude -p` with a browser **skill** available | tests whether the skill makes CC competitive |
| `cc-wire-cli` | `claude -p`, skills off, `wire` CLI exposed as a tool | CC **orchestrating** Wire |
| `cc-bare` | `claude -p`, skills off, no wire | bare CC improvising with native tools (WebFetch/Bash) |

`cc-bare` uses `--disable-slash-commands` to switch all skills off. `cc-wire-cli`
does the same and injects a system-prompt hint describing the `wire` CLI.
`cc-skill` leaves skills on and names the browser skill in a one-line hint.

## What is measured (and why it's fair)

- **judge** — one shared judge, same strict multi-dimensional rubric for every
  arm, blind to which arm produced the answer (sees only objective + final
  answer). Explicit missing-content and format caps prevent partial answers
  from saturating at 1.0. Score 0..1;
  `success` = score ≥ threshold and the arm actually returned an answer.
- **wall** — wall-clock measured by the harness around each subprocess. This is
  the one latency number that is directly comparable across arms.
- **cost / turns** — from `claude -p`'s `total_cost_usd` / `num_turns`. Wire does
  not surface token cost on its run envelope, so its cost shows `n/a`.

The arms use different underlying models by nature (CC = Claude, Wire = its
configured provider). That difference is *part of* the agent comparison; each
arm records the model it used.

## Run

```bash
# full suite, all arms, 1 rep
npx tsx benchmarks/compare/run-compare.ts

# quick smoke: just the HN task
npx tsx benchmarks/compare/run-compare.ts --tasks hackernews-top5

# pick arms / reps / models
npx tsx benchmarks/compare/run-compare.ts \
  --arms wire,cc-skill,cc-bare \
  --reps 3 \
  --cc-model claude-sonnet-4-6 \
  --wire-provider openai --wire-model gpt-5.4-mini \
  --judge-model claude-haiku-4-5-20251001 \
  --judge-threshold 0.7

# high-resolution suite with exact counts, fields, URLs, and partial-credit room
npx tsx benchmarks/compare/run-compare.ts \
  --suite benchmarks/compare/suite-quality-v1.json \
  --arms wire --wire-provider zai --wire-model glm-4.7 \
  --judge-provider gemini --judge-model gemini-3.1-pro-preview
```

### Flags

| Flag | Default | Meaning |
|------|---------|---------|
| `--suite <path>` | `suite.json` | task list |
| `--tasks a,b` | all | only these task ids |
| `--arms a,b` | all four | which arms to run |
| `--reps N` | 1 | repetitions per (task, arm) — raise for variance |
| `--cc-model` | `claude-sonnet-4-6` | model for the Claude Code arms |
| `--wire-provider` / `--wire-model` | `anthropic` / `claude-sonnet-4-6` | Wire's LLM (defaults match the CC arms for a fair, model-controlled comparison) |
| `--skill` | `steel-browser` | browser skill name used by `cc-skill` |
| `--judge-provider` | `claude` | shared blind judge provider: `claude` or `gemini` |
| `--judge-model` | `claude-haiku-4-5-20251001` | the shared judge |
| `--judge-threshold` | `0.7` | judge score that counts as success |
| `--timeout` | `360000` | per-arm wall-clock timeout (ms) |
| `--skip-build` | off | skip the up-front `pnpm build` (use when dist is known-fresh) |

The harness loads the project `.env` and **rebuilds `dist` before running the
wire arm**, then refuses to start if `STEEL_API_KEY` (and an LLM key) are
missing — so the wire arm can never be silently scored 0 by a stale build or a
missing key. Pass `--arms` without `wire` to skip both checks.

## Output

`results/<timestamp>/results.jsonl` (one record per run, written incrementally)
and `report.md` (per-arm summary + per-task breakdown). `results/` is gitignored.

## Caveats

- **Judge bias.** The default judge is a Claude model scoring Claude-and-Wire
  output. It is blind to arm identity, but for maximum neutrality point
  `--judge-model` at a non-Anthropic model.
- **Live pages.** HN / LessWrong / Booking change constantly, so the judge
  scores correctness-of-form against the objective, not against a fixed
  ground truth. For exact-match scoring, capture a reference snapshot per run.
- **`cc-skill` requires the named skill to be installed** (`~/.claude/skills/`).
  If `steel-browser` is not installed, pass `--skill agent-browser` to use the
  locally-installed Chrome-based skill instead (note: different browser backend
  than Wire's Steel cloud — that becomes a confound).
- Claude Code arms run with `--dangerously-skip-permissions` so they execute
  unattended. Only run this against tasks/sites you trust.
