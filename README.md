# Wire

Wire is a zero-weight browser agent. Give it an objective, it drives a real Chrome session through Steel, and returns structured results with full trace evidence.

```
wire run --objective "Go to example.com and return the heading text"
```

That's the core loop — but the run record is the product. Every run persists its trace, artifacts, policy decisions, and a scored classification, and that record keeps paying after the run ends:

```bash
wire craft  --run-id run_abc123 --standalone --out replay.mjs   # one LLM exploration → a deterministic script
node replay.mjs <cdp-websocket-url>                             # replays against any Steel session or local Chrome, no Wire needed
wire export --format sft --min-score 0.8                        # scored traces → training/eval datasets
```

Explore expensively once; replay cheaply forever; keep every run as auditable data. Classification, skills, policy, and benchmarks all build on the same records.

## Quick start

```bash
pnpm install
pnpm test          # 913 tests across 49 files

# Set up API keys
export STEEL_API_KEY=...     # browser infrastructure
export OPENAI_API_KEY=...    # or ANTHROPIC_API_KEY / ZAI_API_KEY

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
wire craft   --run-id run_abc123                  # crystallize a run into a re-runnable script
wire export  --format trajectory                  # export scored traces for eval/training
wire bench                                        # run the benchmark suite
```

### Craft options

```bash
wire craft --run-id run_abc123                     # Wire exec script to stdout
wire craft --run-id run_abc123 --out script.js     # write to a file
wire craft --run-id run_abc123 --standalone        # self-contained Node script:
                                                   # helpers inlined, drives any CDP
                                                   # websocket, no Wire runtime
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

Reports persist to `~/.wire/state/benchmarks/` by default so you can diff across changes:

```bash
diff <(jq '.' ~/.wire/state/benchmarks/bench-old.json) <(jq '.' ~/.wire/state/benchmarks/bench-new.json)
```

## How it works

1. **You provide an objective.** Wire creates a Task and opens a real Chrome session via Steel.
2. **The agent loops.** Each step: observe the page (orientation only — URL, title, headings, element counts, bounded link samples), reason with an LLM, execute JavaScript in the browser. The agent writes its own extraction and interaction code per task. Actions are real code, not a DSL.
3. **Policy gates destructive ops.** Submissions, purchases, and deletions require explicit approval. Deny rules block irreversible actions outright.
4. **Every run leaves evidence.** Trace events, artifacts, a classification, and an outcome summary — all persisted as JSON under `~/.wire/state/` by default.
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

1. CLI flags: `--provider openai --model gpt-5.4-mini --base-url https://proxy.example.com/v1`
2. Environment: `WIRE_PROVIDER`, `WIRE_MODEL`, `WIRE_BASE_URL`
3. Project config: `wire.json` → `{"llm":{"provider":"openai","model":"gpt-5.4-mini","baseUrl":"..."}}`
4. User config: `$WIRE_HOME/config.json` (default: `~/.wire/config.json`)
5. Default: `gpt-5.4-mini` for OpenAI, `claude-sonnet-4-6` for Anthropic, `glm-4.7` for Z.ai

Wire loads `.env` from the working directory at startup, so API keys and `WIRE_*` overrides can live there. If multiple API keys are present and no provider or inferable model is configured, Wire picks the first of OpenAI, Anthropic, Z.ai. Set `WIRE_PROVIDER` (e.g. in `.env`) to choose the default explicitly. Wire rejects mismatched provider/model pairs.

The `zai` provider runs GLM models (GLM Coding Plan) through Z.ai's Anthropic-protocol coding endpoint; `glm-*` models infer it automatically. `--base-url` / `WIRE_BASE_URL` / `llm.baseUrl` point any provider at a compatible alternate endpoint. Note that the OpenAI provider speaks the Responses API, so OpenAI-compatible Chat Completions endpoints will not work with it.

### Environment variables

| Variable | Purpose |
|----------|---------|
| `STEEL_API_KEY` | Steel browser API key (required) |
| `OPENAI_API_KEY` | OpenAI API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `ZAI_API_KEY` | Z.ai API key (GLM models) |
| `WIRE_PROVIDER` | Override LLM provider (`openai`, `anthropic`, or `zai`) |
| `WIRE_MODEL` | Override LLM model |
| `WIRE_BASE_URL` | Override LLM API base URL |
| `WIRE_LLM_TIMEOUT_MS` | LLM request timeout (default: `60000`) |
| `WIRE_LLM_MAX_RETRIES` | LLM transient network retry count (default: `2`) |
| `WIRE_HOME` | User-level Wire home (default: `~/.wire`) |
| `WIRE_ROOT` | Storage root (default: `$WIRE_HOME/state`) |
| `WIRE_SKILLS` | Skills directory (default: `$WIRE_HOME/skills`) |

## Architecture

```
src/
  shared/       Types, schemas, IDs, boundary validators
  storage/      File-backed JSON persistence
  browser/      Provider contract, observation, exec, raw browser actions
  providers/    Steel browser provider, OpenAI/Anthropic LLM providers
  policy/       Rules engine, baseline rules, approval flow
  skills/       Markdown parser, hostname/tag matcher, loader, promotion
  agent/        Loop state, step execution, classification, planning, runtime
  trace/        Replay utilities for persisted run events
  experiments/  Hypotheses and experiment summaries
  profiles/     Auth wall detection
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
| `pnpm test` | Run all tests |
| `pnpm typecheck` | Type-check without emitting |
| `pnpm check` | typecheck + test |
| `pnpm metrics` | Print current source/test file and LOC counts |

Node.js 22+, pnpm, strict TypeScript, ESM only. One dependency: `zod` (boundary validation only). Treat source size as pressure: update `METRICS.md` on every code change and simplify when core modules grow or mix domains.

## Documentation

```bash
npx docsify-cli serve docs
```

Full docs at [`docs/`](docs/README.md) — architecture, domain objects, agent runtime, policy engine, skills system, CLI reference, and more.
