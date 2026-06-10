# Minimal Browsing Agent — Final Product & Architecture Spec (TypeScript)

Version: 1.0  
Status: Draft for implementation  
Language: TypeScript (Node.js)

---

## 1) Executive summary

We are building a **minimal browsing agent** for remote cloud Chrome infrastructure.

It is inspired by four ideas:

1. **Simple Made Easy**: prefer systems with low interleaving and clear boundaries over systems that are merely familiar or quick to demo.
2. **Pi-style agent design**: keep the core very small and move optional behavior to files, extensions, and skills.
3. **Browser-harness-style operability**: let the model act through code against a persistent browser substrate, keep helpers thin, and preserve an escape hatch to lower-level browser control.
4. **Experiment throughput as the unit of progress**: the agent is not only a task completer; it is a research operator that turns vague hunches into runs, ablations, failures, artifacts, comparisons, and revised hypotheses.

The product should feel like a **research workbench for web tasks**:
- users provide a goal, hunch, or task,
- the agent turns that into an execution or experiment plan,
- the system runs against real websites via remote browser sessions,
- the result is not just “done,” but evidence: traces, screenshots, extracted artifacts, failures, comparisons, and next-step recommendations.

The core design rule:

> **Outsource operational browser complexity to cloud browser infrastructure, but keep the agent itself conceptually simple.**

---

## 2) Product thesis

### 2.1 What product are we building?

A **TypeScript-first coding-style browsing agent** with:
- one small runtime,
- one stateful browser bridge,
- file-based skills,
- editable helper code,
- explicit trace and policy boundaries,
- support for both direct task execution and experiment-style branching.

### 2.2 What is the product not?

It is **not**:
- a giant browser framework disguised as an agent,
- a screenshot-only RPA bot,
- a swarm/sub-agent orchestration system in v1,
- a giant prompt full of tools and policies,
- an opaque self-healing black box.

### 2.3 Product promise

Given a user request like:
- “download all invoices from this dashboard,”
- “check whether this workflow breaks for users with billing state,”
- “find the shortest path to create this record across these apps,”

…the system should be able to:
- operate a real remote browser session,
- choose the cheapest reliable path,
- preserve evidence,
- branch into comparisons when uncertainty matters,
- explain what happened,
- accumulate reusable site knowledge.

---

## 3) Design philosophy

### 3.1 Simple over easy

We use **simple** in Rich Hickey’s sense: a system is simple when concerns are **not braided together**.

In this product, simplicity means:
- browser lifecycle is not mixed with agent reasoning,
- durable site knowledge is not mixed with task-local narration,
- policy is not mixed with action generation,
- traces are not mixed with mutable working memory,
- infrastructure concerns are not mixed with product semantics.

### 3.2 The core must stay small

The runtime should own only what must be shared across all tasks:
- task loop,
- context assembly,
- browser session attachment,
- skill loading,
- trace capture,
- policy hooks.

Everything else should live outside the core:
- domain workflows,
- site-specific mechanics,
- optional helpers,
- experiment recipes,
- integrations,
- approval UX.

### 3.3 Code is the action language

The agent primarily acts by **writing and executing code** against a persistent browser session.

This gives us:
- a uniform action model,
- inspectability,
- reproducibility,
- patchability,
- lower dependence on sprawling pre-defined tool vocabularies.

### 3.4 Abstractions are optional conveniences

High-level helpers are allowed, but must obey these rules:
- they are **thin**,
- they are **inspectable**,
- they are **editable**,
- they are **not the only path**,
- lower-level browser access remains available.

### 3.5 The browser is a reality interface

We are not simulating tasks in a toy environment. We are interacting with real sites, real auth state, real latency, real anti-bot behavior, and real UI failure modes.

That means:
- execution artifacts matter,
- failure artifacts matter more than usual,
- reproducibility requires strong session and trace modeling,
- experiment throughput matters.

---

## 4) Product principles

1. **Optimize for learning-per-run, not just completion-per-run.**  
   A failed run that reveals the causal bottleneck can be more valuable than a lucky success.

2. **Prefer the cheapest reliable path.**  
   Use direct URL patterns, browser-side JS, network/API observations, exports, and structured extraction before expensive UI thrashing.

3. **Every run should leave evidence behind.**  
   No silent retries that erase what actually happened.

4. **Every abstraction must have an escape hatch.**  
   The agent should never be trapped inside a helper layer.

5. **Separate identity from execution.**  
   Profile, session, task state, skill memory, and trace are different things.

