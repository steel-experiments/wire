# Wire Skills v2 RFC

## Goal

Turn Wire skills from passive site notes into durable, evidence-backed playbooks without growing the core into a memory system, retry engine, or helper framework.

Skills v2 should preserve the existing Wire line:

- Runs keep evidence.
- Experiments compare evidence.
- Skills store the distilled map.
- Helpers stay thin, auditable, and optional.

## Non-Goals

- No automatic repeated execution of side-effectful tasks.
- No diary-like strategy files injected into prompts.
- No generated executable helpers in this RFC.
- No new dependency.
- No hidden retries or opaque self-healing.
- No promotion of secrets, transcripts, credentials, or one-off narration into skills.

## Current State

Wire already has a working self-improving skill pipeline:

1. Trace distillation: `llmProposeSkill()` reads run events and extracts reusable facts, selectors, routes, wait patterns, and traps.
2. Confidence-gated promotion: proposals land in `.proposals/`; high-confidence or independently rediscovered host knowledge can become active.
3. Hostname and tag matching: skills are scored by hostname match, tag overlap, scope, source, and generated confidence.
4. Runtime skill sync: matched skills are reloaded during execution and injected into context.
5. Source protection: team and builtin skills are not overwritten by generated content.
6. Secret scanning and dedup: generated proposals with credential-like content are rejected; near-duplicates are not rewritten.

This works end to end. The gap is not basic skill lifecycle. The gap is that generated skills mostly capture reference facts, not reliable procedures, and the system has limited evidence about whether a loaded skill improved a future run.

## Problems

### 1. Generated Skills Lack Workflows

Runtime guidance already prefers a `Workflow` section when present, but generated proposals do not ask for or store one. Most generated skills therefore behave like notes rather than playbooks.

### 2. Attempt History Has No Structured Comparison

Wire preserves traces, but it does not produce a compact comparison artifact for repeated attempts at the same task. That makes it hard to answer whether one path was faster, cheaper, or more reliable than another.

The fix should not be a hostname scratchpad full of attempt narration. Attempt history belongs with run or experiment evidence. Only durable conclusions belong in skills.

### 3. Repeated Runs Need Policy Boundaries

Re-running the same task can be unsafe. A second run might submit a form twice, mutate account state, redownload files, trigger an email, spend money, or consume quota.

Any refinement loop must be gated by task safety and user intent.

### 4. Skill Effectiveness Is Not Measured

The system records skill load events and final outcomes, but it does not aggregate whether a skill correlates with successful, shorter, or cheaper runs. Skill confidence is mostly an initial distillation judgment.

## Proposed Milestones

### Milestone 1: Workflow Generation

Add first-class workflow output to generated skill proposals.

Extend the promotion candidate shape with an optional workflow:

```ts
interface PromotionCandidate {
  hostname: string;
  workflow: string[];
  facts: string[];
  selectors: string[];
  routes: string[];
  waits: string[];
  traps: string[];
  confidence: number;
  sourceRunId: RunId;
}
```

Update `llmProposeSkill()` to request JSON shaped like:

```json
{
  "hostname": "example.com",
  "workflow": [
    "Fetch https://api.example.com/v2/search?q={query} when no auth is required.",
    "Parse response.data.items[] for id, title, and price.",
    "Fall back to browser interaction when the API returns empty or requires session state."
  ],
  "facts": [],
  "selectors": [],
  "routes": [],
  "waits": [],
  "traps": [],
  "confidence": 0.8
}
```

Generate markdown with `## Workflow` before the existing sections:

```markdown
## Workflow

1. Fetch `https://api.example.com/v2/search?q={query}` when no auth is required.
2. Parse `response.data.items[]` for `id`, `title`, and `price`.
3. Fall back to browser interaction when the API returns empty or requires session state.
```

Implementation scope:

- Update `PromotionCandidate`.
- Update `parseSkillProposalResponse()`.
- Update `llmProposeSkill()` prompt.
- Update `generateSkillProposal()`.
- Ensure `hasReusableSignal()` treats workflow as reusable signal.
- Add focused tests for workflow parsing, markdown generation, and backward compatibility.

Acceptance criteria:

- Generated proposals can include `## Workflow`.
- Loaded skills surface workflow guidance before static facts.
- Existing generated skills without workflow still parse and load.
- Secret scanning covers workflow text.
- Malformed or non-array workflow output is ignored safely.

