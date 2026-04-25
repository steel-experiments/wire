# Agent Module Simplification Audit - Detailed Findings

## Executive Summary

The agent/ module violates MANIFESTO principles of clear boundaries and non-interleaving concerns. The core runtime has become overly complex with braided logic, missing escape hatches, and unnecessary abstraction.

---

## 1. Braided Concerns (High Priority)

### 1.1 Runtime as God Object
**File**: `src/agent/runtime.ts`
**Lines**: 542-671 (130 lines)

**Issue**: The `runMainLoop` function orchestrates:
- Policy checking
- Step execution
- Error handling
- Skill synchronization
- Stop condition evaluation
- Action routing
- Auto-observation logic
- Recovery logic

**Before**:
```typescript
async function runMainLoop(state, config, turn, signals) {
  while (true) {
    // Check stopping conditions
    const stopResult = shouldStop(state, {...});
    if (stopResult.stop) break;

    // Get action from LLM
    action = await turn(state, config.provider);

    // Execute step with policy checks
    const stepResult = await executeStep(...);

    // Handle auto-observation after navigation
    if (isNavigation && !producedOutput) {
      await autoObserve(...);
    }

    // Handle errors and recovery
    if (isRecoverableError) {
      continue;
    }
  }
}
```

**After**:
```typescript
async function runMainLoop(state, config, turn) {
  const loopController = new LoopController(config);
  const stepExecutor = new StepExecutor(config);
  const recoveryHandler = new RecoveryHandler(config);

  while (!loopController.shouldStop(state)) {
    const action = await turn(state, config.provider);
    const result = await stepExecutor.execute(state, action);

    if (result.requiresRecovery) {
      await recoveryHandler.recover(state, result);
    }
  }
}
```

### 1.2 Policy Mixed with Execution
**File**: `src/agent/loop.ts`
**Lines**: 171-233 (62 lines)

**Issue**: Policy checking embedded directly in step execution.

**Before**:
```typescript
async function executeStep(state, action, provider, policyEngine) {
  // Policy check for non-trivial actions
  if (action.kind !== "observe" && action.kind !== "finish") {
    const policyAction = {...};
    const decision = policyEngine.check(actionId, policyAction);
    state.events.push(policyCheckEvent);

    if (decision.result === "deny") {
      return { state, policyDenied: true, authWallHit };
    }
  }
  // ... execute action
}
```

**After**:
```typescript
async function executeStep(state, action, provider, policyService) {
  const policyResult = await policyService.evaluate(action);
  if (policyResult.denied) {
    return createDeniedResult(policyResult);
  }
  // ... execute action
}
```

### 1.3 Skill Loading Mixed with Runtime
**File**: `src/agent/runtime.ts`
**Lines**: 113-141 (28 lines)

**Issue**: Skill loading logic mixed with runtime orchestration.

**Before**:
```typescript
async function runMainLoop(...) {
  // ... in loop ...
  await syncMatchedSkills(state, config.skillDir);

  // ... elsewhere ...
  await initializeState(state, config, ...) {
    await syncMatchedSkills(state, config.skillDir);
  }
}
```

**After**:
```typescript
class SkillOrchestrator {
  private skillLoader: SkillLoader;

  async syncSkillsForState(state, skillDir) {
    return this.skillLoader.syncForCurrentContext(state, skillDir);
  }
}
```

---

## 2. Missing Escape Hatches (High Priority)

### 2.1 Hardcoded LLM Action Parsing
**File**: `src/agent/runtime.ts`
**Lines**: 242-256, 361-414

**Issue**: No way to inject custom action parsers or skill proposal logic.

**Before**:
```typescript
const action = await turn(state, config.provider);
const parsed = parseActionFromLlm(response.content, state);
```

**After**:
```typescript
const action = await turn(state, config.provider);
const parsed = await config.actionParser?.parse(response.content, state)
  ?? defaultActionParser.parse(response.content, state);
```

### 2.2 Policy Engine Not Swappable
**File**: `src/agent/loop.ts`
**Lines**: 171-233

**Issue**: Policy engine interface not exposed for injection.

**After**:
```typescript
interface LoopExecutorConfig {
  policyEngine?: PolicyEngine; // optional for testability
  maxSteps?: number;
}
```

### 2.3 Browser Bridge Hardcoded
**File**: `src/agent/loop.ts`
**Lines**: 236-386

**Issue**: No escape hatch for custom browser behaviors.

**After**:
```typescript
interface StepExecutor {
  executeObservation?: (opts: ObservationOptions) => Promise<Observation>;
  executeCode?: (opts: CodeExecutionOptions) => Promise<ExecutionResult>;
}
```

---

## 3. Over-Abstraction (Medium Priority)

### 3.1 ContextBundle Over-Engineering
**File**: `src/agent/context.ts`
**Lines**: 39-47

