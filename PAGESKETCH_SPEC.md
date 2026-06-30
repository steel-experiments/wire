# PageSketch Implementation Spec

## Summary

PageSketch is an opt-in observation enhancement for Wire. It borrows the useful part of WebChallenger's PageMem idea: give the model a compact, structured map of visible page regions and controls before it writes browser JavaScript.

This must not become a second agent runtime. Wire keeps its current loop:

```text
observe -> LLM proposes action -> policy -> exec/raw -> trace -> validate
```

PageSketch only improves the observation context and optional helper surface.

## Feature Flag

PageSketch is disabled by default.

Users must opt in explicitly:

```bash
wire run --page-sketch --objective "Find the latest invoice total"
```

Benchmark runs may also opt in for controlled comparison:

```bash
wire bench --page-sketch
```

No existing `wire run`, embedded runtime, benchmark, or test behavior should change unless the feature is enabled. Do not enable PageSketch from config or environment in the first implementation. Keeping it CLI/API explicit makes A/B comparison clean and prevents silent prompt/token changes.

Required propagation:

```text
CLI flag --page-sketch
  -> RunOptions.pageSketch = true
  -> RuntimeConfig.pageSketch = true
  -> observeBrowser(... includePageSketch: true)
  -> BrowserProvider.observe({ includePageSketch: true })
  -> BrowserObservation.pageSketch
  -> trace observation payload
  -> prompt context
```

Defaults:

```ts
pageSketch?: boolean // default false
includePageSketch?: boolean // default false
```

## Goals

- Improve Wire's first-pass page understanding without replacing model-authored `exec`.
- Give the model stable section/control hints so it wastes fewer turns probing the DOM.
- Keep observations compact, bounded, traceable, and redacted.
- Preserve Wire's safety model: policy, approvals, contracts, traces, artifacts, and finish guards remain unchanged.
- Make A/B evaluation straightforward by requiring `--page-sketch`.

## Non-Goals

- Do not port WebChallenger's `agent.py`.
- Do not add full persistent `WebsiteMem` or `PageMem` as runtime state.
- Do not add hard-coded form/table/dropdown controllers to the core loop.
- Do not make VLM click grounding the default action path.
- Do not crawl sites during normal `wire run`.
- Do not silently alter prompts for users who did not pass `--page-sketch`.

## Data Model

Add optional PageSketch fields to shared types.

```ts
export interface PageSketch {
  version: 1;
  generatedAt: string;
  sections: PageSketchSection[];
  truncated?: boolean;
  limits: {
    maxSections: number;
    maxControlsPerSection: number;
    maxTextPreviewChars: number;
  };
}

export interface PageSketchSection {
  id: string;
  kind:
    | "nav"
    | "header"
    | "main"
    | "form"
    | "table"
    | "list"
    | "dialog"
    | "footer"
    | "content";
  selectorHint: string;
  label?: string;
  heading?: string;
  textPreview?: string;
  bbox?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  counts: {
    links: number;
    buttons: number;
    inputs: number;
    tables: number;
    lists: number;
  };
  controls: PageSketchControl[];
}

export interface PageSketchControl {
  label: string;
  tag: string;
  role?: string;
  type?: string;
  href?: string;
  selectorHint: string;
  selectorAlternates?: string[];
  disabled?: boolean;
  required?: boolean;
}
```

Add this field to `BrowserObservation`:

```ts
pageSketch?: PageSketch;
```

Add this field to `BrowserObserveInput`:

```ts
includePageSketch?: boolean;
```

## Sketch Generation Rules

Generate PageSketch inside the browser provider's observe path when `includePageSketch` is true.

Current observation is intentionally light in `src/providers/browser/steel/provider.ts`. Keep the default path unchanged. When enabled, extend the provider observe script with an additional browser-side sketch function.

Section candidates:

- `dialog`, `[role="dialog"]`
- `header`
- `nav`
- `main`
- `form`
- `table`
- `ul`, `ol`, `[role="list"]`, grid-like containers
- `footer`
- fallback visible content blocks: `section`, `article`, large visible `div`

Control candidates inside each section:

- `a[href]`
- `button`
- `input`
- `textarea`
- `select`
- `[role="button"]`
- `[role="link"]`
- `[role="combobox"]`
- `[role="tab"]`
- `[contenteditable="true"]`

Bounds:

```ts
const PAGE_SKETCH_LIMITS = {
  maxSections: 12,
  maxControlsPerSection: 12,
  maxTextPreviewChars: 280,
  maxLabelChars: 120,
  maxSelectorAlternates: 3,
};
```

Selection order:

1. Visible dialogs first.
2. Header/nav.
3. Main forms, tables, lists.
4. Main content sections.
5. Footer last only if it has task-relevant controls or there are few other sections.

Visibility:

- Element must have a non-zero bounding box.
- Element must not be `display:none`, `visibility:hidden`, or `aria-hidden=true`.
- Prefer viewport-visible sections first.
- Include off-viewport sections only if they are major semantic sections and within the cap.