6. **Skills capture the map, not the diary.**  
   Store durable site knowledge, not run narration.

7. **Policy belongs outside the reasoning loop.**  
   The model proposes actions; policy decides what is permitted.

8. **One stateful browser connection per task.**  
   Avoid reconnect-per-step architectures.

9. **Keep observation cheap and action precise.**  
   Compact summaries for thinking; exact code for acting.

10. **Build for branching.**  
   The system should be able to fork tasks into experiments, ablations, and comparative runs.

---

## 5) User-facing modes

The same runtime supports three modes.

### 5.1 Task mode
For deterministic, practical work:
- fill forms,
- download files,
- extract data,
- navigate tools,
- move information across apps.

Output:
- final result,
- trace,
- generated artifacts,
- reusable learnings.

### 5.2 Investigate mode
For diagnosis and debugging:
- where does the flow fail,
- is it auth-dependent,
- does cached state matter,
- is the issue in the DOM path or the network path,
- which step is flaky.

Output:
- failure map,
- run variants,
- comparative traces,
- likely causes,
- next best experiments.

### 5.3 Experiment mode
For vague hunches and research:
- “I think this flow only breaks with prior billing history.”
- “I suspect there is a private API that makes this 10x cheaper.”
- “I want the fastest stable strategy for this job.”

Output:
- hypothesis set,
- experiment matrix,
- run artifacts,
- ablations,
- counterexamples,
- revised hypothesis.

### 5.4 Embedded invocation

Not a fourth mode — a way to *call* the runtime. Any of the modes above can run
unattended as a tool inside another program (e.g. a research agent escalating a
hard URL): no human to approve gates, a hard wall-clock deadline, a typed
output schema, and provenance-backed results. See
[`docs/embedded-mode.md`](docs/embedded-mode.md).

---

## 6) Scope

### 6.1 In scope for v1
- remote cloud Chrome session control,
- one persistent browser session per task,
- TypeScript runtime,
- code execution against current browser session,
- structured observation snapshots,
- file-based skills,
- thin editable helpers,
- trace capture,
- artifact persistence,
- policy hooks,
- branching/experiment support,
- compare view data model,
- human approval for destructive actions.

### 6.2 Out of scope for v1
- multi-agent swarms,
- plan mode as a core primitive,
- giant tool marketplaces,
- autonomous credential entry from screenshots,
- hidden self-modifying core runtime,
- generalized computer-use across desktop apps,
- first-class support for every browser engine,
- long-running background shells as a product primitive.

---

## 7) System architecture

### 7.1 High-level architecture

```text
+---------------------------+
|        User / UI          |
| tasks, hunches, approval  |
+------------+--------------+
             |
             v
+---------------------------+
|      Agent Runtime        |
| turn loop, context, LLM   |
+------------+--------------+
             |
   +---------+----------+
   |                    |
   v                    v
+--------+       +---------------+
| Skills |       | Policy Engine |
| files  |       | allow/deny    |
+--------+       +---------------+
   |
   v
+---------------------------+
|     Browser Bridge        |
| observe + exec + raw      |
+------------+--------------+
             |
             v
+---------------------------+
| Remote Browser Infra      |
| sessions, profiles, replay|
| auth, proxies, scaling    |
+---------------------------+
```

### 7.2 Architectural boundaries

#### A. Browser infrastructure layer
Owns:
- browser process lifecycle,
- websocket/session lifecycle,
- profile persistence,
- replay/live viewing,
- stealth/proxy posture,
- session scaling.

#### B. Browser bridge layer
Owns:
- attaching to one current browser session,
- target/tab routing,
- observation bundle generation,
- code execution bridge,
- optional raw protocol access.

#### C. Agent runtime layer
Owns:
- LLM turn loop,
- context assembly,
- task state,
- experiment branching,
- helper editing,
- run classification.

#### D. Skills layer
Owns:
- domain/site knowledge,
- reusable workflow hints,
- stable selectors,
- private API notes,
- app-specific traps.

#### E. Policy layer
Owns:
- allowed actions,
- destructive-action gating,
- profile access scope,
- outbound communication restrictions,
- audit invariants.

#### F. Trace/artifact layer
Owns:
- immutable run logs,
- screenshots,
- extracted files,
- diffs,
- summaries,
- compare views.

---

## 8) Core objects

These objects must remain conceptually separate.

### 8.1 Profile
Represents browser identity.

Contains:
- cookies,
- local storage,
- auth state,
- browser extension state,
- persisted browser context metadata.