Estimated non-test LOC: about 40-70.

### Milestone 2: Method Preference Inside Workflow

Encode probe-first behavior as durable workflow guidance, not as a new core enforcement layer.

Preferred format:

```markdown
## Workflow

1. Prefer the documented API route when the skill names one.
2. Use browser interaction when auth/session state is required or the API fails.
3. Record the fallback reason in the trace if the direct route is not usable.
```

Avoid adding separate `Recommended Method` and `Fallback Method` sections unless runtime guidance is explicitly updated to prioritize them. The current runtime already knows how to prioritize `Workflow`.

Acceptance criteria:

- The distillation prompt asks for cheapest reliable path, including API/network routes when evidenced by the trace.
- Generated workflow steps include fallback conditions when the trace supports them.
- No policy bypass: browser/session/auth constraints still apply.

Estimated non-test LOC: included in Milestone 1.

### Milestone 3: Experiment Comparison Artifacts

Add a compact comparison artifact for deliberate repeated attempts. This is not a skill file and is not injected as durable site memory.

Example artifact:

```json
{
  "taskKey": "download-public-filing-sec",
  "runs": [
    {
      "runId": "run_a",
      "loadedSkills": [],
      "classification": "task-complete",
      "stepCount": 8,
      "totalTokens": 12000,
      "durationMs": 42000
    },
    {
      "runId": "run_b",
      "loadedSkills": ["skill_sec_gov"],
      "classification": "task-complete",
      "stepCount": 4,
      "totalTokens": 7000,
      "durationMs": 19000
    }
  ],
  "conclusion": "The skill-backed API route completed with fewer steps and lower token cost."
}
```

This artifact can later inform skill promotion or revision, but the skill itself should only receive distilled durable conclusions such as routes, traps, and workflow steps.

Acceptance criteria:

- Comparison output lives with run or experiment artifacts, not under the skill directory.
- It records run IDs, loaded skill IDs, final classification, step count, token usage when available, and duration when available.
- It does not store secrets or full transcripts.
- It does not change skill matching or runtime behavior by itself.

Estimated non-test LOC: about 80-120 if built from existing run result fields.

### Milestone 4: Policy-Gated Refinement

Only after workflow generation and comparison artifacts exist, add optional refinement for safe tasks.

Refinement may auto-run only when all of the following are true:

- The task is read-only or explicitly marked repeatable.
- No destructive action, payment, checkout, account mutation, posting, messaging, or credential entry was detected.
- No human approval was required in the prior run.
- The user selected investigate/experiment mode or opted into refinement.
- The max iteration count is explicit and small, defaulting to 2.

Loop sketch:

1. Run the task once and persist trace/evidence.
2. Generate a candidate workflow skill.
3. If policy permits, run again with the candidate skill available.
4. Compare the two runs.
5. Promote or revise only the distilled skill content, not the attempt diary.

Stop conditions:

- Candidate run fails where baseline succeeded.
- Improvement is below a configured threshold.
- Policy signals side effects or approval.
- Iteration cap is reached.

Acceptance criteria:

- Refinement is opt-in or policy-confirmed for anything not obviously read-only.
- Every refinement attempt has separate run evidence.
- The comparison artifact explains why refinement stopped.
- No repeated execution happens from normal task mode without the gate passing.

Estimated non-test LOC: about 150-220, only feasible if there is LOC room or equivalent consolidation.

### Milestone 5: Skill Effectiveness Signals

Track lightweight aggregate outcomes for loaded skills.

Initial metadata should be descriptive, not self-modifying:

