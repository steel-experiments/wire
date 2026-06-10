# Wire Project Retrospective: 42 Days of Building a Browser Agent

**Period:** April 24 → June 4, 2026 (42 days)
**Data analyzed:** 119 Claude Code sessions (65MB JSONL), 7 Codex sessions, 98 git commits
**Project state:** 17,264 LOC src / 17,788 LOC tests / 92 source files / 1 runtime dep (zod)

---

## 1. The Arc: How Wire Was Built

### Phase 1: Inception (April 24–25)

The repo bootstrapped from nothing in a single day: core contracts, boundary validators, and the full agent system across all modules. By April 25, Wire already had a working agent loop, browser bridge, policy engine, skills system, CLI, benchmark runner, and evaluation harness. ~50 commits in 48 hours. This was Codex-era work — GPT-5 building the initial skeleton.

### Phase 2: Hardening & Dogfooding (May 6–8)

Two massive sessions defined the project's character:

- **The 2048 autopsy (May 8):** Four agents ran "play 2048" — all four scored 0. Root causes: prompt told the model to ignore screenshots, skill loading was broken, policy false-positives blocked gameplay, exec errors had no stack traces. Six fixes shipped in one commit (9cc0967). This established the pattern: real task → failure → diagnosis → fix → re-validate.
- **Skills v2 RFC (May 6):** Born from reading the Browserbase Autobrowse article. Five milestones shipped in one session: workflow generation, method preference, comparison artifacts, policy-gated refinement, skill effectiveness signals. LOC hit the cap (12,492/12,500), bumped to 13,000.
- **Streaming console (May 6):** The agent loop ran completely silent between start and finish. Built the entire `src/ui/` system: ANSI colors, step counter, three verbosity levels, glyphs.

### Phase 3: Steel Integration & Documentation (May 20–21)

- Documentation-as-code: 13 docs files (~2,000 lines), docsify + GitHub Pages
- CHANGELOG.md from git history
- Presentation deck (Marp format, 27 slides, 75+ edits)
- Steel dev API support (`STEEL_BASE_URL` env var, retry-on-404)
- Storage hint system for run data

### Phase 4: Benchmarking & Cross-Agent Comparison (June 2)

91 sessions in one day — the largest burst of activity. A 4-arm comparison harness was built:

- wire vs cc-skill vs cc-wire-cli vs cc-bare
- 6 tasks × multiple runs, blind shared judge
- **Discovered:** Wire was scoring 0% not because it was bad, but because the harness wasn't loading `.env` keys for subprocesses. The measuring stick was broken, not the agent.
- **Key finding:** HN extraction flakiness traced to auto-promoted skill with prose waits instead of executable `waitForSelector` calls.

### Phase 5: Live Testing & Adversarial Verification (June 3–4)

The most technically consequential period:

- 18 live runs (6 tasks × 3 reps), Steel cloud browsers, GPT-5.4
- 3-skeptic adversarial verification with majority-vote verdicts
- 7 confirmed bugs found, ranked, and partially fixed
- The analysis layer itself hallucinated twice — the most dangerous was a synthesis agent fabricating an entire vote table from empty input
- **Meta-lesson:** "single-pass agent analysis of a trace is not trustworthy for high-stakes claims; verify or compute"

### Phase 6: Architecture Refactoring (June 4)

Three large refactor commits decomposed the monolith:

- `runtime.ts` (~1800 lines) → 10 focused modules
- `steel.ts` → 7 focused modules
- Architecture boundary enforcement script added
- Progress ledger replaced heuristic-heavy `classify.ts`

---

## 2. What We Learned

### About the Product

| Lesson | Evidence |
|--------|----------|
| Code-first actions beat screenshot-only | The 2048 autopsy proved it: the model saw the tutorial overlay in screenshots but chose DOM queries because the prompt devalued visual interpretation |
| Never trust self-assessment | The classifier scored error strings as 0.55–0.9 "partial-success"; the judge was the honest broker |
| Skills must be validated, not just proposed | Auto-promoted at 0.93 confidence, the HN skill was brittle — prose waits instead of executable code |
| The reconfigure reflex was the #1 killer | `about:blank` misread as anti-bot → reflexive proxy/captcha reconfigure on 13/18 runs, fatal on SEC EDGAR |
| Watch/loop tasks are a different species | 2048 gameplay exposed stuck-loop guards designed for convergence, not monitoring. Same action ≠ stuck when score is climbing |
| Evidence should be permanent, not inferred | `deriveRunResult` leaked nav-acks and evidence blobs as answers. The explicit answer channel (finish with payload) is the fix |
| The measuring stick must be trustworthy | The comparison harness silently scored Wire 0% due to missing env keys. Every eval tool needs its own validation |