Does **not** contain:
- task-local reasoning,
- trace history,
- run outcomes.

```ts
export interface ProfileRef {
  id: string;
  name: string;
  provider: 'steel' | 'custom';
  metadata?: Record<string, unknown>;
}
```

### 8.2 Session
Represents a live remote browser instance.

```ts
export interface BrowserSession {
  id: string;
  provider: 'steel' | 'custom';
  profileId?: string;
  liveUrl?: string;
  wsUrl?: string;
  createdAt: string;
  status: 'starting' | 'ready' | 'busy' | 'stopped' | 'failed';
  region?: string;
  proxyCountryCode?: string | null;
}
```

### 8.3 Task
Represents one user objective.

```ts
export interface Task {
  id: string;
  title: string;
  mode: 'task' | 'investigate' | 'experiment';
  objective: string;
  constraints: string[];
  successCriteria: string[];
  falsificationCriteria?: string[];
  budget?: TaskBudget;
  createdAt: string;
}

export interface TaskBudget {
  maxRuns?: number;
  maxTokens?: number;
  maxBrowserMinutes?: number;
  maxUsd?: number;
}
```

### 8.4 Run
Represents a single concrete attempt.

```ts
export interface Run {
  id: string;
  taskId: string;
  parentRunId?: string;
  branchLabel?: string;
  hypothesisId?: string;
  status: 'queued' | 'running' | 'awaiting-approval' | 'succeeded' | 'failed' | 'aborted';
  startedAt?: string;
  finishedAt?: string;
  outcomeSummary?: string;
  classification?: RunClassification;
}

export interface RunClassification {
  kind:
    | 'task-complete'
    | 'partial-success'
    | 'blocked-auth'
    | 'site-error'
    | 'agent-error'
    | 'infra-error'
    | 'counterexample'
    | 'ambiguous';
  confidence: number;
  notes?: string[];
}
```

### 8.5 Hypothesis
Represents a research claim or working explanation.

```ts
export interface Hypothesis {
  id: string;
  taskId: string;
  statement: string;
  rationale?: string;
  status: 'active' | 'supported' | 'rejected' | 'ambiguous';
  updatedAt: string;
}
```

### 8.6 Skill
Represents durable reusable knowledge.

```ts
export interface SkillMetadata {
  id: string;
  scope: 'domain' | 'workflow' | 'interaction';
  hostnamePatterns?: string[];
  tags: string[];
  updatedAt: string;
  source: 'builtin' | 'team' | 'generated';
}
```

### 8.7 Trace event
Represents immutable observability.

```ts
export interface TraceEvent {
  id: string;
  runId: string;
  ts: string;
  kind:
    | 'thought-summary'
    | 'observation'
    | 'code-exec'
    | 'code-result'
    | 'artifact'
    | 'policy-check'
    | 'approval-request'
    | 'approval-result'
    | 'skill-load'
    | 'skill-proposal'
    | 'error';
  payload: Record<string, unknown>;
}
```

---

## 9) Minimal runtime design

### 9.1 Core runtime responsibilities
The runtime should do exactly these things:

1. load task + relevant context,
2. attach or create browser session,
3. load relevant skills,
4. ask the model for the next move,
5. execute browser code or observe state,
6. persist trace + artifacts,
7. evaluate progress,
8. request approval when required,
9. branch if the task becomes experimental,
10. stop when done or budget exhausted.

### 9.2 Runtime non-responsibilities
The runtime should not:
- own browser fleet orchestration,
- hide retries without tracing them,
- mutate profiles implicitly,
- encode business workflows directly,
- mix task reasoning with policy enforcement,
- contain domain-specific heuristics in core.

---

## 10) Browser bridge design

The bridge should expose **two first-class operations** and one optional escape hatch.

### 10.1 `browser.observe()`
Returns a compact observation bundle.

Purpose:
- cheap state inspection,
- context compaction,
- compare-friendly snapshots,
- planning without massive DOM dumps.

Observation is **orientation-only**: URL, title, headings, and element counts.
It answers "where am I?" and "did my action work?" — not "what does the page say?"
Content extraction is the agent's job via `exec`.

```ts
export interface BrowserObservation {
  sessionId: string;
  targetId?: string;
  url: string;
  title: string;
  tabs: Array<{ id: string; title: string; url: string; active: boolean }>;
  screenshotArtifactId?: string;
  htmlArtifactId?: string;
  markdownArtifactId?: string;
  focusedElement?: {
    tag?: string;
    role?: string;
    label?: string;
    selectorHint?: string;
  };
  pageSummary?: {
    headings?: string[];
    forms?: number;
    buttons?: number;
    dialogs?: number;
    tables?: number;
    links?: number;
    inputs?: number;
  };
}
```

