# Trace Training Data

Wire does not train models in core. It produces scored, redacted trace trajectories
that can be consumed later by SFT, preference, or RL pipelines.

## Export

```bash
wire export --format trajectory --out data/wire-traces.jsonl
wire export --format sft --min-score 0.8 --out data/wire-sft.jsonl
wire export --format rewards --out data/wire-rewards.jsonl
wire export --format preferences --min-delta 0.2 --out data/wire-preferences.jsonl
```

Use `--run-id` to export one run or `--task-id` to export all runs for a task.

## Formats

- `trajectory`: canonical Wire trace row with task, run score, redacted events, and artifact metadata.
- `sft`: code-action examples derived from `code-exec` events in high-scoring runs.
- `rewards`: prompt/completion rows with total score and score components.
- `preferences`: chosen/rejected pairs from multiple runs of the same task.

The score is a diagnostic signal first. Before using it as a training reward,
compare score movements against human review and inspect examples for reward
hacking.