### About Working With AI Agents

| Lesson | Evidence |
|--------|----------|
| Agents hallucinate in analysis, not just generation | Two hallucinations in the adversarial verification pipeline: fabricated HN claim, confabulated vote table |
| Compute verdicts in scripts, not agents | The synthesis agent invented results when given empty input. Scripts don't hallucinate. |
| Single-pass analysis is unreliable | The first analyst claimed HN rep1 was fabricated; 3-skeptic verification proved it was genuine. One perspective isn't enough. |
| The agent's own confidence is not evidence | Skills auto-promoted at 0.93 confidence while being broken. The classifier scored failures as partial-success. External validation is essential. |
| Context switching works | The presentation session (12MB, 1121 lines) interleaved slide editing with feature implementation — helpers, scoring, contracts — all while updating slides to reflect new capabilities |

---

## 3. How We Worked: Patterns & Rhythms

### Session Taxonomy

| Type | Count | Avg Size | Example |
|------|-------|----------|---------|
| One-liner tasks ("list dependencies", "why this err") | ~15 | 15–30KB | Quick diagnosis, single-turn |
| Run autopsies ("review this run") | ~12 | 300–970KB | Paste terminal output → root cause → fix |
| Benchmark judge sessions | ~40 | 15–30KB | Mechanical scoring, formulaic |
| Feature sprints | ~8 | 1–6MB | Multi-hour, multi-turn, interleaved work |
| Documentation/content | ~6 | 200KB–12MB | Heavy iteration, editorial feedback |
| Infrastructure/ops ("commit all and push") | ~5 | 300KB | Review, verify, ship |

### The Core Loop

The dominant work pattern was:

> **Real task → Failure → Paste output → Root cause analysis → Fix → Re-validate**

This happened 12 times across the project's history. Every significant fix was motivated by a real browser run failing, not by unit test failures. The test suite (17,788 LOC) was the safety net; the live runs were the compass.

### Decision Velocity

Niko's interaction style is extremely high-velocity:

- Average first-user-message length: 30–50 words for dev sessions
- Go/no-go decisions: typically 2–5 words ("do it", "merge", "commit all and push")
- Editorial feedback: specific and surgical ("this reads cooky", "remove this slide", "be more humble")

This works because Claude provides enough context for informed decisions — root cause, fix options, risk assessment — and Niko makes the call instantly.

### The Codex Sessions Were a Dead End

The 7 Codex sessions (May 17–19, 2025) were all on the agrama project, not Wire. Two hit OpenAI API quota limits. The remaining Codex sessions from the `~/.codex/archived_sessions/` were for mistral, steel-warehouse, and loam — also not Wire. **Wire was built entirely with Claude Code.**

---

## 4. How to Be Smarter: Recommendations

### 1. Stop Rebuilding the Measuring Stick

We built three separate eval tools across the project:

- `wire bench` (basic scoring)
- The 4-arm comparison harness (`benchmarks/compare/`)
- The adversarial verification workflow

Each was built from scratch. Consolidate into one eval infrastructure that supports: single-task scoring, cross-agent comparison, and adversarial verification. The reliability plan (`WIRE_RELIABILITY_PLAN.md`) outlines phases 0–5 — phase 0 (lock baseline) should be automated, not rebuilt each time.

### 2. Ship the Reliability Plan

The 5-phase plan was written on June 2 and none of its phases have been executed as planned. Instead, fixes have been reactive (found during live runs). The plan is sound:

1. Explicit answer channel → stop inferring from last code-result
2. Contract-steering → block finish when contract is unmet
3. Wait-before-extract → structural, not prompt advice
4. Executable waits in skills → `await waitForSelector()` not prose
5. Validate-before-promote → re-run the skill's objective before activating

Execute the plan in order. Each phase has clear done-when criteria and regression gates.

### 3. Standardize the Run Autopsy

12 sessions were "paste terminal output → diagnose → fix." This is effective but ad-hoc. Create a `wire autopsy <run-id>` command that:

- Extracts the trace, screenshots, and classification
- Runs the same structural checks we do manually (query-echo? page-dump? nav-ack? reconfigure-triggered?)
- Produces a structured report with severity rankings

This turns a 45-minute manual session into a 30-second command.

