---
marp: true
theme: default
paginate: true
header: 'Wire — internal dev pitch'
footer: 'github.com/.../wire'
---

# Wire

How it works. How it compares.

---

## What Wire is

TypeScript runtime. Drives a real Chrome session via Steel. Takes one objective. Returns a classified outcome with a replayable trace.

```bash
wire run --objective "Verify example.com title"
wire bench --json
wire replay --run-id run_abc123
```

Not a framework. Not an SDK. A small runtime with explicit boundaries.

---

## The shape

Small surface. Boundaries are functions and types, not infrastructure.

| Metric | Current |
|---|---|
| Source LOC | ~15,000 |
| Source files | 66 |
| Tests | 630+ |
| Test-to-source ratio | ~1:1 LOC |
| Runtime deps | 1 (`zod`) |
| Dev deps | 3 |

---

## Module layout

```
agent/      loop, runtime, classify, planning, refine, branching
browser/    bridge, observe, exec, raw, helpers, session
policy/     engine, rules, approvals
skills/     loader, parser, matcher, promote, stats
trace/      replay
providers/  steel.ts (1135 LOC), llm/{openai,anthropic}
storage/    atomic file-backed JSON
shared/     types, ids, schemas, secrets, redact
cli/  eval/  ui/  experiments/  profiles/
```

Missing: DI container, plugin system, event bus, middleware, retry layer.

---

## Non-interleaving principle

Hickey's *simple*: concerns not braided together.

| Concern | Lives in | Does NOT touch |
|---|---|---|
| Browser lifecycle | `providers/browser/steel.ts` | Agent reasoning |
| Site knowledge | `skills/*.md` | Task narration |
| Action approval | `policy/engine.ts` | LLM prompt |
| Run history | `trace/`, `.wire/runs/` | Working memory |
| Identity (auth) | profile | Run state |

Consequence: no retry layer. Loop runs once, trace is honest, policy blocks redoing destructive work.

---

## The loop

```
1. Load task + matching skills      (skills/loader.ts)
2. Attach Steel session             (providers/browser/steel.ts)
3. Observe — URL/title/headings     (browser/observe.ts)
4. LLM proposes one action
5. Policy check                     (policy/engine.ts)
6. Execute, persist events
7. Auto-observe after navigation
8. Repeat until done / blocked / budget out
9. Classify the run                 (agent/classify.ts)
10. Propose a skill if reusable     (skills/promote.ts)
```

Implementation: `src/agent/loop.ts:225` — `executeStep()`. 856 LOC, one switch on action kind.

---

## The action set

Closed 5-verb contract. Most stacks ship 30–50 growing tools.

```ts
kind: 'observe' | 'edit-helper' | 'exec' | 'raw' | 'finish'
```

| Verb | Purpose |
|---|---|
| `observe` | URL, title, headings, counts, tabs, tab-drift warnings |
| `edit-helper` | Rewrite task-local helper source |
| `exec` | Run agent-written JS |
| `raw` | Direct CDP escape hatch |
| `finish` | Terminate, requires code evidence |

---

## Why observe ≠ read

> Observe answers *"did my action work?"* Exec answers *"what does the page say?"* — and the agent decides how much of the page is worth reading.

Observe returns URL, title, heading text, and counts. **Not page content.**

Returning DOM every step spends tokens on data the agent doesn't need. The agent writes the extraction it wants:

```js
Array.from(document.querySelectorAll('.athing')).slice(0,5).map(r => ({
  title: r.querySelector('.titleline a')?.textContent,
  score: r.nextSibling?.querySelector('.score')?.textContent
}))
```

No `click_by_label`, no `extract_table_by_xpath`. Agent writes code. We replay code. We blame code.

---

## Skills — what they are

Markdown files, one per host, with frontmatter.

```
skills/
  www_grants_gov-skill_8f8caa5f-0.md
  github_com-skill_01272fa1-f.md
  steel_dev-skill_f0fb9820-c.md
```

Frontmatter: `scope`, `hostnamePatterns`, `tags`, `source`, `confidence`.
Body: durable facts, stable selectors, routes, waits, traps — and a `## Workflow` section with replay-able steps.

