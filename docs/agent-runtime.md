# Agent Runtime

The agent runtime is the heart of Wire. It owns the turn loop that drives a browser session from task objective to classified result.

## Entry points

| Function | Source | Purpose |
|----------|--------|---------|
| `executeTask()` | `src/agent/runtime.ts` | Start a new task from scratch |
| `resumeTask()` | `src/agent/runtime.ts` | Resume from an approval checkpoint |

Both return a `LoopResult` containing the final run state, trace events, artifacts, and any pending approval.

## The agent loop

```
1. Ingest user objective
2. Build Task object
3. Attach or create BrowserSession
4. Load matching skills (by hostname + tags)
5. Observe current page state
6. Ask LLM for next action
7. Policy-check the action
8. If approved, execute (observe/exec/raw)
9. Auto-observe after navigation
10. Persist trace events and artifacts
11. Evaluate stopping conditions
12. If finish: validate completion contract, review artifacts, classify
13. Repeat from step 6
```

### Step 1-4: Initialization (`initializeState`)

- Creates `LoopState` with the task, session, and empty event list
- Emits the initial `contract-check` event
- Takes the first observation of the page
- Syncs skills by matching hostname and task tags
- If resuming from approval, re-executes the previously approved action

### Step 5-6: Agent turn (`defaultAgentTurn`)

The turn function builds a context bundle from the current loop state and sends it to the LLM:

1. **Observations** — last 3 page observations (URL, title, headings, element counts)
2. **Recent traces** — last 5 trace events (summarized, capped at 1.5KB each)
3. **Metacognition** — stuck-loop warnings, timeout constraints, truncated batch alerts
4. **Skills** — guidance from matched skills (capped at 1KB per skill)
5. **Plan** — current task plan phase
6. **Contract** — completion contract requirements
7. **State diff** — observation change detection and stagnation counter
8. **Repeat signal** — consecutive identical action/result counts
9. **Budget** — remaining steps
10. **User messages** — recent user messages with intent classification

The LLM returns a `ProposedAction` with one of four core kinds:

| Action | Description |
|--------|-------------|
| `observe` | Request page orientation |
| `exec` | Run JavaScript in the browser |
| `raw` | Send CDP commands directly |
| `finish` | End the run |

Provider-specific actions (e.g., `reconfigure`) can be registered via the `ActionRegistry`.

### Step 7: Policy check

Every proposed action goes through the policy engine before execution:

- **allow** — action proceeds immediately
- **deny** — action is blocked, error recorded
- **require-approval** — run pauses, checkpoint saved, approval request created

See [policy-engine.md](policy-engine.md) for details.

### Step 8-10: Execution

Exec actions run JavaScript against the current browser session. Results are recorded as `code-exec` and `code-result` trace events. Artifacts from extraction are recorded as `artifact` events.

### Step 11: Stopping conditions

The loop stops when:
- Success criteria appear met (agent proposes `finish`)
- Maximum steps reached
- User cancels (`AbortSignal`)
- Policy denies further progress
- Auth wall detected
- Budget exhausted
- Stuck-loop guards fire

### Step 12: Finish guards

The runtime rejects premature finishes in task mode:

- **Step 3 guard** — must have at least 3 steps before finishing
- **Artifact guard** — must have recorded a task artifact or extracted result
- **Extraction guard** — must have attempted data extraction
- **Post-navigation guard** — navigation-only results don't count as evidence
- **Completion contract** — must pass `validateTaskContract()`
- **Artifact review** — LLM reviews final artifact quality (when contract exists)

If a guard fails, the runtime forces a verification action instead of accepting the finish, and the loop continues.

## Stuck-loop guards

Three layered failure detection mechanisms prevent infinite loops:

| Guard | Trigger | Threshold |
|-------|---------|-----------|
| **Repeat fail** | Same code fails repeatedly | 3 consecutive |
| **Stuck on success** | Same action + same result | 4 consecutive |
| **Signature-only stall** | Same action, different results | 7 consecutive |
| **No-progress stall** | Consecutive nav-only/empty results | 5 consecutive |

When any guard fires, the loop breaks with a `thought-summary` event explaining the stall.

## Anti-bot recovery

When an observation detects a captcha or anti-bot challenge:
1. Check if the `reconfigure` action is registered (Steel provider)
2. Create a new session with `useProxy: true` and `solveCaptcha: true`
3. Execute the reconfiguration
4. Continue the loop with the new session

This is automatic — the agent does not request it explicitly.

## User message handling

User messages can be injected during a running task via `UserMessageInbox`:

- Messages become `user-message` trace events
- Intent is classified as `assist`, `redirect`, or `cancel`
- Redirect messages override the objective for the current turn
- Cancel messages stop the loop

## Skill loading

Skills are synced at the start of each iteration:
1. Extract hostname from the latest observation
2. Derive tags from the task title, objective, and criteria
3. Match skills by hostname patterns and tags
4. Emit `skill-load` event when the skill set changes
5. Emit `skill-empty` event once if the skill directory has no files

## Skill proposals

After a run completes, the runtime asks the LLM to propose a skill if:
- An LLM provider is available
- No skill proposal has already been recorded

The proposal includes: scope, hostname, confidence, rationale, and the generated markdown content. If a skill directory is configured, the proposal is written to disk and potentially promoted to active status.

## Classification

Post-run classification in `src/agent/classify.ts` considers:

1. **Infra signals** — browser crash, network timeout, rate limiting
2. **Policy signals** — policy denied, auth wall
3. **Error counts** — high error count with successful execs suggests site error; without suggests agent error
4. **Code success/fail ratio** — all success = task-complete; mixed = partial-success; all fail = site-error
5. **Artifact evidence** — must have a substantive answer artifact
6. **Objective relevance** — extracted content must address the task objective
7. **Contract validation** — completion contract must pass
8. **Artifact review** — LLM artifact quality check must pass
9. **Stagnation** — consecutive unchanged observations downgrade task-complete to partial-success

## Experiment mode

In experiment mode:
1. Run the first attempt
2. Check `shouldBranch()` based on classification and run count
3. If branching is warranted, execute another run with `parentRunId` set
4. Repeat up to `budget.maxRuns` (default 3)
5. Build an `ExperimentBundle` with all runs, comparisons, and a summary
6. Persist the bundle

## LoopState

The internal state of a running loop:

```ts
interface LoopState {
  task: Task;
  run: Run;
  sessionId: SessionId;
  loadedSkills: LoadedSkill[];
  events: TraceEvent[];
  stepCount: number;
  startedAt: string;
  helperSource: string;
  helperVersion: number;
  latestScreenshotBase64?: string;
  contract: TaskContract;
  sessionConfig?: SessionConfig;
  profileId?: ProfileId;
}
```

## Completion contracts

Contracts are derived from the task's success criteria, constraints, and objective. Before accepting a `finish` action, the runtime validates:

- `mustVisit` — URLs that must have been visited
- `mustMention` — keywords that must appear in the extracted content
- `mustProduce` — artifact kinds that must have been created
- `mustReach` — URL patterns that must appear in observations
- `mustNotContain` — content patterns that must not appear

Contracts are defined in `src/agent/contract.ts`.
