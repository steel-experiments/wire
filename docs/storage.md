# Storage

Wire uses file-backed JSON persistence. All state lives under a configurable root directory.

## Directory structure

Default root: `~/.wire/state/` (or `$WIRE_ROOT`)

```
~/.wire/
  config.json                          # User-level config
  skills/                              # Skill markdown files
  state/                               # Persistence root ($WIRE_ROOT)
    tasks/
      task_abc123.json                 # Task record
    runs/
      run_def456.json                  # Run record
      experiment_ghi789.json           # Experiment bundle
      hypothesis_jkl012.json           # Hypothesis record
    sessions/
      session_mno345.json              # Browser session record
    artifacts/
      artifact_pqr678.json             # Artifact metadata
      artifact_pqr678.md               # Artifact content (if text)
    events/
      run_def456/
        event_vwx234.json              # Individual trace event
    approvals/
      approval_stu901.json             # Approval request
    checkpoints/
      run_def456.json                  # Run checkpoint (for approval resume)
    blobs/
      run_def456/
        <hash>.json                    # Large content blobs
    benchmarks/
      bench_2026-05-20_*.json          # Benchmark reports
```

## Path resolution

`src/cli/paths.ts` resolves storage paths in priority order:

| Path | Priority 1 | Priority 2 | Priority 3 |
|------|-----------|-----------|-----------|
| **Storage root** | `$WIRE_ROOT` | `$WIRE_HOME/state` | `~/.wire/state` |
| **Skill directory** | `--skill-dir` flag | `$WIRE_SKILLS` | `~/.wire/skills` |
| **Home directory** | `$WIRE_HOME` | — | `~/.wire` |

## Atomic file operations

`src/storage/atomic.ts` provides safe file primitives:

- **`atomicWriteJson(path, data)`** — Write JSON with atomic rename
- **`readJsonFile(path)`** — Read and parse JSON (returns `undefined` if missing)
- **`entityPath(root, kind, id)`** — Resolve path for a typed entity
- **`entityDir(root, kind)`** — Resolve directory for an entity kind
- **`listJsonFiles(dir)`** — List `.json` files in a directory
- **`ensureDir(dir)`** — Create directory if missing
- **`NotFoundError`** — Thrown when an entity file doesn't exist
- **`CorruptError`** — Thrown when a file fails schema validation

All entity files are individual JSON documents keyed by their entity ID.

## Entity storage modules

### Tasks (`src/storage/tasks.ts`)

- `saveTask(root, task)` — Persist a task
- `loadTask(root, taskId)` — Load a task
- `listTasks(root)` — List all tasks

### Runs (`src/storage/runs.ts`)

- `saveRun(root, run)` — Persist a run
- `loadRun(root, runId)` — Load a run
- `listRuns(root, taskId?)` — List runs, optionally filtered by task
- `saveExperimentBundle(root, bundle)` — Persist an experiment bundle
- `saveHypothesis(root, hypothesis)` — Persist a hypothesis

### Sessions (`src/storage/sessions.ts`)

- `saveSession(root, session)` — Persist a browser session record

### Events (`src/storage/events.ts`)

- `saveTraceEvents(root, events)` — Persist trace events for a run
- `listTraceEvents(root, runId)` — List all events for a run

Events are stored as individual JSON files under `events/{runId}/`.

### Artifacts (`src/storage/artifacts.ts`)

- `saveArtifact(root, artifact)` — Persist artifact metadata
- `loadArtifact(root, artifactId)` — Load artifact metadata
- `listArtifacts(root, runId?)` — List artifacts, optionally filtered by run

Artifact content is written to the `path` specified in the artifact record.

### Blobs (`src/storage/blobs.ts`)

- `saveTraceBlobValue(root, runId, kind, value, contentType?)` — Store large content
- `loadTraceBlob(root, runId, hash)` — Load a blob by hash

Blobs deduplicate large content (LLM messages, artifact content) by canonical JSON hash.

### Approvals (`src/storage/approvals.ts`)

- `saveApprovalRequest(root, request)` — Persist an approval request
- `loadApprovalRequest(root, approvalId)` — Load an approval request
- `listApprovalRequests(root, runId?)` — List approval requests

### Checkpoints (`src/storage/checkpoints.ts`)

- `saveRunCheckpoint(root, checkpoint)` — Save full loop state for approval resume
- `loadRunCheckpoint(root, runId)` — Load a checkpoint
- `deleteRunCheckpoint(root, runId)` — Remove a checkpoint after resume

## Artifact persistence flow

When a run completes, `src/cli/runner.ts`:

1. Iterates over `artifact` trace events
2. Writes content to the artifact's resolved file path
3. Saves artifact metadata as JSON
4. Saves content hash to blob storage
5. Stores the task, run, and all trace events
6. If pending approval: saves the checkpoint and approval request
7. If no pending approval: deletes any stale checkpoint

## Boundary validation

All entity reads are validated against Zod schemas defined in `src/shared/schemas.ts`. Validation happens at the storage boundary — on read from disk, not on internal construction.

The `parseBoundary<T>(schema, data, label)` helper validates raw data against a Zod schema and throws a descriptive error on mismatch.
