# Evaluation

Wire includes a built-in evaluation system for measuring agent quality through benchmarks, scoring, and training data export.

## Benchmark runner

`wire bench` runs a suite of tasks against the agent and reports results.

### Benchmark file format

A JSON file containing an array of benchmark cases:

```json
[
  {
    "id": "example-heading",
    "objective": "Navigate to example.com and return the heading text",
    "mode": "task",
    "maxSteps": 10,
    "expected": {
      "classification": "task-complete",
      "answerContains": ["Example Domain"],
      "maxSteps": 8
    }
  }
]
```

| Field | Description |
|-------|-------------|
| `id` | Test case identifier |
| `objective` | Task objective |
| `mode` | Task mode |
| `maxSteps` | Step budget for this case |
| `expected.classification` | Expected run classification |
| `expected.answerContains` | Strings that must appear in the result |
| `expected.maxSteps` | Maximum acceptable step count |

Default benchmark file: `benchmarks/default.json`

### Running benchmarks

```bash
wire bench                                         # run default suite
wire bench --benchmarks benchmarks/custom.json     # custom file
wire bench --provider openai --model gpt-5.4-mini  # specific model
wire bench --json                                   # CI mode (exits 1 on failure)
```

### Benchmark report

Each case produces a `BenchResult`:

| Field | Description |
|-------|-------------|
| `passed` | Whether the case passed all checks |
| `classificationMatch` | Whether the actual classification matches expected |
| `answerRelevance` | Whether the result contains expected strings |
| `stepCount` | Actual steps taken |
| `stepEfficiency` | Steps used / steps allowed |
| `durationMs` | Wall-clock time |
| `errorCount` | Error events during the run |
| `autoRecoveryRate` | Fraction of errors that were recovered from |
| `judgeScore` | LLM judge quality score (0-1) or null |
| `notes` | Diagnostic notes |

Reports are persisted to `~/.wire/state/benchmarks/` for cross-run comparison:

```bash
diff <(jq '.' ~/.wire/state/benchmarks/bench-old.json) \
     <(jq '.' ~/.wire/state/benchmarks/bench-new.json)
```

## Scoring

`src/eval/scoring.ts` computes a quality score for any completed run.

### Score dimensions

| Dimension | Weight | Description |
|-----------|--------|-------------|
| Classification | 0.25 | Classification kind weighted by confidence |
| Contract | 0.30 | Completion contract checks satisfied |
| Evidence | 0.20 | Observations, code results, and durable artifacts |
| Efficiency | 0.15 | Event count, repeated actions, and error penalties |
| Policy | 0.10 | Policy denials, approval friction, and expired/rejected approvals |

The overall score is a weighted composite normalized to 0..1.

## Metrics

`src/eval/metrics.ts` computes structured task metrics:

```ts
interface TaskMetrics {
  taskId: string;
  runId: string;
  success: boolean;
  classification: RunClassificationKind;
  confidence: number;
  stepCount: number;
  codeExecutions: number;
  observations: number;
  errors: number;
  artifacts: number;
  durationMs: number;
  policyChecks: number;
  approvalRequests: number;
  skillsLoaded: number;
  autoRecoveryRate: number;
}
```

These are used by benchmark reporting and aggregate evaluation summaries. Run scoring is computed separately in `src/eval/scoring.ts` from the run, trace events, artifacts, and completion contract.

## Trajectory export

`wire export` converts trace events into structured formats for evaluation and training.

### Formats

| Format | Description | Use case |
|--------|-------------|----------|
| `trajectory` | Full trace timeline with events, observations, and actions | Debugging, analysis |
| `sft` | Supervised fine-tuning pairs (prompt → response) | Model training |
| `rewards` | Scored trajectories with quality labels | Reward model training |
| `preferences` | Paired trajectories ranked by score | Preference optimization (DPO) |

### Filtering

- `--min-score <n>` — Only export SFT rows with quality score >= n
- `--min-delta <n>` — Only export preference pairs where the score gap >= n

### Output

Exports produce JSONL (one JSON object per line). Write to a file with `--out`:

```bash
wire export --format sft --min-score 0.8 --out training-data.jsonl
```

Or stream to stdout:

```bash
wire export --format trajectory --run-id run_abc123
```

## Evaluation harness

`src/eval/bench.ts` orchestrates benchmark execution:

1. Load benchmark cases from file
2. For each case, run the task via `runTask()`
3. Score the result against expected outcomes
4. Optionally run an LLM judge for quality assessment
5. Compile results into a `BenchReport`

The judge is an optional LLM call that evaluates the final result against the objective. It uses the same provider/model as the agent unless overridden.
