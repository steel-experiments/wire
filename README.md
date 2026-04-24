# Wire

Wire by Steel is the zero-weight browser agent for real web work.

A small TypeScript core orchestrates real remote Chrome sessions through Steel's browser infrastructure. Actions are code-first JS/TS, not a DSL. Every run produces typed trace evidence. Policy gates destructive operations outside the reasoning loop.

## Principles

- Steel carries browser infrastructure; Wire carries intent through it.
- Keep `Task`, `Run`, `Session`, `Profile`, `Skill`, `Policy`, and `Artifact` boundaries explicit.
- Prefer platform features and small files over framework weight.
- Use runtime validation only at system boundaries (zod at persistence/provider edges).
- Every run leaves inspectable evidence: trace events, artifacts, classification, outcome summary.

## Workspace

- Node.js 22+
- `pnpm` for package management
- `tsx` for local execution
- strict TypeScript (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`)
- ESM only
- Dependencies: `zod` (boundary validation only)

## Commands

- `pnpm install` — install dependencies
- `pnpm dev` — run entry point via tsx
- `pnpm build` — compile TypeScript to dist/
- `pnpm typecheck` — type-check without emitting
- `pnpm test` — run all tests (302 tests across 12 test files)
- `pnpm check` — typecheck + test

## Architecture

```
src/
  shared/       Types, schemas, IDs, boundary validators
  storage/      File-backed JSON persistence (tasks, runs, sessions, artifacts)
  browser/      Provider contract, observation, exec, raw escape hatch, helpers
    helpers/    Thin code-generation helpers (forms, clicks, uploads, tables)
  providers/
    browser/    Steel HTTP provider, custom provider stub
    llm/        OpenAI and Anthropic LLM providers, context assembly
  policy/       Rules engine, baseline rules, approval flow
  skills/       Markdown parser, hostname/tag matcher, loader, promotion
  trace/        Event creators, artifact registry, compare views, replay timeline
  agent/        Loop state, step execution, classification, planning, runtime, branching
  experiments/  Hypotheses, ablation variants, experiment summaries
  profiles/     Profile selection, auth wall detection
  cli/          Argument parsing, task runner, main entry
  ui/           Run review formatter (terminal output)
  eval/         Evaluation metrics, benchmark harness
```

## CLI Usage

```bash
# Run a task
wire run --objective "Navigate to example.com and verify the title"

# Run with options
wire run --objective "Fill the login form" --mode task --profile profile_abc123 --model gpt-5.4-mini --max-steps 20

# Run from a task file
wire run --task-file ./task.json

# Review a completed run
wire review --run-id run_abc123

# List tasks and runs
wire list
wire list --mode task

# Approve pending actions
wire approve --run-id run_abc123
```

## Key Domain Objects

| Object | Purpose |
|--------|---------|
| **Task** | Objective + constraints + success criteria + budget |
| **Run** | One execution of a task: status, classification, trace events |
| **Session** | A browser session (Steel Chrome instance) |
| **Profile** | Browser identity for session creation |
| **Skill** | Durable site knowledge (markdown with frontmatter) |
| **Policy** | Rules that gate destructive/privileged actions |
| **Artifact** | Persisted evidence (screenshots, HTML, data, diffs) |
| **Hypothesis** | Testable claim for experiment branching |
| **ExperimentBundle** | Hypotheses + runs + comparisons for structured experiments |

## Run Classification

Every run is classified into one of:

| Kind | Meaning |
|------|---------|
| `task-complete` | Success criteria met, high confidence |
| `partial-success` | Some criteria met, some failed |
| `blocked-auth` | Auth wall requires user assistance |
| `site-error` | The site failed, not the agent |
| `agent-error` | The agent made errors |
| `infra-error` | Network or infrastructure failure |
| `counterexample` | Found evidence against a hypothesis |
| `ambiguous` | Insufficient evidence to classify |

## Configuration

### Model Selection

Wire resolves the LLM model from multiple sources, in priority order:

1. `--model <model-id>` CLI flag
2. `WIRE_MODEL` environment variable
3. `model` field in project `wire.json`
4. `model` field in `~/.wire/config.json` (user-level default)
5. Provider default (`gpt-5.4-mini` for OpenAI, `claude-sonnet-4-6` for Anthropic)

```bash
# CLI flag (highest priority)
wire run --objective "Open example.com" --model gpt-5.4-mini

# Environment variable
WIRE_MODEL=claude-sonnet-4-6 wire run --objective "Open example.com"

# Project-level config: wire.json in project root
echo '{"model": "gpt-5.4-mini"}' > wire.json

# User-level default: ~/.wire/config.json
mkdir -p ~/.wire && echo '{"model": "claude-sonnet-4-6"}' > ~/.wire/config.json
```

### Environment Variables

- `STEEL_API_KEY` — Steel browser API key (required for Steel provider)
- `OPENAI_API_KEY` — OpenAI API key (for LLM-powered agent turns)
- `ANTHROPIC_API_KEY` — Anthropic API key (alternative LLM provider)
- `WIRE_MODEL` — Override the LLM model
- `WIRE_ROOT` — Storage root directory (default: `.wire`)