### 10.2 `browser.exec()`
Executes TypeScript/JavaScript against the current browser session.

Purpose:
- navigation,
- extraction,
- interaction,
- verification,
- experimentation,
- helper reuse.

```ts
export interface BrowserExecRequest {
  sessionId: string;
  code: string;
  timeoutMs?: number;
  target?: 'active-tab' | 'all-tabs' | { tabId: string };
  attachments?: string[];
}

export interface BrowserExecResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  returnValue?: unknown;
  artifactIds?: string[];
  durationMs: number;
}
```

### 10.3 `browser.raw()` (optional escape hatch)
Used only when helpers or standard bridge affordances are insufficient.

```ts
export interface BrowserRawRequest {
  sessionId: string;
  method: string;
  params?: Record<string, unknown>;
}
```

Rule:
- raw access exists,
- raw access is visible in trace,
- raw access is not the default thought path for every step.

---

## 11) Helper model

Helpers are ordinary TypeScript modules.

Rules:
- helpers must be thin,
- helpers must not become a giant DSL,
- helpers must be callable from `browser.exec()`,
- helpers may be edited by the agent,
- helper changes must be captured as artifacts and diffs,
- helper edits should be scoped to task or skill promotion flows.

Example helper surface:

```ts
export async function clickVisibleText(text: string): Promise<void>;
export async function fillByLabel(label: string, value: string): Promise<void>;
export async function uploadFile(selector: string, filePath: string): Promise<void>;
export async function extractTable(selector: string): Promise<string[][]>;
```

Guideline:
- if a helper is missing and repeatedly useful, add it,
- if a helper becomes broad and opinionated, split it,
- if a helper hides causal structure, demote it.

---

## 12) Skill system

### 12.1 Why skills exist
Skills keep the core small while allowing the system to accumulate durable knowledge.

### 12.2 Skill types

#### A. Domain skills
Knowledge about one site/app/domain.

Examples:
- URL patterns,
- stable selectors,
- API endpoints,
- iframe or shadow DOM quirks,
- known waits,
- export or upload shortcuts,
- traps and failure modes.

#### B. Workflow skills
Knowledge about a repeated business workflow across apps.

Examples:
- invoice retrieval,
- candidate sourcing,
- CRM record creation,
- calendar event entry,
- payroll export.

#### C. Interaction skills
Reusable browser/UI mechanics.

Examples:
- uploads,
- dialogs,
- nested scrolling,
- tabs,
- downloads,
- shadow DOM,
- cross-origin frames.

### 12.3 Skill file format
Markdown with small frontmatter.

```md
---
id: stripe-dashboard
scope: domain
hostnamePatterns:
  - "dashboard.stripe.com"
tags:
  - billing
  - invoices
updatedAt: 2026-04-24
source: team
---

# Stripe dashboard

## Durable facts
- Invoices can often be reached directly from ...
- CSV export triggers a background download event ...

## Stable selectors
- ...

## Traps
- ...
```

### 12.4 Skill rules
Skills should contain:
- durable site shape,
- stable selectors,
- direct routes,
- private API patterns,
- waits with reasons,
- traps.

Skills should not contain:
- secrets,
- tokens,
- cookies,
- run transcripts,
- chain-of-thought,
- one-off pixel coordinates,
- step-by-step narration of a specific run.

### 12.5 Skill loading
Skills are loaded by:
- hostname,
- task tag,
- explicit user hint,
- learned confidence from prior runs.

Skills are **not** all loaded into prompt by default.

---

## 13) Experiment model

This is a core differentiator.

### 13.1 Why experiments are first-class
The agent should not only answer “can I do it?” but also:
- what path is best,
- what variable mattered,
- what failed,
- what evidence supports the current view,
- what should be tried next.

### 13.2 Experiment primitives

#### Hypothesis
A proposed explanation or strategy.

#### Ablation
Remove or vary one factor.

Examples:
- same workflow, fresh profile,
- same workflow, warm profile,
- DOM path vs direct network path,
- helper A vs raw code,
- wait strategy A vs wait strategy B.

#### Counterexample search
Actively seek a case that breaks the current explanation.

#### Replication
Repeat a run to test reproducibility.

### 13.3 Experiment bundle

