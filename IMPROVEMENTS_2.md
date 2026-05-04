# Wire Improvements — Batch 2

Inspired by patterns observed in [Flue](https://github.com/nikkö/flue), an autonomous agent harness framework.
Each improvement is adapted to Wire's zero-weight philosophy — no framework weight, no hidden retries, no prompt soup.

Version: 0.1
Status: Draft
LOC budget: 12,500 (non-test `src/`); currently at 12,701 — these changes must pair with deletions.

---

## Table of Contents

1. [Deployment Triggers](#1-deployment-triggers)
2. [Task Delegation (Wire Calling Wire)](#2-task-delegation-wire-calling-wire)
3. [Context Compaction](#3-context-compaction)
4. [Flexible Sandbox Tiers](#4-flexible-sandbox-tiers)

---

## 1. Deployment Triggers

### Origin

Flue agents declare triggers declaratively (`{ webhook: true }`, `{ cron: "0 9 * * 1-5" }`) and get HTTP endpoints or scheduled invocations at build time. Wire currently only runs via CLI invocation — `wire run "do the thing"`.

### Problem

Wire is a CLI-only tool. Users must manually invoke it, wait for completion, and extract results. Real-world browser tasks often need to happen on a schedule (nightly price checks), in response to events (webhook from Zapier), or unattended (long-running batch jobs). The lack of deployment flexibility forces humans into the loop for every run.

### Proposal

Add a trigger layer that lets Wire runs be initiated by something other than a human at a terminal.

#### 1.1 Trigger Types

```typescript
// src/triggers/types.ts

interface Trigger {
  id: string;
  type: "cron" | "webhook" | "cli";
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
  secret: string;             // HMAC verification
  method: "POST";
  payloadTemplate?: string;   // JSON path extraction for objective templating
}
```

#### 1.2 Storage

Triggers are persisted as YAML files in a `.wire/triggers/` directory (one file per trigger). This keeps the pattern consistent with skills (file-based, inspectable, no database).

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
    maxSteps: 30
    maxUsd: 0.50
```

#### 1.3 Trigger Engine

A lightweight `TriggerEngine` that:

1. **Loads** all trigger definitions from `.wire/triggers/` on startup.
2. **For cron**: evaluates schedules and enqueues `Task` objects at the appropriate time. Uses `setInterval` with 60s granularity — no external cron daemon needed.
3. **For webhook**: exposes a single HTTP endpoint (via Node's `http` module, no framework) that validates HMAC, extracts payload, templates the objective, and enqueues a `Task`.
4. **For cli**: the current behavior — no changes to existing CLI flow.

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

The engine does not own the agent loop. It creates `Task` objects and feeds them to the existing `executeTask()` runtime function. This keeps triggers as a thin entry point, not a new execution model.

#### 1.4 Run Isolation

Each triggered run gets its own `Run` with a `triggerId` field in the run metadata. Runs triggered by the same trigger share a `taskId` prefix but get unique `RunId`s. This preserves Wire's existing Run model without changes.

If `maxConcurrentRuns` is reached, the trigger skips that firing and logs a `trigger-skipped` trace event. No queueing — queuing is complexity we don't need yet.

#### 1.5 CLI Commands

```
wire trigger list                              # show all triggers
wire trigger add .wire/triggers/mine.yaml      # register a trigger
wire trigger remove <id>                       # unregister
wire trigger fire <id>                         # manually fire a trigger (for testing)
wire serve --port 8080                         # start webhook listener + cron scheduler
```

`wire serve` is the deployment entry point: it starts the trigger engine and blocks, listening for webhooks and firing cron schedules. For local development, `wire run` continues to work as before.

#### 1.6 LOC Estimate

~300 lines: types (40), engine (120), webhook handler (60), cron scheduler (50), CLI commands (30).

---

## 2. Task Delegation (Wire Calling Wire)

### Origin

Flue's `task` tool lets an agent spawn a child agent with its own session, context, and depth limit. Children run independently, return structured results, and the parent collects and synthesizes them. Wire currently executes as a single linear loop — one task, one run, one browser session.

### Problem

Some tasks decompose naturally into parallel sub-tasks. "Research these five competitors" is five independent browser tasks that could run concurrently. "Download invoices from three portals" is three independent workflows. Today Wire does these sequentially, wasting time and budget. The agent also can't decompose its own work — it must solve everything in a single linear thread.

### Proposal

Add a `delegate` action kind that lets Wire's agent loop spawn child Wire runs. The parent proposes a delegation, the runtime creates a child run with its own browser session, the child executes independently, and the result flows back as a trace event.

#### 2.1 Delegation Model

```typescript
// Extension to ActionKind
type ActionKind =
  | "observe"
  | "exec"
  | "raw"
  | "request-approval"
  | "branch-experiment"
  | "load-skill"
  | "propose-skill"
  | "delegate"      // ← new
  | "finish";

interface DelegateAction {
  kind: "delegate";
  summary: string;
  payload: {
    objective: string;        // what the child should accomplish
    constraints?: string[];   // additional constraints for the child
    successCriteria?: string[];
    budget?: TaskBudget;      // child's own budget (cannot exceed parent's remaining)
    skills?: string[];        // skill IDs to load for child
    timeout?: number;         // max wall-clock seconds for child run
  };
}

interface DelegateResult {
  childRunId: RunId;
  status: "succeeded" | "failed" | "timed_out";
  result?: string;            // child's finish summary
  artifacts: Artifact[];      // child's artifacts
  stepsUsed: number;
  tokensUsed: number;
  usdSpent: number;
}
```

#### 2.2 Execution Semantics

When the loop encounters a `delegate` action:

1. **Budget check**: The parent's remaining budget must accommodate the child's requested budget. If not, policy denies the action.
2. **Session creation**: The runtime creates a new browser session for the child. The child does not share the parent's browser session — this is critical for isolation.
3. **Run creation**: A new `Run` is created with `parentRunId` set to the parent's run ID. The child's task is derived from the `DelegateAction.payload`.
4. **Independent loop**: The child runs its own agent loop (`executeTask`) with its own context, skills, and policy engine. The parent is suspended while the child runs (sequential delegation) or the parent continues (parallel delegation — see below).
5. **Result collection**: When the child finishes, a `delegate-complete` trace event is emitted on the parent's trace, carrying the `DelegateResult`. The parent's context is updated with the child's outcome.
6. **Budget deduction**: The child's actual spend is deducted from the parent's remaining budget.

#### 2.3 Delegation Depth

```typescript
const MAX_DELEGATION_DEPTH = 2;
```

A parent at depth 0 can spawn children at depth 1. Those children can spawn grandchildren at depth 2. No further nesting. This prevents runaway delegation chains. The depth is tracked in `Run` metadata:

```typescript
interface Run {
  // ... existing fields ...
  delegationDepth?: number;   // 0 for top-level runs
}
```

#### 2.4 Parallel Delegation

The agent can propose multiple `delegate` actions in a single turn. The runtime detects when multiple delegations are proposed and runs them concurrently:

```typescript
// The agent's proposed action can be a batch
interface ProposedAction {
  kind: ActionKind;
  // ... existing fields ...
  parallel?: boolean;         // hint that more delegations may follow
}
```

When the runtime sees `parallel: true` on a delegate action, it buffers it instead of executing immediately. On the next non-delegate action (or `finish`), all buffered delegations are launched concurrently using `Promise.all`.

This is deliberately simple — no complex orchestration, no shared state between children, no inter-child communication. Each child is an independent Wire run that happens to share a parent.

#### 2.5 Policy Rules for Delegation

New policy rules that gate delegation:

| Rule | Description | Default |
|------|-------------|---------|
| `max-delegation-depth` | Maximum nesting depth | 2 |
| `max-parallel-children` | Maximum concurrent children per parent | 3 |
| `child-budget-ratio` | Maximum fraction of parent budget per child | 0.5 |
| `require-approval-for-delegation` | Human must approve each delegation | false |

#### 2.6 Context Integration

After a child completes, its result is injected into the parent's context as a `delegate-complete` trace event. The parent's context builder includes delegation results alongside recent traces:

```typescript
// In context.ts, the recentTraces section now includes:
interface DelegateTraceEntry {
  kind: "delegate-complete";
  childRunId: RunId;
  objective: string;
  status: "succeeded" | "failed" | "timed_out";
  result: string;
  keyArtifacts: string[];  // summaries, not full content
}
```

The parent's LLM sees delegation results as structured evidence, not raw dumps. It can then decide to delegate more work, use the results, or finish.

#### 2.7 LOC Estimate

~400 lines: action handler (120), parallel orchestrator (80), policy rules (40), context integration (60), types (50), tests (50). Must pair with ~300 LOC of deletions elsewhere to stay under cap.

---

## 3. Context Compaction

### Origin

Flue has built-in context compaction that fires on two conditions: threshold (approaching the context window limit) and overflow (the LLM returned a context-length error). It summarizes older messages and replaces them with a compaction entry in the session history. Configurable via `reserveTokens` and `keepRecentTokens`.

Wire currently handles long tasks by truncating recent traces to the last 5 events and observations to the last 3. There is no summarization of older context — it's just dropped. This means the agent loses awareness of what happened in early steps of a long task.

### Problem

For long tasks (20+ steps), the agent's context window fills with trace events, observations, and skill content. Currently Wire's only strategy is truncation: keep the last N items, drop the rest. This is lossy in the wrong way — the agent forgets what it already tried, why it failed, and what it learned. It then repeats mistakes, loops on dead-end strategies, and wastes budget.

What's needed is intelligent compaction: summarize early progress into a condensed narrative that preserves key facts (what was tried, what worked, what failed, what was learned) while freeing context window space for new reasoning.

### Proposal

Add a compaction layer that runs between agent turns, summarizing older context into a compact "progress summary" that replaces the raw trace events.

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
  triggerThreshold: 0.7,       // compact when 70% of context window is used
  keepRecentSteps: 5,          // keep last 5 steps raw
  maxSummaryTokens: 800,       // ~400 words of summary
};
```

Compaction fires when:
1. **Threshold**: The estimated context token count exceeds `triggerThreshold * contextWindowSize`. Estimated by counting characters in the context bundle (rough: 4 chars ≈ 1 token).
2. **Overflow**: The LLM returns a context-length error (the same fallback Flue uses).

#### 3.2 Compaction Process

When compaction triggers:

1. **Split** the trace history into two regions:
   - `older`: steps 0 through `(current - keepRecentSteps)`
   - `recent`: the last `keepRecentSteps` steps (preserved as-is)
2. **Summarize** the `older` region using a dedicated LLM call with a fixed prompt:
   ```
   Summarize the following agent trace into a compact progress report.
   Preserve: URLs visited, actions taken, outcomes observed, errors encountered,
   key findings, and any partially completed work.
   Omit: verbose DOM descriptions, repeated observations, raw code.
   Format as structured bullet points.
   Target: {maxSummaryTokens} tokens.
   ```
3. **Replace** the older region in the context bundle with a single `compaction-summary` entry.
4. **Emit** a `compaction` trace event so the audit trail shows when and why context was compressed.

```typescript
interface CompactionSummary {
  kind: "compaction-summary";
  stepsCovered: number;        // how many steps were summarized
  summary: string;             // the LLM-generated summary
  createdAt: string;
  tokensSaved: number;         // estimated tokens freed by compaction
}
```

#### 3.3 Context Bundle Integration

The context builder (`context.ts`) is updated to include the compaction summary at the top of the context, before recent traces:

```typescript
interface ContextBundle {
  // ... existing fields ...
  progressSummary?: CompactionSummary;  // ← new, sits above recentTraces
  recentTraces: Array<{ kind: string; summary: string }>;
}
```

The LLM prompt is structured so the progress summary is presented as "what happened so far" and recent traces as "what just happened." This gives the agent both the long arc and the immediate detail.

#### 3.4 Auditability

Compaction summaries are stored as trace events. Any human reviewing a run can see:
- When compaction occurred (step number)
- What steps were summarized
- The full summary text
- How many tokens were saved

The original raw trace events are never deleted from the trace log — compaction only affects what's in the LLM's context window. The full audit trail is always preserved on disk.

#### 3.5 Cost Control

Each compaction call costs one LLM invocation (summary generation). To control costs:

- Compaction is capped at once every 5 steps (no re-compacting a summary immediately).
- The summary LLM call uses the cheapest available model (Haiku-class), not the agent's primary model.
- The `maxSummaryTokens` cap prevents runaway summaries.

#### 3.6 LOC Estimate

~250 lines: compaction logic (100), context integration (50), types (30), trace event emission (30), config (20), budget estimation (20). This is largely additive to existing modules — no new files needed beyond `compaction.ts`.

---

## 4. Flexible Sandbox Tiers

### Origin

Flue has a layered sandbox model: virtual (lightweight, fast), local (host filesystem), and remote (full container via Daytona). Each tier trades isolation for capability. The sandbox is abstracted behind a `SessionEnv` interface so the agent code doesn't change based on which sandbox it's running in.

Wire currently has one execution environment: a full Steel browser session. Every task, even a simple "visit this URL and check the title," requires spinning up a remote Chrome instance. This is expensive, slow (~10s startup), and often overkill.

### Problem

Not every Wire task needs a full browser. Three concrete examples:

1. **URL health checks**: "Verify these 10 URLs return 200." A simple HTTP HEAD request per URL is sufficient — no browser needed.
2. **API extraction**: "Pull the JSON from this endpoint." A `fetch` call does the job — no DOM, no rendering, no JavaScript execution.
3. **Light scraping**: "Get the text content of this page." A static HTML fetch + parse is enough — no JS rendering, no screenshots.

Spinning up a Steel session for these tasks wastes money, time, and browser infrastructure. But Wire currently has no lighter execution path.

### Proposal

Add sandbox tiers that match the execution environment to the task's actual requirements. The agent (or a pre-flight classifier) selects the tier before the run starts, and the runtime uses the appropriate provider.

#### 4.1 Tier Definitions

```typescript
// src/browser/tiers.ts

type SandboxTier = "full-browser" | "headless-fetch" | "static-fetch";

interface TierCapabilities {
  javascript: boolean;        // can execute JS
  dom: boolean;               // can query the DOM
  screenshots: boolean;       // can capture visual state
  interactions: boolean;      // can click, type, scroll
  persistentSession: boolean; // maintains state across steps
  startupSeconds: number;     // expected startup time
  costPerMinute: number;      // relative cost (1.0 = Steel session)
}

const TIER_CAPS: Record<SandboxTier, TierCapabilities> = {
  "full-browser": {
    javascript: true,
    dom: true,
    screenshots: true,
    interactions: true,
    persistentSession: true,
    startupSeconds: 10,
    costPerMinute: 1.0,
  },
  "headless-fetch": {
    javascript: false,
    dom: false,
    screenshots: false,
    interactions: false,
    persistentSession: false,
    startupSeconds: 1,
    costPerMinute: 0.05,
  },
  "static-fetch": {
    javascript: false,
    dom: false,
    screenshots: false,
    interactions: false,
    persistentSession: false,
    startupSeconds: 0.5,
    costPerMinute: 0.01,
  },
};
```

#### 4.2 Tier Interface

Each tier implements the same `BrowserProvider` interface that Steel already implements, but with reduced capabilities:

```typescript
// Full-browser tier: existing Steel provider (no changes)
// Headless-fetch tier: uses fetch() + basic HTML parsing
// Static-fetch tier: uses fetch() only, returns raw response

// The key insight: all tiers must support observe() and exec()
// but lower tiers return limited observations and reject unsupported exec actions.

interface TieredProvider extends BrowserProvider {
  tier: SandboxTier;
  capabilities: TierCapabilities;
}
```

For `headless-fetch` and `static-fetch`:
- `observe()` returns URL, status code, content type, and (for headless) parsed text/links. No DOM counts, no forms, no buttons.
- `exec()` is rejected with a clear error: `"This task requires JavaScript execution. Restart with --tier full-browser."`
- `raw()` is not available.

#### 4.3 Tier Selection

Two paths for tier selection:

**Manual**: User specifies via CLI flag or task definition:
```bash
wire run --tier headless-fetch "Check if example.com is up"
```

**Automatic**: A pre-flight classifier analyzes the task objective and recommends a tier:
```typescript
// src/browser/classify-tier.ts

function classifyTier(objective: string, mode: TaskMode): SandboxTier {
  // Simple heuristic classification — no LLM call needed
  const needsJs = /click|type|fill|submit|login|interact|button|form/i.test(objective);
  const needsDom = /scrape|extract|table|list|content|text from/i.test(objective);

  if (needsJs) return "full-browser";
  if (needsDom) return "headless-fetch";
  return "static-fetch";
}
```

The classifier is deliberately conservative: if in doubt, escalate to the higher tier. Better to over-provision than to fail on a task that needed JS.

**Tier escalation**: If a task starts on a lower tier and the agent encounters a step that needs higher capabilities, the agent emits a `tier-escalation` trace event and the run is re-initiated on the next tier up. This preserves progress — the escalation carries the trace forward so the new run doesn't repeat completed steps.

#### 4.4 Task Definition Extension

```typescript
interface Task {
  // ... existing fields ...
  sandboxTier?: SandboxTier;   // explicit tier override
}
```

In the trigger system (Improvement 1), triggers can specify a tier:
```yaml
task:
  objective: "Check uptime for {{url}}"
  sandboxTier: static-fetch
```

#### 4.5 What This Is Not

- This is **not** a sandbox abstraction layer like Flue's `SessionEnv`. Wire's sandbox tiers are browser-execution tiers, not general-purpose compute environments.
- This is **not** a replacement for the Steel provider. The full-browser tier remains the primary execution path.
- This is **not** Docker or containers. The lighter tiers are just `fetch()` calls — no infrastructure needed.

#### 4.6 LOC Estimate

~200 lines: tier types (30), classifier (40), headless-fetch provider (60), static-fetch provider (40), tier escalation (30). The full-browser tier is existing code — no changes.

---

## Implementation Order

These improvements have dependencies and should be implemented in this order:

1. **Context Compaction** (standalone, no dependencies, immediate value for long tasks)
2. **Flexible Sandbox Tiers** (standalone, no dependencies, cost savings from day one)
3. **Deployment Triggers** (depends on tier selection for cost control)
4. **Task Delegation** (depends on compaction for parent context management, depends on triggers for parallel child scheduling)

## LOC Budget Accounting

| Improvement | Additive LOC | Notes |
|-------------|-------------|-------|
| Context Compaction | ~250 | New `compaction.ts` + context changes |
| Flexible Sandbox Tiers | ~200 | New `tiers.ts` + light providers |
| Deployment Triggers | ~300 | New `triggers/` module |
| Task Delegation | ~400 | Action handler + orchestration |
| **Total added** | **~1,150** | |
| **Required deletions** | **~1,150** | Must identify and remove equivalent LOC |

Before starting implementation, each improvement should identify concrete deletion targets in the existing codebase. Candidates include: unused action handlers, over-abstracted policy rules, dead helper functions, and verbose context formatting.

## What We Refuse

These improvements deliberately do not include:

- **No general-purpose sandbox abstraction.** Wire is a browser agent, not a compute platform. Tiers are browser-execution tiers only.
- **No orchestration framework.** Task delegation is "Wire calling Wire," not a swarm system with shared state, message passing, or complex coordination.
- **No external dependencies.** Triggers use Node's built-in `http` module and `setInterval`. Compaction uses the existing LLM provider. No cron libraries, no job queues, no message brokers.
- **No database.** Everything remains file-based (YAML triggers, JSON traces, markdown skills). Persistence is the filesystem.
- **No hidden retries.** Compaction does not retry failed steps. Delegation does not retry failed children. Tier escalation is explicit and traceable.
