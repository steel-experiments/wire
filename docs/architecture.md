# Architecture

Wire is built as a layered system with strict boundaries. Each layer owns a clearly defined set of responsibilities and does not reach across to higher layers.

## High-level diagram

```
User / CLI
    |
    v
CLI Runner (args, config, persistence orchestration)
    |
    v
Agent Runtime (loop, context, LLM turn, classification)
    |
    +---> Skills Layer (parser, matcher, loader, promotion)
    |
    +---> Policy Engine (rules, approvals)
    |
    v
Browser Bridge (observe, exec, raw)
    |
    v
Browser Provider (Steel)
    |
    v
Remote Chrome Session
```

## Layers

### 1. Browser infrastructure layer

**Owned by:** `src/providers/browser/steel.ts` (stable entrypoint), `src/providers/browser/steel/`, the Steel API

- Browser process lifecycle
- WebSocket/session lifecycle
- Profile persistence
- Replay/live viewing URLs
- Stealth/proxy posture
- Session scaling

Wire delegates all of this to Steel. It does not manage browser processes itself.

### 2. Browser bridge layer

**Owned by:** `src/browser/`

| File | Responsibility |
|------|---------------|
| `bridge.ts` | `BrowserProvider` interface contract |
| `observe.ts` | Compact page orientation snapshots |
| `exec.ts` | JavaScript execution in the browser |
| `raw.ts` | CDP escape hatch |
| `session.ts` | Session create/stop lifecycle |
| `targets.ts` | Tab routing and focus |
| `helpers.ts` | Thin helper code injected into exec |

The bridge exposes exactly three first-class operations: `observe()`, `exec()`, and `raw()`.

### 3. Agent runtime layer

**Owned by:** `src/agent/`

| File | Responsibility |
|------|---------------|
| `runtime.ts` | Top-level `executeTask()` orchestrator, state setup, main loop |
| `turn.ts` | LLM prompt context construction and next-action selection |
| `loop.ts` | Loop state, step execution, stopping conditions |
| `loop-result.ts` | Final result derivation, run classification, scoring |
| `context.ts` | System/user prompt assembly, action guidance |
| `action-guidance.ts` | Structured base action guidance with core/helper/skill ownership metadata |
| `planning.ts` | Task plan creation and advancement |
| `classify.ts` | Post-run classification (task-complete, partial-success, etc.) |
| `branching.ts` | Experiment-mode branching decisions |
| `state-helpers.ts` | Pure functions for inspecting loop state |
| `actions.ts` | Action registry for provider-specific actions |
| `llm-parse.ts` | LLM response parsing and action extraction |
| `skill-context.ts` | Runtime skill matching and prompt-ready skill guidance |
| `artifact-review.ts` | Artifact review prompts, dedupe, retry bookkeeping |
| `evidence.ts` | Latest extraction evidence per URL for prompt reuse |
| `llm-trace.ts` | Optional LLM call/usage trace events |
| `contract.ts` | Completion contracts — verified before finish is accepted |
| `refine.ts` | Run result refinement |
| `compare.ts` | Cross-run comparison logic |
| `prompts.ts` | Static prompt fragments |

The runtime owns the turn loop: observe, ask the LLM, policy-check, execute, persist trace, evaluate progress, repeat.

### 4. Skills layer

**Owned by:** `src/skills/`

| File | Responsibility |
|------|---------------|
| `parser.ts` | Frontmatter and section extraction from markdown |
| `matcher.ts` | Hostname and tag matching |
| `loader.ts` | Load matching skills from a directory |
| `promote.ts` | LLM-driven skill proposal and file promotion |
| `stats.ts` | Skill usage statistics from run outcomes |

Skills are markdown files with YAML frontmatter. They contain durable site knowledge, not run diaries.

### 5. Policy layer

**Owned by:** `src/policy/`

| File | Responsibility |
|------|---------------|
| `engine.ts` | `PolicyEngine` interface and factory |
| `rules.ts` | Baseline rules and exec risk classification |
| `approvals.ts` | Approval request lifecycle (pending, approved, rejected, expired) |

Policy is outside the reasoning loop. The model proposes actions; policy decides what is allowed.

### 6. Trace and artifact layer

**Owned by:** `src/trace/`, `src/storage/`

| File | Responsibility |
|------|---------------|
| `trace/replay.ts` | Timeline building and summarization |
| `storage/events.ts` | Trace event persistence |
| `storage/artifacts.ts` | Artifact metadata persistence |
| `storage/artifact-registry.ts` | Artifact content deduplication |
| `storage/blobs.ts` | Large content storage (LLM messages, artifact content) |
| `storage/checkpoints.ts` | Run checkpoint save/load for approval resume |
| `storage/runs.ts` | Run and experiment bundle persistence |
| `storage/sessions.ts` | Browser session records |
| `storage/tasks.ts` | Task records |
| `storage/approvals.ts` | Approval request records |
| `storage/atomic.ts` | Atomic JSON file read/write primitives |

Every run leaves immutable trace events and artifacts. No silent retries.

### 7. CLI layer

**Owned by:** `src/cli/`

| File | Responsibility |
|------|---------------|
| `main.ts` | Command dispatch and output formatting |
| `args.ts` | Argument parsing |
| `runner.ts` | Task execution orchestration, artifact persistence, approval resume |
| `config.ts` | LLM and project config loading |
| `paths.ts` | Storage root and skill directory resolution |
| `output.ts` | JSON envelope helpers |
| `errors.ts` | Error classification for JSON output |

### 8. Evaluation layer

**Owned by:** `src/eval/`

| File | Responsibility |
|------|---------------|
| `bench.ts` | Benchmark runner with persistence |
| `metrics.ts` | Task metric computation |
| `scoring.ts` | Run scoring and quality assessment |
| `trajectories.ts` | Trace-to-training export formats |

### 9. Supporting modules

| Directory | Responsibility |
|-----------|---------------|
| `src/shared/` | Types, schemas, IDs, boundary validators, redaction, secrets |
| `src/experiments/` | Hypothesis and experiment summary types |
| `src/profiles/` | Auth wall detection |
| `src/ui/` | Terminal output formatting, review display, trace streaming |

## Design rules

1. **Browser lifecycle is not mixed with agent reasoning.** The bridge attaches; the runtime reasons.
2. **Policy is not mixed with action generation.** The model proposes; policy decides.
3. **Traces are not mixed with mutable working memory.** Events are append-only.
4. **Skills are not mixed with run narration.** Skills store durable facts, not transcripts.
5. **Infrastructure concerns are not mixed with product semantics.** Steel handles the fleet; Wire handles the intent.

## Module layout

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
  ui/           Terminal output formatting, review display, stream
```
