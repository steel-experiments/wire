# Getting Started

## Prerequisites

- Node.js 22+
- pnpm 10+
- A Steel API key (browser infrastructure)
- An OpenAI or Anthropic API key (LLM reasoning)

## Install

```bash
git clone <repo-url> wire && cd wire
pnpm install
```

## Set up API keys

```bash
export STEEL_API_KEY=sk_steel_...      # required — browser sessions
export OPENAI_API_KEY=sk-...           # or ANTHROPIC_API_KEY
```

If both LLM keys are present and no provider or inferable model is configured, Wire defaults to OpenAI. Specify a provider when you want Anthropic or want the choice recorded explicitly:

```bash
export WIRE_PROVIDER=openai            # or anthropic
```

## Run your first task

```bash
# Using the dev runner
npx tsx src/index.ts run --objective "Go to example.com and return the heading text"

# Using the CLI after build
pnpm build && wire run --objective "Go to example.com and return the heading text"
```

Wire creates a Task, opens a real Chrome session through Steel, and runs the agent loop. When the run finishes it prints:

- **Run ID** — use this to review or replay later
- **Status** — `succeeded`, `failed`, `aborted`
- **Classification** — `task-complete`, `partial-success`, `blocked-auth`, etc.
- **Result** — the extracted answer or outcome summary
- **Artifacts** — files persisted under `~/.wire/state/`

## Review a run

```bash
wire review --run-id run_abc123        # human-readable timeline
wire review --run-id run_abc123 --json  # machine-readable JSON
wire result --run-id run_abc123        # just the final result text
wire replay --run-id run_abc123        # step-by-step timeline
```

## List tasks and runs

```bash
wire list
wire list --mode task
wire list --json
```

## Approve a pending action

When the agent hits a policy gate (e.g., a form submission), the run pauses with status `awaiting-approval`. Approve it with:

```bash
wire approve --run-id run_abc123
```

The run resumes from the checkpoint and continues to completion.

## Common options

```bash
wire run --objective "..." --mode task --max-steps 20
wire run --objective "..." --provider openai --model gpt-5.4-mini
wire run --objective "..." --skill-dir ./skills
wire run --objective "..." --use-proxy --solve-captcha --stealth-browser
wire run --objective "..." --json --yes    # CI-friendly, auto-approve
wire run --objective "..." --verbose       # stream every trace event
```

## Development commands

| Command | What it does |
|---------|-------------|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Run via tsx (development) |
| `pnpm build` | Compile TypeScript to `dist/` |
| `pnpm test` | Run all tests |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm check` | typecheck + test |

## Next steps

- [Architecture](architecture.md) — understand the layers and boundaries
- [CLI Reference](cli-reference.md) — every command and flag
- [Skills System](skills-system.md) — write and use domain knowledge files
- [Configuration](configuration.md) — LLM providers, env vars, `wire.json`