```ts
export interface ExperimentBundle {
  id: string;
  taskId: string;
  hypotheses: Hypothesis[];
  runIds: string[];
  comparisons: ComparisonSpec[];
  summary?: ExperimentSummary;
}

export interface ComparisonSpec {
  id: string;
  lhsRunId: string;
  rhsRunId: string;
  dimensions: Array<'latency' | 'path' | 'profile' | 'artifacts' | 'outcome'>;
}

export interface ExperimentSummary {
  supportedHypotheses: string[];
  rejectedHypotheses: string[];
  ambiguousHypotheses: string[];
  keyEvidence: string[];
  nextBestExperiments: string[];
}
```

### 13.4 When to branch into experiment mode
The runtime should branch when:
- success criteria are underspecified,
- the task fails in a way that suggests multiple explanations,
- one more run would meaningfully reduce uncertainty,
- the user explicitly asks for analysis, diagnosis, or optimization,
- the cost of ambiguity is high.

---

## 14) Policy & approvals

### 14.1 Principle
Policy is outside the reasoning loop.

The model proposes actions. The policy engine says:
- allowed,
- denied,
- allowed with approval.

### 14.2 Approval-required actions
By default, approval is required for:
- submit/purchase/send,
- account/billing/permission changes,
- deletion,
- outbound messages,
- irreversible data mutation,
- use of privileged profiles when policy says so.

### 14.3 Policy check model

```ts
export interface PolicyDecision {
  actionId: string;
  result: 'allow' | 'deny' | 'require-approval';
  reason?: string;
}
```

### 14.4 Approval object

```ts
export interface ApprovalRequest {
  id: string;
  runId: string;
  summary: string;
  consequences: string[];
  expiresAt?: string;
}
```

---

## 15) Trace & artifact model

### 15.1 Why traces matter
Traces are required for:
- debugging,
- replay,
- safety review,
- skill extraction,
- comparative analysis,
- product trust.

### 15.2 Artifact kinds

```ts
export type ArtifactKind =
  | 'screenshot'
  | 'html'
  | 'markdown'
  | 'pdf'
  | 'download'
  | 'helper-diff'
  | 'skill-proposal'
  | 'json-output'
  | 'plot'
  | 'table'
  | 'note'
  | (string & {});
```

Agents may return explicit text file artifacts from browser exec as:

```ts
{
  artifacts: [{
    filename: 'comparison.md',
    kind: 'markdown',
    mimeType: 'text/markdown',
    content: '...complete file content...'
  }],
  data: {}
}
```

Core persists the envelope generically; the model chooses format details for Markdown, CSV, JSON, TXT, HTML, code files, and similar text artifacts.

### 15.3 Artifact metadata

```ts
export interface Artifact {
  id: string;
  runId: string;
  kind: ArtifactKind;
  path: string;
  mimeType?: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}
```

### 15.4 Trace content storage

Trace spans must not repeatedly persist full immutable message arrays or large content payloads inline. Store large trace content as run-scoped blobs keyed by a hash of canonical JSON, then keep compact refs in events and metadata. Reconstruct full content at read time when a review/debug command needs it.

LLM message tracing is opt-in (`--trace-llm` or `WIRE_TRACE_LLM_MESSAGES=1`) and must store only message/response blob refs on `llm-call` events, never full prompts inline.

### 15.5 Minimum trace policy
Every run must capture at least:
- task id,
- run id,
- browser session id,
- loaded skills,
- code executed,
- observation snapshots,
- policy checks,
- approvals,
- final classification,
- created artifacts.

### 15.6 Compare views
Run records and trace events carry the fields needed to compare runs by end
state, step count, latency, artifacts, profile used, helper version, and
hypothesis association. A dedicated compare module was built and later removed
unused (2026-06-10) — comparisons today are performed over the persisted run
records directly (`wire export`, eval metrics); a first-class compare view
remains roadmap, not code.

---

## 16) TypeScript implementation choices

### 16.1 Runtime choices
- Node.js 22+
- TypeScript strict mode
- ESM only
- `tsx` for local dev
- `pnpm` for package management
- `zod` for boundary schemas
- lightweight event bus via typed interfaces, not a full framework

### 16.2 Why TypeScript here
TypeScript is the right fit because:
- helpers are ordinary code,
- the runtime wants strong contracts at boundaries,
- the agent can inspect/edit familiar source files,
- Node is well suited to browser SDKs and web tooling,
- we can keep the core small without sacrificing schema discipline.

### 16.3 Boundary rule
Use runtime validation only at boundaries:
- external APIs,
- LLM tool messages,
- browser bridge I/O,
- skill frontmatter,
- persisted state.