Loaded by hostname/tag/scope on demand. Not stuffed into the prompt by default.

---

## Skills — what's in a workflow

The `## Workflow` section is the load-bearing part. Replay-able sequences, not notes.

```markdown
## Workflow
1. Fetch https://api.example.com/v2/search?q={query} when no auth
2. Parse response.data.items[] for id, title, price
3. Fall back to browser interaction when API returns empty
```

Generic facts go in other sections. The workflow is what the next agent runs.

---

## Skills — how they grow

1. Run completes → `llmProposeSkill()` distills facts + workflow from trace
2. Lands in `.proposals/` → secret-scanned, dedup'd
3. High-confidence or independently rediscovered → promoted to active
4. Future runs on that hostname auto-load
5. Effectiveness signals: was the skill correlated with shorter / cheaper / successful runs?
6. Refinement re-runs are policy-gated — destructive tasks don't re-run by default

Skills hold the map. Traces hold the diary. Separate by design.

---

## Policy is not a prompt

> The LLM proposes. The runtime decides. Safety isn't asked for — it's enforced.

**Most agents** put safety in the system prompt: *"don't submit, don't purchase, confirm before deleting."* The model honors that — sometimes.

**Wire** inspects the proposed code *before* it reaches the browser.

```ts
// policy/rules.ts
classifyExecRisk(code) → 'allow' | 'deny' | 'require-approval'
```

Require-approval defaults: submit, purchase, send, delete, account changes, outbound messages, privileged-profile use.

Deterministic. Pre-execution. Logged as `policy-check` events in the trace.

---

## Trace + artifacts

Every run writes to flat per-entity stores under `.wire/`:

```
.wire/
  runs/       run_<id>.json      # classification, outcome, result envelope
  events/     event_<id>.json    # one file per trace event
  artifacts/  artifact_<id>-<filename>.<ext>
  tasks/  sessions/  approvals/  benchmarks/
```

Agents can emit named artifacts directly from `exec`:

```js
return {
  artifacts: [{ filename: 'comparison.md', kind: 'markdown',
                mimeType: 'text/markdown', content: '...' }]
}
```

`ArtifactKind` is an open union — runtime persists, model picks the format.

---

## Run classification — 7 outcome kinds

| Kind | Meaning |
|---|---|
| `task-complete` | Success criteria met |
| `partial-success` | Some criteria met |
| `blocked-auth` | Login wall — needs human |
| `site-error` | Site failed, not agent |
| `agent-error` | Agent failed |
| `infra-error` | Network / Steel / provider |
| `ambiguous` | Insufficient evidence |

"Failed" is not a useful word. Classification is the shared contract.

---

## Completion contracts

A run isn't done because the agent says so — it's done when the trace satisfies the contract. Inferred from the task objective + success criteria.

```ts
TaskContract {
  mustVisit:      string[]    // domains / URLs
  mustMention:    string[]    // entities, keywords
  mustProduce:    { format, table, minItems }
  mustReach:      { contains-number | min-count }[]
  mustNotContain: string[]
}
```

Validation emits `contract-check` events → `{ passed, missing[], satisfied[], totalChecks }`. Drives the `contract` score dimension.

Placeholder phrases (`"see open"`, `"included in prior"`) flagged as fake completion — agents can't talk past the validator.

---

## Decomposed scoring + training export

Beyond the 7 categorical kinds, every run gets a decomposed score:

```
classification · contract · evidence · efficiency · policy
```

- `contract` — satisfied / total task-contract checks
- `evidence` — artifact + observation richness
- `efficiency` — step count vs ideal

Traces become training data via `wire export` in four formats:
`trajectory` · `sft` · `rewards` · `preferences`

```bash
wire export --format sft --min-score 0.8 --out data/sft.jsonl
```

**Wire does not train models** — it ships scored, redacted trajectories for SFT / RL.

---

## vs Claude Code + steel-browser skill (1/2)

Same browser. Different jobs.

| | Claude Code + skill | **Wire** |
|---|---|---|
| Shape | Interactive coding assistant | Deployable runtime |
| Operator | Human at terminal | Any process |
| Session | One conversation | One task, structured run |
| Output | Prose + tool calls | JSON classification + events |
| Fleet-able | No | Yes |
| Tool surface | ~30 general | 5 verbs |

