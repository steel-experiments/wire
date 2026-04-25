# Wire

Wire is a zero-weight browser agent. Give it an objective, it drives a real Chrome session through Steel, and returns structured results with full trace evidence.

```
wire run --objective "Go to example.com and return the heading text"
```

That's the core loop. Everything else — classification, skills, policy, benchmarks — builds on top of it.

## Quick start

```bash
pnpm install
pnpm test          # 449 tests across 19 files

# Set up API keys
export STEEL_API_KEY=...     # browser infrastructure
export OPENAI_API_KEY=...    # or ANTHROPIC_API_KEY

# Run a task
npx tsx src/index.ts run --objective "Navigate to example.com and verify the title"
```

## CLI

```bash
wire run     --objective "..."                   # execute a task
wire review  --run-id run_abc123                  # inspect a completed run
wire result  --run-id run_abc123                  # print the final result
wire list                                         # list tasks and runs
wire approve --run-id run_abc123                  # approve a pending action
wire replay  --run-id run_abc123                  # replay a run and show timeline
wire bench                                        # run the benchmark suite
```

### Run options

```bash
wire run --objective "..." --mode task --max-steps 20
wire run --objective "..." --provider openai --model gpt-5.4-mini
wire run --objective "..." --profile profile_abc123
wire run --task-file ./task.json
```

### Bench options

```bash
wire bench                                         # default 5-task suite
wire bench --benchmarks benchmarks/custom.json     # custom benchmark file
wire bench --provider openai --model gpt-5.4-mini  # specific LLM
wire bench --json                                   # JSON for CI (exits 1 on failure)
```

Reports persist to `.wire/benchmarks/` so you can diff across changes:

```bash
diff <(jq '.' .wire/benchmarks/bench-old.json) <(jq '.' .wire/benchmarks/bench-new.json)
```

## How it works

1. **You provide an objective.** Wire creates a Task and opens a real Chrome session via Steel.
2. **The agent loops.** Each step: observe the page, reason with an LLM, execute JavaScript in the browser. Actions are real code, not a DSL.
3. **Policy gates destructive ops.** Submissions, purchases, and deletions require explicit approval. Deny rules block irreversible actions outright.
4. **Every run leaves evidence.** Trace events, artifacts, a classification, and an outcome summary — all persisted as JSON under `.wire/`.
5. **Skills accumulate.** After a run, Wire proposes durable markdown skills from reusable patterns it discovered (routes, selectors, traps). These are loaded automatically on future visits to the same site.

## Domain objects

| Object | What it is |
|--------|------------|
| **Task** | Objective + constraints + success criteria + budget |
| **Run** | One execution of a task: status, classification, trace, result |
| **Session** | A Steel Chrome instance |
| **Skill** | Durable site knowledge (markdown with frontmatter) |
| **Policy** | Rules that gate destructive or privileged actions |
| **Artifact** | Persisted evidence: screenshots, HTML, extracted data |

## Run classification

Every run gets one of:

| Kind | Meaning |
|------|---------|
| `task-complete` | Success criteria met |
| `partial-success` | Some criteria met, some failed |
| `blocked-auth` | Hit a login wall |
| `site-error` | The site failed, not the agent |
| `agent-error` | The agent made errors |
| `infra-error` | Network or infrastructure failure |
| `ambiguous` | Insufficient evidence to classify |

## Configuration

LLM settings resolve in priority order:

1. CLI flags: `--provider openai --model gpt-5.4-mini`
2. Environment: `WIRE_PROVIDER`, `WIRE_MODEL`
3. Project config: `wire.json` → `{"llm":{"provider":"openai","model":"gpt-5.4-mini"}}`
4. User config: `~/.wire/config.json`
5. Default: `gpt-5.4-mini` for OpenAI, `claude-sonnet-4-6` for Anthropic

If both API keys are present, you must specify which provider to use. Wire rejects mismatched pairs.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `STEEL_API_KEY` | Steel browser API key (required) |
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `WIRE_PROVIDER` | Override LLM provider (`openai` or `anthropic`) |
| `WIRE_MODEL` | Override LLM model |
| `WIRE_ROOT` | Storage root (default: `.wire`) |

## Architecture

```
src/
  shared/       Types, schemas, IDs, boundary validators
  storage/      File-backed JSON persistence
  browser/      Provider contract, observation, exec, helpers
  providers/    Steel browser provider, OpenAI/Anthropic LLM providers
  policy/       Rules engine, baseline rules, approval flow
  skills/       Markdown parser, hostname/tag matcher, loader, promotion
  agent/        Loop state, step execution, classification, planning, runtime
  trace/        Event creators, artifact registry, compare, replay
  experiments/  Hypotheses, ablations, experiment summaries
  profiles/     Profile selection, auth wall detection
  cli/          Argument parsing, task runner, main entry
  eval/         Evaluation metrics, benchmark runner with persistence
  ui/           Terminal output formatting, review display
```

## Development

| Command | What it does |
|---------|-------------|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Run via tsx |
| `pnpm build` | Compile to dist/ |
| `pnpm test` | Run all tests (449 across 19 files) |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm check` | typecheck + test |

Node.js 22+, pnpm, strict TypeScript, ESM only. One dependency: `zod` (boundary validation only).