Do **not** turn the whole system into a validation maze.

---

## 17) Code layout (as built)

The tree below is the actual `src/` layout (updated 2026-06-10). It differs
from the original proposal in three ways worth knowing: trace events and
artifacts persist under `storage/` (the `trace/` module holds only replay and
crystallize), the planned `experiments/ablations.ts` was never built (roadmap),
and the compare module was built and later deleted unused (see §15.6).

```text
src/
  agent/        # loop, runtime, turn, finish flow, classification, verdicts
    runtime.ts
    loop.ts
    loop-result.ts
    turn.ts
    context.ts
    prompts.ts
    action-guidance.ts
    action-dispatch.ts
    actions.ts
    observation.ts
    screenshots.ts
    planning.ts
    branching.ts
    classify.ts
    contract.ts
    critical-points.ts
    evidence.ts
    progress-ledger.ts
    finish-flow.ts
    finalize.ts
    artifact-review.ts
    recovery.ts
    startup-failure.ts
    run-limits.ts
    state-helpers.ts
    llm-parse.ts
    llm-trace.ts
    skill-context.ts
    skill-proposals.ts
    embedded.ts
  browser/      # provider-facing bridge: observe/exec/raw + thin helpers
    bridge.ts
    actions.ts
    observe.ts
    exec.ts
    raw.ts
    session.ts
    targets.ts
    helpers.ts
  policy/
    engine.ts
    rules.ts
    approvals.ts
  skills/
    loader.ts
    parser.ts
    matcher.ts
    promote.ts
    stats.ts
  trace/
    crystallize.ts
    replay.ts
  experiments/
    hypotheses.ts
    summaries.ts
  eval/
    bench.ts
    scoring.ts
    metrics.ts
    trajectories.ts
  storage/      # file-based persistence: tasks, runs, events, artifacts, blobs
    atomic.ts
    tasks.ts
    runs.ts
    events.ts
    artifacts.ts
    artifact-registry.ts
    blobs.ts
    sessions.ts
    approvals.ts
    checkpoints.ts
  providers/
    llm/
      types.ts   # provider-agnostic contract
      transport.ts
      openai.ts
      anthropic.ts  # also hosts the zai (GLM) provider
    browser/
      steel.ts
      steel/
        provider.ts
        api.ts
        cdp.ts
        wire-click.ts
        reconfigure.ts
        code-validation.ts
        types.ts
  profiles/
    auth.ts
  cli/
    main.ts
    args.ts
    runner.ts
    runtime-config.ts
    config.ts
    artifacts.ts
    storage-hints.ts
    output.ts
    errors.ts
  ui/
    stream.ts
    review.ts
    colors.ts
  shared/
    types.ts
    schemas.ts
    ids.ts
    paths.ts
    redact.ts
    sanitize.ts
    secrets.ts
  index.ts
```

---


## 18) Suggested browser provider interface

```ts
export interface BrowserProvider {
  createSession(input: CreateSessionInput): Promise<BrowserSession>;
  getSession(sessionId: string): Promise<BrowserSession>;
  stopSession(sessionId: string): Promise<void>;
  observe(input: BrowserObserveInput): Promise<BrowserObservation>;
  exec(input: BrowserExecRequest): Promise<BrowserExecResult>;
  raw?(input: BrowserRawRequest): Promise<unknown>;
}

export interface CreateSessionInput {
  profileId?: string;
  region?: string;
  proxyCountryCode?: string | null;
  timeoutMinutes?: number;
  metadata?: Record<string, unknown>;
}
```

This allows Steel-like providers and future custom providers.

---

## 19) Agent loop

### 19.1 Core loop

```text
1. Ingest user objective / hunch
2. Build Task object
3. Attach or create BrowserSession
4. Load matching skills
5. Observe current state
6. Ask LLM for next action
7. Policy-check action
8. If approved, exec code or observe
9. Auto-observe after navigation (agent stays oriented)
10. Persist artifacts and trace
11. Finish guards: reject finish unless code evidence exists
12. Finish, classify, summarize, and propose skill updates
```

The agent is free to write any code it needs in `exec`. The runtime provides orientation (observe), execution (exec), and honesty enforcement (finish guards, classification). Content extraction, DOM parsing, form filling, and all task-specific logic live in the agent's code — not in the runtime.

### 19.2 Action proposal shape

The agent proposes one of four core actions per turn. Provider-specific actions (e.g. `reconfigure`) can be registered at runtime via the action registry.