```json
{
  "skillId": "skill_github_com_01272fa1",
  "loadedCount": 8,
  "successCount": 7,
  "avgStepsWhenLoaded": 4.2,
  "avgTokensWhenLoaded": 6500,
  "lastLoadedAt": "2026-05-06T10:00:00Z"
}
```

Do not auto-retire or auto-boost skills in the first version. Surface the signal for humans and later RFCs.

Acceptance criteria:

- Metrics are append-only or recomputable from run events.
- Metrics do not alter skill matching until a later explicit policy is designed.
- Runs with multiple skills do not overclaim attribution.
- Failed, blocked-auth, and policy-denied runs are counted distinctly.

Estimated non-test LOC: about 80-140.

## Deferred: Helper Graduation

Generated executable helpers are out of scope for Skills v2.

They need a separate RFC because they cross several boundaries:

- code generation,
- policy review,
- filesystem layout,
- test fixtures,
- auditability,
- helper versioning,
- escape hatches,
- and possible site-specific auth/session assumptions.

Skills v2 may produce workflow text that later helps a human or future tool write a helper, but it should not generate or execute new helper files automatically.

## LOC Budget

The project cap is 12,500 non-test `src/` LOC. A current rough count shows about 12,000 non-test `src/` LOC, leaving roughly 500 lines before the cap. Total `src/` including tests is much higher and should not be used as the cap number.

Recommended implementation order by value per LOC:

1. Workflow generation and method preference: about 40-70 non-test LOC.
2. Experiment comparison artifacts: about 80-120 non-test LOC.
3. Skill effectiveness signals: about 80-140 non-test LOC.
4. Policy-gated refinement: about 150-220 non-test LOC.

If estimates exceed remaining budget, stop before Milestone 4 and propose consolidation or deletions. Do not raise the LOC cap for skill convenience work.

## Test Plan

Minimum tests before landing Milestone 1:

- `parseSkillProposalResponse()` accepts workflow arrays.
- `parseSkillProposalResponse()` tolerates missing workflow.
- `parseSkillProposalResponse()` ignores malformed workflow fields.
- `generateSkillProposal()` emits `## Workflow` before facts/selectors/routes.
- `hasReusableSignal()` returns true for workflow-only candidates.
- Secret scanning rejects secrets inside workflow steps.
- Existing skill loading and matching tests remain unchanged.

Additional tests before refinement:

- Repeated execution is blocked for unsafe task classifications.
- Opt-in read-only refinement produces separate run IDs.
- Comparison artifacts include baseline and candidate metrics.
- Candidate failure prevents automatic promotion.

## Resolved Questions

### Task-level marker for read-only / repeatable work

Use the existing `TaskMode` enum. Tasks in `"investigate"` or `"experiment"` mode are eligible for refinement. Tasks in `"task"` mode are never auto-refined regardless of constraints.

The policy gate for Milestone 4 checks two things: (1) mode is not `"task"`, and (2) the completed run's trace contains no destructive-action signals (form submissions with non-GET methods, payment/checkout URL patterns, account mutation keywords, credential entry, policy approvals). No new schema field is needed.

### Comparison artifact location

Comparison artifacts live under the existing experiment bundle directory, reusing the `comparisonSpecSchema` and `experimentSummarySchema` already defined in `src/shared/schemas.ts`. No new top-level directory or artifact index. Run directories hold individual run evidence; experiment directories hold cross-run comparisons.

### Skill effectiveness metadata: incremental or recomputed

Store incrementally as a companion file (`{skill-filename}.stats.json`) alongside the skill. This file is a materialized view; the source of truth is `skill-load` and classification trace events. Stats can be rebuilt by scanning all run events. Incremental storage avoids re-reading traces on every run; recomputability provides auditability and recovery from corruption.

First version: append-only counts and averages. No automatic backfill of historical stats.

### Multiple skills sharing credit

Do not attribute to individual skills. Track "runs where this skill was among the loaded set" — the signal is correlation, not causation. When multiple skills are loaded, each gets a `loadedCount` increment, but success attribution is to the set, not distributed. The effectiveness file records `loadedWithSkillIds` per run so a human can inspect co-occurrence later.