---

## vs Claude Code + steel-browser skill (2/2)

| | Claude Code + skill | **Wire** |
|---|---|---|
| Skill lifecycle | You write them | Auto-proposed, dedup'd, promoted |
| Policy | Permission on tool calls | Deterministic check on *exec code* |
| Eval | Eyeballing | `wire bench --json` |
| Multi-run experiments | Manual, lost | `branching`, `ComparisonSpec` are types |
| Replay weeks later | Session-scoped | Persisted runs/events/artifacts |
| Training-data export | None | `wire export` (4 formats) |

> Claude Code is an agent you *use*. Wire is an agent you *deploy*.

Where Claude Code wins: general composition, interactive course-correction, one-offs.

---

## vs earendil-works/pi (`coding-agent`)

Cited in `SPECS.md:31`. We borrowed minimal-core ethos + file-based skill format.

| | pi coding-agent | **Wire** |
|---|---|---|
| Substrate | Local shell + FS | Steel cloud Chrome |
| Action model | Tool-call JSON | Code via `exec`, 5 verbs |
| Skills | **User-authored** | **Agent-authored + promoted** |
| Sessions | Tree-JSONL (`/fork`, `/clone`) | `events.jsonl` + classification |
| Policy | **None** — "run in a container" | Deterministic engine |
| Training export | None | `wire export` (4 formats) |
| Size | ~40k LOC, 142 files, 17 deps | ~15k LOC, 66 files, 1 dep |

---

## vs browser-use/browser-harness

Cited in `SPECS.md:31`. We borrowed code-as-action + agent-authored skills.

| | browser-harness | **Wire** |
|---|---|---|
| Substrate | Local Chrome via CDP (+ BU Cloud) | Steel cloud Chrome |
| Action model | **Python heredoc** | Typed TS `exec` |
| Helpers | Agent edits per task | Same, via `edit-helper` |
| Skills | Markdown, opt-in (`BH_DOMAIN_SKILLS=1`) | Loaded by hostname, promoted by run |
| Policy | Prompt-level only | Deterministic engine |
| Training export | None | `wire export` (4 formats) |
| Size | ~2k LOC, 4 deps | ~15k LOC, 1 dep |

---

## Bench surface

```bash
wire bench                              # default 5-task suite
wire bench --benchmarks custom.json
wire bench --provider openai --model X
wire bench --json                       # CI mode, exits 1 on regression
```

Persisted to `.wire/benchmarks/`. Diff across changes.

Five axes from `SPECS.md:23`: completion, learning, reliability, efficiency, safety.
Today we measure completion + reliability. The other three need work.

---

## The line

```
Make the browser real.
Make the core small.
Make actions inspectable.
Make failures useful.
Make lessons durable.
```

`MANIFESTO.md:87`. Every PR is reviewed against this.

---

## End to end — run and inspect

```bash
# 1. Run
wire run --objective "Open the pricing pages of vercel.com, netlify.com,
                      and railway.app. Extract everything and save as a
                      comparison table in markdown."
# → run_<id> created, Steel debug URL printed, trace streams live

# 2. Inspect — classification, artifacts, timeline
wire review --run-id run_<id>       # prints path of each emitted artifact

# 3. Open the artifact the agent emitted
cat .wire/artifacts/artifact_*-vercel-pricing-comparison.md

# 4. Replay the step-by-step trace
wire replay --run-id run_<id>
```

---

## End to end — learn, bench, export

```bash
# 5. Learn — what reusable knowledge did Wire propose?
ls skills/.proposals/               # vercel_com-skill_*, ...
cat skills/.proposals/vercel_com-skill_*.md

# 6. Lock it in as a regression
wire bench --benchmarks benchmarks/pricing.json --json --provider openai
                                    # exits 1 on future regression

# 7. Compare bench reports across changes
diff <(jq '.' .wire/benchmarks/bench-2026-05.json) \
     <(jq '.' .wire/benchmarks/bench-2026-06.json)

# 8. Export traces as training data
wire export --format sft --min-score 0.8 --out data/sft.jsonl
```

End.