```ts
export interface ProposedAction {
  kind:
    | 'observe'
    | 'exec'
    | 'raw'
    | 'finish';
  summary: string;
  payload?: Record<string, unknown>;
}
```

- **observe**: request page orientation (URL, title, headings, element counts)
- **exec**: run JavaScript in the browser. Navigation, extraction, interaction — the agent writes whatever code the task requires
- **raw**: send CDP commands directly. Escape hatch when exec is insufficient
- **finish**: end the run. Only accepted after code evidence exists in a successful exec result

Policy checks and approvals happen automatically before execution — the agent does not request them explicitly.
Skill loading happens automatically on navigation and task start — the agent does not request it explicitly.
Skill proposals happen automatically after run completion — the agent does not request them explicitly.

### 19.3 Stopping conditions
Stop when:
- success criteria are met,
- user cancels,
- budget is exhausted,
- policy denies further progress,
- auth wall requires user action,
- repeated ambiguity is no longer worth the cost.

---

## 20) Observability & debugging

### 20.1 Required observability features
- per-run timeline,
- code executed,
- latest screenshot,
- loaded skills,
- current session and profile,
- approvals timeline,
- artifacts list,
- compare runs view.

### 20.2 Nice-to-have v1.1
- branching graph,
- diffed observation summaries,
- skill suggestion reviewer,
- plot generation for repeated experiments,
- failure taxonomy dashboard.

---

## 21) Skill promotion flow

### 21.1 Why promotion exists
The product gets stronger by converting repeated discoveries into durable files.

### 21.2 Promotion flow
1. run completes,
2. system detects reusable knowledge,
3. model drafts skill patch,
4. patch is stored as artifact,
5. reviewer or policy decides whether to promote,
6. future runs can load the promoted skill.

### 21.3 Promotion criteria
Promote only if knowledge is:
- durable,
- reusable,
- non-secret,
- narrower than a product workflow,
- not just narration.

---

## 22) Security model

### 22.1 Threat assumptions
We assume:
- websites may be adversarial,
- prompts may be noisy or partially malicious,
- auth state is sensitive,
- destructive actions must be gated,
- skills may be team-shared,
- helper edits may introduce risk.

### 22.2 Security rules
- profiles are explicitly selected, never silently escalated,
- secrets do not go into skills,
- helper edits are logged and diffed,
- outbound side effects require policy review or approval,
- browser session provider credentials stay outside the LLM context,
- artifact retention is governed by policy.

### 22.3 Auth wall rule
If a site requires credentials the agent does not already have through profile/session state, the agent should stop and request user assistance rather than improvising credential entry from observation artifacts.

### 22.4 Quarantine (watch-item, not yet built)
Today the same agent both reads untrusted page content and proposes privileged
actions, with the policy engine as the only gate. A future hardening is a
reader/actor split: the context that ingests adversarial public content cannot
itself take high-privilege actions; those are taken by a separate actor context
acting on the reader's structured findings. This complements `22.2` rather than
replacing it. It carries real weight (a second context per run) and is a v2
decision — flagged here so it is not lost, not scheduled.

---

## 23) Evaluation strategy

We should evaluate the product on five axes.

### 23.1 Completion
- task success rate,
- partial completion rate,
- time to complete.

### 23.2 Learning
- uncertainty reduced per dollar,
- number of validated/rejected hypotheses,
- rate of useful skill proposals.

### 23.3 Reliability
- rerun consistency,
- flaky step rate,
- infra failure isolation.

### 23.4 Efficiency
- browser minutes per successful task,
- tokens per successful task,
- branch cost vs insight gained.

### 23.5 Safety
- destructive action approval compliance,
- policy violation rate,
- secret leakage incidents,
- improper profile usage incidents.

---

## 24) MVP definition

### 24.1 MVP product statement
A user can give the system a web task or vague hunch, attach a profile, and receive:
- a completed task **or** an evidence-backed diagnosis,
- screenshots and artifacts,
- a clean trace,
- a list of attempted variants,
- a concise summary of what changed the result.

### 24.2 MVP feature set
- one provider: remote Chrome infra,
- one persistent session per task,
- `observe` + `exec`,
- file-based skills,
- helper module support,
- task/investigate/experiment modes,
- approvals,
- run trace,
- artifact persistence,
- skill proposal artifacts.

### 24.3 MVP non-features
- no sub-agents,
- no generalized memory platform,
- no public skill marketplace,
- no autonomous secret entry,
- no giant built-in workflow catalog,
- no heavy visual planning UX.

