# CLI Reference

Wire's CLI is the primary interface for running tasks, reviewing results, and managing the agent.

## Synopsis

```
wire [command] [options]
wire <objective>
```

## Commands

### `run` (default)

Execute a browser task.

```bash
wire run --objective "Go to example.com and return the heading text"
wire --objective "Go to example.com and return the heading text"
wire "Go to example.com and return the heading text"
```

All three forms are equivalent. If no command is specified, `run` is assumed.

### `review`

Inspect a completed run.

```bash
wire review --run-id run_abc123
wire review --task-id task_def456
wire review --run-id run_abc123 --json
```

Shows the full timeline: task info, run status, classification, trace events, artifacts, and a quality score.

### `result`

Print the final result for a run.

```bash
wire result --run-id run_abc123
wire result --run-id run_abc123 --json
```

### `list`

List all tasks and runs.

```bash
wire list
wire list --mode task
wire list --json
```

### `approve`

Approve a pending action and resume the run.

```bash
wire approve --run-id run_abc123
```

Resumes from the checkpoint, re-executes the approved action, and continues the loop.

### `replay`

Replay a run and show the step-by-step timeline.

```bash
wire replay --run-id run_abc123
wire replay --run-id run_abc123 --json
```

### `craft`

Crystallize a completed run into a re-runnable browser script: its successful
`exec` steps, in order, annotated by intent (navigate / inspect / interact).
Skills capture durable *site* knowledge; a crafted script captures the *task
solution* as inspectable, patchable code.

```bash
wire craft --run-id run_abc123
wire craft --run-id run_abc123 --out solution.js
wire craft --run-id run_abc123 --json
```

Each block is one Wire exec action (async; `wire.click`, `clickVisibleText`,
`fillByLabel`, `extractTable`, `waitForSelector` and top-level `return` are
provided by the Wire exec sandbox), so the script is meant to be re-run through
Wire and patched as the site changes.

### `bench`

Run the benchmark suite.

```bash
wire bench
wire bench --benchmarks benchmarks/custom.json
wire bench --provider openai --model gpt-5.4-mini
wire bench --json
```

Reports persist to `~/.wire/state/benchmarks/`. Use `--json` for CI integration (exits 1 on failure).

### `export`

Export scored trace trajectories for evaluation and training.

```bash
wire export --format trajectory
wire export --format sft --min-score 0.8
wire export --format preferences --min-delta 0.3
wire export --run-id run_abc123 --format trajectory --out traces.jsonl
```

## Options

### Run options

| Flag | Type | Description |
|------|------|-------------|
| `--objective <text>` | string | Task objective (required unless `--task-file`) |
| `--task-file <path>` | string | Load the task objective from a JSON file |
| `--mode <mode>` | `task`, `investigate`, `experiment` | Task mode (default: `task`) |
| `--profile <id>` | string | Browser profile to attach |
| `--provider <name>` | `openai`, `anthropic` | LLM provider |
| `--model <id>` | string | LLM model (e.g., `gpt-5.4-mini`, `claude-sonnet-4-6`) |
| `--max-steps <n>` | integer | Maximum agent steps (default: 30 for task, 20 for investigate, 25 for experiment) |
| `--skill-dir <path>` | string | Skills directory |
| `--use-proxy` | flag | Start browser with proxy |
| `--solve-captcha` | flag | Start browser with captcha support |
| `--stealth` | flag | Request stealth mode |
| `--region <code>` | string | Browser region |
| `--user-agent <ua>` | string | Browser user agent override |
| `--critical-points` | flag | Judge completion against an LLM-authored critical-point checklist (per-criterion review) instead of one all-or-nothing artifact verdict; falls back to the default reviewer when the objective yields no verifiable points |

### Review options

| Flag | Type | Description |
|------|------|-------------|
| `--run-id <id>` | string | Run to review |
| `--task-id <id>` | string | Review all runs for a task |

### List options

| Flag | Type | Description |
|------|------|-------------|
| `--mode <mode>` | string | Filter by task mode |

### Approve options

| Flag | Type | Description |
|------|------|-------------|
| `--run-id <id>` | string | Run with pending approvals (required) |

### Craft options

| Flag | Type | Description |
|------|------|-------------|
| `--run-id <id>` | string | Run to crystallize into a script (required) |
| `--out <path>` | string | Write the script to a file instead of stdout |

### Bench options

| Flag | Type | Description |
|------|------|-------------|
| `--benchmarks <path>` | string | Benchmark file (default: `benchmarks/default.json`) |
| `--provider <name>` | string | LLM provider for agent and judge |
| `--model <id>` | string | LLM model for agent and judge |

### Export options

| Flag | Type | Description |
|------|------|-------------|
| `--format <fmt>` | `trajectory`, `sft`, `rewards`, `preferences` | Export format (default: `trajectory`) |
| `--out <path>` | string | Write JSONL to file |
| `--run-id <id>` | string | Export one run |
| `--task-id <id>` | string | Export all runs for a task |
| `--min-score <n>` | float | Minimum score for SFT rows (0..1) |
| `--min-delta <n>` | float | Minimum score gap for preference pairs (0..1) |

### General options

| Flag | Type | Description |
|------|------|-------------|
| `--json` | flag | Output machine-readable JSON |
| `--yes`, `--non-interactive` | flag | Auto-approve policy actions |
| `--strict` | flag | Fail on missing config or schema violations |
| `--verbose`, `-v` | flag | Stream observations, policy checks, full output |
| `--quiet`, `-q` | flag | Suppress per-step trace stream |
| `--no-color` | flag | Disable ANSI colors |
| `--trace-llm` | flag | Store LLM messages/responses as blob refs |
| `--version`, `-V` | flag | Show version |
| `--help`, `-h` | flag | Show help |

## JSON output format

When `--json` is used, all commands return a structured envelope:

```json
{
  "command": "run",
  "status": "success",
  "data": { ... },
  "ref": "run_abc123"
}
```

On error:

```json
{
  "command": "run",
  "status": "failure",
  "data": {
    "error_class": "session",
    "error_code": "ENETWORK",
    "retryable": true,
    "hint": "Network timeout during browser exec"
  }
}
```

## Task File Format

Task files currently provide the objective only. The CLI reads the JSON file and uses its `objective` field; other fields are ignored by the current runner.

```json
{
  "objective": "Go to example.com and return the heading text"
}
```

Load with `wire run --task-file ./task.json`. Use CLI flags such as `--mode`, `--max-steps`, and `--profile` for run options.
