# Wire Improvements — Batch 2

Inspired by patterns observed in [Flue](https://github.com/nikkö/flue), an autonomous agent harness framework.
Each improvement is adapted to Wire's zero-weight philosophy: no framework weight, no hidden retries, no prompt soup, and no drift away from real-browser execution.

Version: 0.2
Status: Draft
LOC budget: 12,500 (non-test `src/`); current measured baseline is ~11,948 non-test lines in `src/`. Any implementation here should still pair additions with deletions so the cap is not crossed by follow-on work.

---

## Table of Contents

1. [Deployment Triggers](#1-deployment-triggers)
2. [Experiment Fan-Out](#2-experiment-fan-out)
3. [Context Compaction](#3-context-compaction)
4. [Browser Preflight Checks](#4-browser-preflight-checks)

---

## 1. Deployment Triggers

### Origin

Flue agents declare triggers declaratively (`{ webhook: true }`, `{ cron: "0 9 * * 1-5" }`) and get HTTP endpoints or scheduled invocations at build time. Wire currently only runs via CLI invocation: `wire run "do the thing"`.

### Problem

Wire is a CLI-first tool. Users must manually invoke it, wait for completion, and extract results. Real browser tasks often need to happen on a schedule (nightly price checks), in response to events (webhooks from Zapier or internal systems), or unattended (batch workflows). The lack of deployment flexibility forces humans into the loop for every run.

### Proposal

Add a trigger layer that lets Wire runs be initiated by something other than a human at a terminal, while keeping execution itself unchanged: each fired trigger still becomes a normal Wire task and a normal Wire run.

#### 1.1 Trigger Types

```typescript
// src/triggers/types.ts

interface Trigger {
  id: string;
  type: "cron" | "webhook";
  task: TaskDefinition;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
}

interface TaskDefinition {
  objective: string;
  mode: TaskMode;
  constraints?: string[];
  successCriteria?: string[];
  budget?: TaskBudget;
  profileId?: ProfileId;
  skillOverrides?: string[];
}

interface CronTrigger extends Trigger {
  type: "cron";
  schedule: string;           // standard 5-field cron expression
  timezone?: string;          // defaults to system timezone
  maxConcurrentRuns: number;  // prevent pile-ups if a run overshoots
}

interface WebhookTrigger extends Trigger {
  type: "webhook";
  method: "POST";
  secretEnv: string;          // env var name containing the HMAC secret
  payloadTemplate?: string;   // JSON path extraction for objective templating
}
```

#### 1.2 Storage

Triggers are persisted as YAML files in a `.wire/triggers/` directory (one file per trigger). This keeps the pattern consistent with skills: file-based, inspectable, and database-free.

Webhook triggers must not store raw shared secrets in YAML. They store only an environment-variable reference, and the runtime resolves the actual secret at process start.

```yaml
# .wire/triggers/nightly-prices.yaml
id: nightly-prices
type: cron
schedule: "30 2 * * *"
timezone: "America/New_York"
maxConcurrentRuns: 1
enabled: true
task:
  objective: "Check current prices for all items on the watchlist at {{url}}"
  mode: task
  successCriteria:
    - "Price data extracted for each item"
    - "Results saved as artifact"
  budget:
    maxUsd: 0.50
```

```yaml
# .wire/triggers/inbound-order.yaml
id: inbound-order
type: webhook
method: POST
secretEnv: WIRE_TRIGGER_INBOUND_ORDER_SECRET
enabled: true
payloadTemplate: "$.order.adminUrl"
task:
  objective: "Open {{payload}} and verify the new order is visible in admin"
  mode: task
```

#### 1.3 Trigger Engine

A lightweight `TriggerEngine` that:

1. **Loads** all trigger definitions from `.wire/triggers/` on startup.
2. **For cron**: evaluates schedules and starts a normal Wire task when a trigger becomes due. Uses `setInterval` with 60s granularity; no external cron daemon needed.
3. **For webhook**: exposes a single HTTP endpoint via Node's `http` module, validates HMAC using the resolved env secret, extracts payload values, templates the objective, and starts a normal Wire task.
4. **Never owns execution semantics**: it is an entry point only. All run behavior remains in `executeTask()`.

```typescript
// src/triggers/engine.ts

interface TriggerEngine {
  start(): Promise<void>;
  stop(): Promise<void>;
  register(trigger: Trigger): Promise<void>;
  unregister(triggerId: string): Promise<void>;
  list(): Trigger[];
}
```

#### 1.4 Run Isolation

Each fired trigger gets its own `Run` with a `triggerId` field in run metadata. Runs fired by the same trigger share the same trigger identity but still remain normal independent runs with their own artifacts, traces, and browser sessions.

If `maxConcurrentRuns` is reached, the trigger skips that firing and logs a `trigger-skipped` trace event. No implicit queueing. If teams want queueing later, that should be a separate design decision.

#### 1.5 CLI Commands

```text
wire trigger list
wire trigger add .wire/triggers/mine.yaml
wire trigger remove <id>
wire trigger fire <id>
wire serve --port 8080
```

`wire serve` is the deployment entry point: it starts the trigger engine and blocks, listening for webhooks and checking cron schedules. `wire run` remains unchanged for local use.

#### 1.6 Guardrails

- Secret material stays out of trigger files and out of LLM context.
- Trigger files define tasks, not arbitrary shell work.
- Trigger firing must emit ordinary trace evidence so unattended runs are still reviewable.

#### 1.7 LOC Estimate

~250-320 lines: trigger types, trigger file loader, cron evaluator, webhook handler, CLI commands, and tests.

---

## 2. Experiment Fan-Out

### Origin

Flue's `task` tool lets an agent spawn child agents with separate sessions and contexts. The useful idea is not "nested agent systems" by itself; the useful idea is the ability to explore multiple paths when one run is not enough.

Wire already has an experiment and branching story. The codebase can create related runs with `parentRunId`, `branchLabel`, and experiment bundles today. The opportunity is to make that branching more deliberate and more efficient without turning Wire into a sub-agent orchestration framework.

### Problem

Some experiment-mode tasks decompose into independent variants:

- "Try three extraction strategies and compare reliability."
- "Check this flow under three profiles."
- "Probe five candidate entry URLs to find the cheapest stable path."

Today experiment branching is sequential. That preserves simplicity, but it also stretches wall-clock time for clearly independent variants. The missing capability is not "agents delegating to agents." The missing capability is runtime-managed fan-out for bounded experiment branches.

### Proposal

Extend the existing experiment runner so it can launch a small, explicit set of sibling branch runs in parallel. This remains a runtime concern, not an in-loop `delegate` action.

The model still reasons about one run at a time. The runtime decides whether to schedule branch variants concurrently based on explicit experiment configuration and policy limits.

#### 2.1 Core Principle

This proposal intentionally does **not** add:

- a new `delegate` action kind,
- nested child-agent hierarchies,
- parent-context mutation during a live run,
- inter-branch communication,
- generic "Wire calling Wire" orchestration.

Instead, it tightens what already exists:

- top-level run,
- sibling branch runs,
- experiment bundle,
- comparison summary after all branches complete.

#### 2.2 Fan-Out Model

```typescript
interface ExperimentBranchSpec {
  label: string;
  objectivePatch?: string;
  constraintsAppend?: string[];
  profileId?: ProfileId;
  sessionConfigPatch?: Partial<SessionConfig>;
}

interface ExperimentFanOutConfig {
  enabled: boolean;
  maxParallelBranches: number;
}
```

Each branch is still just a normal Wire task/run pair. The only difference is that the runner may schedule sibling branches concurrently when:

1. the task is in `experiment` mode,
2. the branch specs are explicit and bounded,
3. the policy budget allows it,
4. the branches do not depend on shared browser state.

#### 2.3 Execution Semantics

1. Start from the existing top-level experiment run.
2. If the runner decides additional variants are needed, construct sibling branch tasks using the existing `parentRunId` and `branchLabel` model.
3. Launch up to `maxParallelBranches` sibling runs concurrently.
4. Wait for branch completion.
5. Build the experiment bundle and comparison summary from the resulting normal runs.

The parent run does not "pause and absorb children." There are only peer runs tied together by experiment metadata.

#### 2.4 Scope Boundary

This keeps Wire inside its current scope:

- experiment support stays first-class,
- browser sessions remain isolated per run,
- there is still one stateful browser connection per run,
- no new agent-in-agent control plane is introduced.

#### 2.5 Policy Rules

| Rule | Description | Default |
|------|-------------|---------|
| `max-parallel-branches` | Max concurrent sibling experiment runs | 3 |
| `require-approval-for-fanout` | Human approval before spawning multiple branches | false |
| `fanout-mode-only` | Allow fan-out only in `experiment` mode | true |

#### 2.6 LOC Estimate

~120-180 lines: runner scheduling changes, branch spec plumbing, policy checks, and tests. This is materially smaller than introducing a new orchestration primitive because it reuses existing run and experiment structures.

---

## 3. Context Compaction

### Origin

Flue has built-in context compaction that fires on two conditions: threshold and overflow. It summarizes older messages and replaces them with a compaction entry in session history.

Wire currently handles long tasks by truncating recent traces to the last few events and observations. There is no durable summary of early progress inside live context, so the agent can lose track of what it already tried.

### Problem

For long tasks, the context window fills with trace events, observations, and skill content. Truncation alone is lossy in the wrong way: the agent forgets prior attempts, earlier failures, and partial progress, then repeats dead-end strategies.

What is needed is compaction that preserves operational facts while freeing room for fresh reasoning.

### Proposal

Add a compaction layer that runs between agent turns and summarizes older context into a compact "progress summary" for prompt use only.

The summary is advisory context, not authoritative evidence. Raw trace events remain the source of truth on disk.

#### 3.1 Compaction Trigger

```typescript
// src/agent/compaction.ts

interface CompactionConfig {
  enabled: boolean;
  triggerThreshold: number;    // compact when context tokens exceed this fraction of window (0.0-1.0)
  keepRecentSteps: number;     // always preserve the last N steps uncompressed
  maxSummaryTokens: number;    // target size for the compacted summary
}

const DEFAULT_COMPACTION: CompactionConfig = {
  enabled: true,
  triggerThreshold: 0.7,
  keepRecentSteps: 5,
  maxSummaryTokens: 800,
};
```

Compaction fires when:

1. **Threshold**: estimated prompt size exceeds `triggerThreshold * contextWindowSize`.
2. **Overflow**: the LLM returns a context-length error.

#### 3.2 Compaction Process

When compaction triggers:

1. Split the trace history into `older` and `recent`.
2. Summarize the `older` region using a dedicated LLM call with a fixed prompt.
3. Replace only the prompt-visible older region with a single `compaction-summary` entry.
4. Emit a `compaction` trace event so reviewers can see when compression happened.

```typescript
interface CompactionSummary {
  kind: "compaction-summary";
  stepsCovered: number;
  summary: string;
  createdAt: string;
  tokensSaved: number;
}
```

#### 3.3 Summary Content Rules

The summary prompt should preserve:

- URLs visited,
- actions attempted,
- outcomes observed,
- errors encountered,
- partial work completed,
- explicit dead ends.

It should omit:

- raw code blocks,
- verbose DOM dumps,
- repeated observations with no new signal.

The summary should be framed as:

- "Facts preserved for continued reasoning,"
- not "canonical replay of the run."

#### 3.4 Auditability

Compaction summaries are stored as trace events, but the original raw trace events are never deleted from the trace log. Compaction changes only what is placed into the LLM context window.

Any reviewer should be able to see:

- when compaction occurred,
- which steps were covered,
- the summary text,
- the estimated tokens saved.

#### 3.5 Cost Control

- Cap compaction at once every 5 steps.
- Use a cheaper summarization model than the primary agent model when available.
- Keep `maxSummaryTokens` bounded.

#### 3.6 LOC Estimate

~180-260 lines: compaction logic, context integration, trace event emission, token estimation, and tests.

---

## 4. Browser Preflight Checks

### Origin

Some tasks fail before a real browser session would teach us anything useful:

- the target URL is malformed,
- DNS does not resolve,
- the host is down,
- the response is an obvious non-HTML file,
- the user supplied an API endpoint rather than a web app URL.

Today Wire discovers those conditions only after paying the startup cost of a real remote browser session.

### Problem

Wire should remain a real-browser agent. Replacing browser runs with fetch-only execution tiers would change the product boundary and weaken the "browser is real" contract.

But there is still a narrow optimization available: cheap preflight checks that happen **before** a run starts, purely to reject obviously bad inputs or annotate expected conditions. That saves wasted browser startups without introducing alternate execution modes.

### Proposal

Add optional browser preflight checks that run before session creation and produce one of three outcomes:

1. `proceed`: start a normal browser-backed Wire run,
2. `warn`: start a normal run, but annotate expected risk in the trace,
3. `abort`: fail fast before browser startup because the target is clearly invalid.

This is a setup optimization, not a new runtime tier.

#### 4.1 Preflight Result

```typescript
type PreflightDisposition = "proceed" | "warn" | "abort";

interface BrowserPreflightResult {
  disposition: PreflightDisposition;
  reason: string;
  url?: string;
  statusCode?: number;
  contentType?: string;
}
```

#### 4.2 Checks

Safe candidates for preflight:

- URL parsing and normalization,
- DNS resolution failure,
- TCP/connectivity failure,
- obvious non-HTML content type on first response,
- redirect-to-download patterns,
- cheap robots or auth redirects worth surfacing before the run.

These checks should never pretend to complete the task. They are only gates or annotations before the real browser run.

#### 4.3 CLI Behavior

```text
wire run --preflight "Open https://example.com/dashboard and export invoices"
```

If preflight returns `warn`, the run still starts normally and the warning is emitted as an initial trace event.

If preflight returns `abort`, Wire exits early with a clear reason such as:

```text
Preflight failed: host did not resolve for https://example.invalid
```

#### 4.4 Scope Boundary

This is intentionally not:

- a fetch-only execution tier,
- an alternate `BrowserProvider`,
- a fallback task runner,
- a "resume later in a browser with carried-over fake progress" mechanism.

Every successful Wire task run still uses the real browser substrate.

#### 4.5 LOC Estimate

~80-140 lines: preflight helper, runner plumbing, trace annotation, and tests.

---

## Implementation Order

These improvements should be implemented in this order:

1. **Context Compaction**: highest value, cleanest fit with current architecture.
2. **Deployment Triggers**: useful new entry point with limited runtime disruption.
3. **Browser Preflight Checks**: small cost-saving guardrail that does not alter product boundaries.
4. **Experiment Fan-Out**: only after validating that the existing experiment model still stays simple under bounded parallelism.

## LOC Budget Accounting

| Improvement | Additive LOC | Notes |
|-------------|-------------|-------|
| Context Compaction | ~180-260 | New compaction logic plus prompt integration |
| Deployment Triggers | ~250-320 | New `triggers/` module |
| Browser Preflight Checks | ~80-140 | Runner-side validation only |
| Experiment Fan-Out | ~120-180 | Reuses current branch/run model |
| **Total added** | **~630-900** | Depends on test depth and code reuse |

The target here is not "spend the whole remaining budget." The target is to add only what survives the product-boundary test. Before implementation, each item should still identify concrete deletion or consolidation targets so the codebase remains comfortably under the cap.

## What We Refuse

These improvements deliberately do not include:

- **No secret-bearing trigger files.** Trigger definitions may reference env vars, but raw shared secrets do not live in YAML.
- **No sub-agent orchestration framework.** Fan-out is bounded experiment scheduling, not agents recursively spawning agents.
- **No fake non-browser task completion path.** Preflight may reject or annotate; it does not replace real-browser runs.
- **No external dependencies.** Use Node built-ins and existing providers unless a clear exception is justified.
- **No database.** Everything remains file-based where persistence is needed.
- **No hidden retries or opaque carry-forward state.** Skips, warnings, and branch scheduling must all be explicit in traces.