---

## 25) Roadmap

### Phase 1 — Minimal operator
- core runtime,
- browser bridge,
- task mode,
- trace capture,
- approvals,
- skill loading.

### Phase 2 — Investigator
- run branching,
- compare views,
- classification,
- experiment summaries,
- skill proposals.

### Phase 3 — Research workbench
- full hypothesis objects,
- ablation matrix support,
- plot/table artifacts,
- skill promotion workflows,
- richer review UI.

### Phase 4 — Team system
- shared skills,
- org policy packs,
- role-scoped profiles,
- evaluation dashboards,
- provider portability.

---

## 26) Non-goals and anti-principles

1. **Do not build a giant browser DSL.**  
   That moves complexity into the core.

2. **Do not confuse fewer methods with simplicity.**  
   Simplicity is about non-interleaving, not cardinality.

3. **Do not hide retries and recovery in dark corners.**  
   Recovery should be visible in trace.

4. **Do not turn prompt context into the integration bus.**  
   Files, state objects, and explicit APIs are better.

5. **Do not store run diaries as skills.**  
   Skills must be durable.

6. **Do not let the model mutate trust boundaries.**  
   Core policy, auth, and provider credentials stay out of its control.

7. **Do not optimize only for happy-path task demos.**  
   Optimize for repeatability, diagnosis, and learning.

---

## 27) Example end-to-end flows

### 27.1 Task flow: download invoices
1. user provides task + selects profile,
2. runtime creates task + session,
3. skill loader loads matching domain/workflow skills,
4. observe current page,
5. agent executes code to navigate and export,
6. policy approves download,
7. artifacts persist,
8. summary + trace returned,
9. reusable learnings proposed as skill patch if warranted.

### 27.2 Investigate flow: onboarding fails with billing history
1. user provides hunch,
2. runtime enters experiment mode,
3. hypothesis set created,
4. branch A = fresh profile,
5. branch B = profile with billing state,
6. compare outcomes,
7. branch C = direct API path,
8. identify decisive variable,
9. return supported/rejected hypotheses + evidence.

### 27.3 Optimization flow: fastest stable strategy
1. user asks for best approach,
2. agent tries UI path,
3. agent observes network/API options,
4. branches into DOM vs direct endpoint strategy,
5. compares latency, reliability, artifact quality,
6. proposes best default strategy and stores supporting skill.

---

## 28) Recommended defaults

### Runtime defaults
- max one live browser session per task
- strict TypeScript
- ESM only
- observation before first action
- auto-observe after navigation
- finish guards reject finishes without code evidence
- trace every code execution
- approvals for irreversible actions
- skills loaded on demand
- experiment branch creation requires explicit rationale

### Agent behavior defaults
- prefer direct routes over UI wandering
- observation is orientation — use exec to read page content
- prefer verification after visible actions
- stop at auth walls
- search skills before inventing new hacks
- propose durable knowledge as skills
- classify uncertainty explicitly

---

## 29) Open questions

1. Should `browser.exec()` run only JS/TS, or also allow Python snippets in a sandboxed sidecar?
2. How much raw browser protocol access should be exposed in v1?
3. What is the minimal compare view that still makes experiment mode genuinely useful?
4. Should skill promotion require human review in all team contexts?
5. How much session replay should live in the product versus the provider UI?
6. Do we want a task-local editable helper file, or only shared helper modules?
7. When should the system automatically branch into experiment mode versus asking the user first?

---

## 30) Final implementation stance

We are not trying to build the most featureful browsing framework.
We are trying to build the **clearest, smallest, most compounding agent runtime** for real web work.

The winning combination is:
- **minimal core**,
- **stateful browser bridge**,
- **editable helpers**,
- **file-based skills**,
- **explicit trace and policy boundaries**,
- **first-class experiments and comparisons**.

That gives us a product that can:
- do practical browser work,
- investigate failures,
- optimize strategies,
- and turn repeated reality contact into reusable knowledge.

---

## 31) Inspiration notes

This spec is informed by:
- Rich Hickey’s “Simple Made Easy” distinction between simple and easy, especially the importance of avoiding interleaving of concerns.
- Pi’s minimal-core, extension-first philosophy.
- Browser Harness’s emphasis on code-as-interface, raw escape hatches, and durable site knowledge.
- Remote cloud browser infrastructure patterns such as persistent sessions, profiles, replay, and managed browser lifecycle.
- The view that AI research and agentic work increasingly become about **experiment throughput**, with the human supervising which questions are worth spending real-world budget on.