### 4. Protect Against Agent Self-Deception

Three systemic problems recurred:

- **Classifier optimism:** scored errors as partial-success
- **Skill promotion without validation:** confidence 0.93 ≠ works
- **Analysis hallucination:** fabricated claims in verification pipeline

Structural fixes already partially in place:

- Adversarial verification (3-skeptic majority vote)
- Script-computed verdicts (agents don't author conclusions)
- Reconfigure gate (positive evidence required)

Still missing: classifier-vs-judge agreement metric, skill promotion validation run, and a provenance gate on results (answer must trace to in-window code-result).

### 5. Session Management

The 119 sessions consumed 65MB. The largest single session was 12MB (presentation + feature sprint). Several sessions ran out of context and were compacted. Recommendations:

- **Split mega-sessions earlier.** The 12MB presentation session should have been 3 sessions: features, slides, comparison research.
- **Use the memory system more.** Only 4 memory files exist. Each session that discovered a bug or made a decision should have written a memory entry.
- **Tag session types.** The `ai-title` field was null for every session. Even auto-generated titles would help with future retrospectives like this one.

### 6. The Article Was a Detour — But a Productive One

The June 3 article arc consumed 3 sessions (~11MB total) and ended with the article deleted entirely. But it produced:

- PR #3 (experiment branch divergence, critical-point review by default)
- Two architectural proposals (session-agent, extension-agent)
- The dynamic workflows conceptual mapping
- Editorial voice calibration that informed all subsequent sessions

**Lesson:** creative/exploratory sessions that produce code changes are worth the token cost. Sessions that only produce content that gets deleted are still valuable if they shaped thinking.

### 7. For the Autonomous Loop Vision

The vision: "give an AI agent a real setup and let it experiment autonomously overnight." Based on 42 days of Wire development:

**What's already proven:**

- Wire can run 18 parallel live tasks against real websites
- The adversarial verification pipeline catches agent self-deception
- Skills auto-promote from successful runs
- The comparison harness measures agent quality objectively

**What's missing for autonomous operation:**

- **Convergence detection:** the reliability plan's phase 1–2 (explicit answer channel, contract-steering) are prerequisites
- **Skill validation gate:** don't promote without re-running
- **Budget/rate-limit awareness:** autonomous loops will hit Steel API limits
- **Experiment branching:** PR #3 added `branchDirective` but there's no merge/compare infrastructure
- **Self-repair loop:** detect regression → bisect → revert → re-validate

The `WIRE_RELIABILITY_PLAN.md` is literally the roadmap from "agent that works sometimes" to "agent that can run unattended." Execute it.

---

## 5. The Numbers

| Metric | Value |
|--------|-------|
| Project duration | 42 days |
| Git commits | 98 |
| `feat()` commits | 34 |
| `fix()` commits | 31 |
| `refactor()` commits | 6 |
| Source LOC (final) | 17,264 |
| Test LOC (final) | 17,788 |
| Source files | 92 |
| Runtime dependencies | 1 (zod) |
| Dev dependencies | 3 |
| Claude sessions | 119 |
| Session data | 65MB |
| Codex sessions (Wire-relevant) | 0 |
| Sessions > 1MB | 11 |
| Average files changed per commit | 13.6 |
| Total tests (at last check) | 806+ |
| Test-to-code ratio | 1.03:1 |
| Live benchmark pass rate (verified) | 15/18 (83%) |
| Unique bugs found via live testing | 7 confirmed |
| Skills auto-promoted | 3+ |
| Illustrations created then deleted | 3 |

---

## 6. One-Line Takeaways

1. **The manifesto was right.** "Evidence as the product" — every major fix came from inspecting real traces, not from theory.
2. **Real tasks > synthetic tests.** The 2048 autopsy, the pricing comparison, the Amazon jeans task — real websites found bugs that 800 unit tests missed.
3. **The agent lies to itself.** Classifier optimism, skill overconfidence, analysis hallucination — structural safeguards (adversarial verification, script-computed verdicts) are not optional.
4. **Speed of iteration is the competitive advantage.** 98 commits in 42 days. Fix → validate → ship in hours, not days.
5. **The measuring stick is part of the product.** Wire doesn't just run tasks — it judges its own work. Making that judgment trustworthy is half the engineering.

---

*Generated June 4, 2026. 42 days from an empty repo to a 17k-LOC browser agent that completes real web tasks at 83% verified accuracy, with adversarial verification, skill learning, and a clear roadmap for autonomous operation.*