**Issue**: Simple data structure wrapped in interface with no behavior.

**Before**:
```typescript
export interface ContextBundle {
  task: TaskObjective;
  skills: SkillSummary[];
  observations: ObservationSummary[];
  recentTraces: TraceSummary[];
  policyNotes: string[];
  budget?: BudgetSummary;
  plan?: string;
}
```

**After**:
```typescript
type ContextBundle = {
  task: TaskObjective;
  skills: SkillSummary[];
  observations: ObservationSummary[];
  recentTraces: TraceSummary[];
  policyNotes: string[];
  budget?: BudgetSummary;
  plan?: string;
};
```

### 3.2 TaskPlan Trivial Abstraction
**File**: `src/agent/planning.ts`
**Lines**: 7-12

**Issue**: Interface adds no value over plain object.

**Before**:
```typescript
export interface TaskPlan {
  steps: string[];
  currentStepIndex: number;
  mode: TaskMode;
}
```

**After**:
```typescript
type TaskPlan = {
  steps: readonly string[];
  currentStepIndex: number;
  mode: TaskMode;
};
```

### 3.3 BranchDecision Unnecessary Wrapper
**File**: `src/agent/branching.ts`
**Lines**: 9-15

**Issue**: Simple boolean + optional values wrapped.

**After**:
```typescript
type BranchDecision = {
  shouldBranch: boolean;
  reason?: string;
  branchLabel?: string;
  hypothesisId?: string;
};
```

---

## 4. Logic in Wrong Module (Medium Priority)

### 4.1 Artifact Creation in Runtime
**File**: `src/agent/runtime.ts`
**Lines**: 278-329, 331-360

**Issue**: Task artifact creation mixed with runtime orchestration.

**Move to**: `src/trace/artifact-service.ts`

### 4.2 Skill Proposal Logic
**File**: `src/agent/runtime.ts`
**Lines**: 362-414

**Issue**: Skill proposal mixed with main execution flow.

**Move to**: `src/skills/promotion-service.ts`

### 4.3 Failure Summary Building
**File**: `src/agent/classify.ts`
**Lines**: 55-79

**Issue**: Presentation logic in classification module.

**Move to**: `src/trace/summarizer.ts`

---

## 5. Duplicated Patterns (Medium Priority)

### 5.1 Duplicate Observation Payload Creation
**Locations**:
- `src/agent/loop.ts:249-264`
- `src/agent/runtime.ts:513-521`

**Before**:
```typescript
// Both create nearly identical payloads
const obsPayload: JsonObject = {
  url: observation.url,
  title: observation.title,
};
if (observation.targetId) obsPayload.targetId = observation.targetId;
// ... etc
```

**After**:
```typescript
function createObservationPayload(observation: BrowserObservation): JsonObject {
  return {
    url: observation.url,
    title: observation.title,
    ...(observation.targetId && { targetId: observation.targetId }),
    // ... consolidate logic
  };
}
```

### 5.2 Code Result Parsing Duplication
**Locations**:
- `src/agent/classify.ts:19-54`
- `src/agent/loop.ts:438-489`

**Solution**: Extract shared utility in `src/shared/result-parser.ts`

---

## 6. Dead Code/Unreachable Paths (Low Priority)

### 6.1 Unused Action Kinds
**File**: `src/agent/llm-parse.ts`
**Lines**: 9-18

**Issue**: `raw`, `request-approval`, `branch-experiment`, `load-skill`, `propose-skill` never used.

**Remove**: Only keep `observe`, `exec`, `finish` for now.

### 6.2 Unused Re-export
**File**: `src/agent/runtime.ts`
**Line**: 755

**Issue**: Planning types re-exported but not used locally.

---

## 7. Over-Engineering (Low Priority)

### 7.1 Complex Classification Logic
**File**: `src/agent/classify.ts`
**Lines**: 92-315 (223 lines)

**Issue**: Nested conditionals could be rules-based.

**Before**: Complex if-else chain
**After**: Rules engine with strategies

### 7.2 Too Many State Helpers
**File**: `src/agent/state-helpers.ts`
**Lines**: 8-53

**Issue**: Multiple similar query functions.

**After**: Generic `findLastByKind` with type predicates

---

## Implementation Priority

### Phase 1 (Critical)
1. Extract policy service from loop execution
2. Split main loop into controller/executor/recovery
3. Add escape hatch for action parsers

### Phase 2 (Important)
4. Remove over-abstraction in interfaces
5. Move artifact creation to trace module
6. Consolidate observation payload creation

### Phase 3 (Nice-to-have)
7. Extract skill promotion service
8. Simplify classification with rules engine
9. Clean up dead code

---

## Benefits

These changes will:
- Reduce runtime.ts from 756 to ~400 lines
- Eliminate inter-module dependencies
- Make individual components testable
- Preserve escape hatches as required by MANIFESTO
- Improve inspectability and traceability