Text handling:

- Use `innerText` or textContent fallback.
- Normalize whitespace.
- Remove repeated text.
- Cap previews aggressively.
- Do not include hidden text, script text, style text, or long raw page dumps.

Selector hints:

- Prefer stable selectors:
  - `#id` when id is present and not obviously generated.
  - `[data-testid="..."]`
  - `[data-test="..."]`
  - `[aria-label="..."]`
  - `input[name="..."]`
  - `button[type="submit"]` with nearby form selector.
- Avoid brittle full absolute paths unless no better hint exists.
- Include selector alternates only when short and likely useful.

Security and hygiene:

- Redact secrets before trace/prompt use through existing redaction utilities.
- Strip prompt-injection patterns before prompt assembly.
- Do not execute page-authored scripts beyond normal DOM reads.
- Do not include cookies, localStorage, sessionStorage, or form values by default.

## Prompt Integration

Extend `ContextBundle` in `src/agent/context.ts`:

```ts
pageSketch?: PageSketchSummary;
```

Use a prompt-ready summary shape rather than dumping raw `PageSketch`:

```ts
export interface PageSketchSummary {
  sections: Array<{
    id: string;
    kind: string;
    label?: string;
    heading?: string;
    textPreview?: string;
    selectorHint: string;
    controls: Array<{
      label: string;
      tag: string;
      role?: string;
      type?: string;
      selectorHint: string;
    }>;
  }>;
  truncated?: boolean;
}
```

Prompt section format:

```text
Page sketch:
- nav #nav: Home | Pricing | Docs
  Controls: "Docs" a[href="/docs"], "Sign in" button
- form form[aria-label="Search"]: Search form
  Controls: "Search" input[name="q"], "Submit" button[type="submit"]
- table table.orders: 12 visible rows, columns Invoice | Status | Total
```

Rules:

- Only include PageSketch in prompts when enabled.
- Keep this section below extracted evidence and above recent activity.
- Cap the entire prompt-rendered sketch to a fixed character budget, initially 3000 chars.
- If truncated, say it is truncated.

## Runtime Integration

Target files:

- `src/shared/types.ts`
- `src/shared/schemas.ts`
- `src/browser/bridge.ts`
- `src/browser/observe.ts`
- `src/agent/observation.ts`
- `src/agent/runtime.ts`
- `src/agent/turn.ts`
- `src/agent/context.ts`
- `src/cli/args.ts`
- `src/cli/runner.ts`
- `src/cli/runtime-config.ts`
- `src/cli/bench.ts`
- `src/providers/browser/steel/provider.ts`

Implementation notes:

1. Add `pageSketch?: boolean` to `RunOptions`.
2. Add `pageSketch?: boolean` to `RuntimeConfig`.
3. Add `--page-sketch` to `wire run`.
4. Add `--page-sketch` to `wire bench` for controlled evaluation.
5. Pass `includePageSketch: config.pageSketch === true` to all runtime-owned observations.
6. Preserve existing behavior when `pageSketch !== true`.
7. Persist `pageSketch` in observation trace payloads only when present.
8. Include `pageSketch` in LLM context only when present.

Observation call sites to audit:

- Initial observation during runtime startup.
- `observe` action.
- Auto-observe after navigation or likely interaction.
- Recovery observations after transient execution failures.
- Approval resume path.
- Anti-bot reconfiguration path if it observes after session swap.

## Browser Provider Implementation

In `src/providers/browser/steel/provider.ts`, keep `OBSERVE_SCRIPT` as the default script. Add a second script or parameterized script only used when `includePageSketch` is true.

Recommended structure:

```ts
const OBSERVE_SCRIPT = `...current light observe...`;
const OBSERVE_WITH_PAGE_SKETCH_SCRIPT = `...light observe + pageSketch...`;

const script = input.includePageSketch
  ? OBSERVE_WITH_PAGE_SKETCH_SCRIPT
  : OBSERVE_SCRIPT;
```

Avoid changing default observation cost.

The sketch builder should run entirely in page context and return plain JSON. It should not depend on Wire helper functions because observe is provider-owned and should remain self-contained.

## Helper Additions

After the sketch is in place, add transparent browser-side helpers to `src/browser/helpers.ts`.

Initial helper candidates:

```js
function extractVisibleSections() { ... }
function controlsIn(selector) { ... }
function extractTableRows(selector, limit = 50) { ... }
function fillFormByLabels(values) { ... }
function clickControlByLabel(label) { ... }
```

These helpers are secondary. They should not block the first PageSketch release.

Requirements:

- Helpers must be plain browser-side JavaScript.
- Helpers must expose visible causal structure.
- Helpers must return structured data.
- Helpers must not submit forms automatically unless explicitly called by model-authored code.

## Table/List Follow-Up

Borrow WebChallenger's table/list idea as a helper and prompt aid, not as runtime control flow.

Desired helper output:

```ts
{
  columns: string[];
  rows: Array<{
    index: number;
    values: Record<string, string>;
    actions: PageSketchControl[];
  }>;
  pagination?: PageSketchControl[];
  filters?: PageSketchControl[];
}
```

Use this for admin pages, search result pages, ecommerce listings, and benchmark tables. The model still decides how to act.

## Skill Promotion Follow-Up

When PageSketch is enabled and a run succeeds, skill proposal can use:

- stable selectors that worked,
- section types and labels,
- table/list extraction patterns,
- failed traps and successful pivots.

Example skill content:

```markdown
## Page Structure
- Search page has input `input[name="q"]`.
- Results list items use `.result-card`.
- Detail links are inside `.result-card a`.

## Workflow
1. Fill the search input.
2. Extract result cards.
3. Open the matching detail page.
```

This is Wire-native and should be preferred over persistent full-site `WebsiteMem`.

## Testing Plan

Unit tests:

- CLI parses `--page-sketch` for `run`.
- CLI parses `--page-sketch` for `bench`.
- `RunOptions.pageSketch` propagates into `RuntimeConfig`.
- `BrowserObserveInput.includePageSketch` defaults to false.
- Observation payload omits `pageSketch` when disabled.
- Observation payload includes sanitized `pageSketch` when enabled.
- Prompt assembly omits PageSketch when disabled.
- Prompt assembly includes compact PageSketch when enabled.
- Prompt assembly caps/truncates large sketches.
- Selector hint generation prefers stable selectors.
- Sketch generation excludes hidden elements.

Provider tests:

- Steel observe uses the existing light script by default.
- Steel observe uses the sketch script only when `includePageSketch` is true.
- Returned sketch is bounded by section/control/text limits.
- Screenshot behavior remains unchanged.

Runtime tests:

- Initial observation passes `includePageSketch` only when feature flag is enabled.
- Auto-observe after navigation preserves the flag.
- Explicit `observe` action preserves the flag.
- Recovery observation preserves the flag.
- Existing runtime tests pass unchanged without the flag.

Integration tests:

- `wire run --page-sketch --objective "..."` records PageSketch in observation events.
- `wire run --objective "..."` does not record PageSketch.
- `wire bench --page-sketch` produces separate comparable benchmark reports.

Evaluation:

- Compare default vs `--page-sketch` on the benchmark suite.
- Track task completion, partial success, steps, LLM tokens, exec failures, no-progress stalls, and runtime duration.
- Treat increased token cost as acceptable only if it reduces failed probes or improves completion.

## Rollout Plan

### Phase 1: Types and Flag

- Add optional types and schemas.
- Add CLI flag.
- Propagate through runtime config.
- No provider behavior yet.

Acceptance:

- Flag is parsed and visible in runtime config.
- No output or trace behavior changes without the flag.

### Phase 2: Provider Sketch

- Implement sketch generation in Steel observe path.
- Gate it behind `includePageSketch`.
- Persist in observation payload when present.

Acceptance:

- `wire run --page-sketch` trace contains bounded PageSketch.
- Default trace does not contain PageSketch.

### Phase 3: Prompt Context

- Summarize PageSketch into prompt context.
- Cap prompt-rendered sketch.
- Add prompt tests.

Acceptance:

- LLM receives useful section/control hints only when enabled.
- Existing prompt snapshots/tests remain unchanged for default mode.

### Phase 4: Table/List Helper

- Add `extractTableRows` helper.
- Add tests for regular tables, headerless tables, and action cells.

Acceptance:

- Model can use helper output as structured evidence.
- Helper does not perform actions by itself.

### Phase 5: Skill Proposal Enrichment

- Include PageSketch-derived structure in successful skill proposals.
- Keep skill promotion optional and existing policy-controlled.

Acceptance:

- Proposed skills mention stable selectors and workflows when useful.
- No skill writes occur when skill promotion is disabled.

### Phase 6: Evaluation and Default Decision

- Run A/B benchmarks.
- Review cost, reliability, and failure modes.
- Decide whether to keep as opt-in, expose per-run config, or graduate to selected task classes.

Graduation requires explicit approval. Until then, PageSketch remains opt-in only.

## Risks

- Token cost increases if sketches are too verbose.
- Bad selector hints may anchor the model to brittle paths.
- Page-authored prompt injection can enter via headings/text previews if not sanitized.
- Sketch generation may slow observation on very large DOMs.
- Too much structure could reduce the model's willingness to inspect directly.

Mitigations:

- Strict caps and truncation.
- Stable-selector preference.
- Existing redaction and prompt-injection stripping.
- Feature flag disabled by default.
- A/B benchmark reporting before any default change.

## Success Criteria

- Zero behavior change without `--page-sketch`.
- PageSketch trace appears only with explicit opt-in.
- Prompt includes compact, useful section/control hints when enabled.
- Benchmark runs show fewer no-progress execs or lower step count on page-navigation tasks.
- No increase in policy bypass risk or unreviewed destructive behavior.
- Implementation preserves Wire's layered architecture.
