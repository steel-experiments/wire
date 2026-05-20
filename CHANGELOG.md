# Changelog

All notable changes to Wire are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased] — 0.1.0

### 2026-05-20

#### Added
- Scored trace exports for evaluation runs (`feat(eval)`).
- Artifact review retry gate that lets the agent re-check produced artifacts
  before completing (`feat(agent)`).
- Trace refs and explicit completion contracts on agent runs (`feat(agent)`).
- Model-defined artifacts: the agent can declare and persist its own artifacts
  (`feat(agent)`).
- Saved-artifact paths surfaced in run output (`feat(artifacts)`).
- Improved browser-run feedback in the agent loop (`feat(agent)`).

#### Changed
- Refreshed bundled `example.com` skill.
- Runtime and documentation refreshed across the repo.

#### Documentation
- Documented the policy engine.
- Documented the browser bridge.

### 2026-05-04 — 2026-05-07

#### Added
- Skills v2 RFC plus the `exec` helper layer and agent hardening
  (`feat(agent,skills,browser)`).
- User-message inbox and prompt surfacing so users can inject messages mid-run
  (`feat(agent)`).
- Pause / cancel / usage tracking on the runtime (`refactor`).

#### Fixed
- Six bootstrap fixes from the play2048 multi-run review
  (`fix(agent,policy,providers)`).

#### Changed
- Unified CDP-result filtering on `payload.source` (`refactor(agent)`).
- Removed dead runtime code.

#### Documentation
- Polished the Batch 2 improvements proposal (v0.2).

### 2026-04-30 — 2026-05-01

#### Added
- Cross-signature stall guard, `STALLED` metacognition state, and a
  cardinality-aware classifier (`feat(agent)`).
- Repeat-streak metacognition, expired-approval reaping, and search-as-read
  behavior (`feat(agent,cli,policy)`).
- Closed the skill lifecycle loop end-to-end (`feat(skills,agent)`).
- Live trace stream, stuck-loop guards, and smarter result derivation
  (`feat(agent,cli,skills,ui)`).
- Promoted the `www.grants.gov` skill from `.proposals` to active.

#### Fixed
- Skipped CDP nav-ack `{frameId, loaderId}` payloads when deriving final
  results (`fix(agent)`).
- Protected authored skills from auto-displacement and restored the curated
  `elgoog` skill (`fix(skills)`).

#### Changed
- Refreshed the `example.com` skill from stress-test runs (0.93 → 0.95).

### 2026-04-26 — 2026-04-27

#### Added
- Provider extension system for agent actions (`feat(agent)`).
- Session config flags, skill scoring, and managed skill promotion
  (`feat(cli,skills,browser)`).
- `wireActions` exposed from `exec`, a curated `elgoog` skill, and stronger
  game prompts (`feat(agent)`).

#### Fixed
- Prevented cookie-banner auth false positives and tightened navigation
  detection (`fix(agent)`).
- Prevented synthetic note artifacts from triggering false-positive
  task-complete (`fix(agent)`).
- Capped total failures, rejected nav-only outcomes as complete, and added a
  min-steps guard (`fix(agent)`).

#### Changed
- Refactor: orientation-only observations, unconditional auto-observe, and
  finish guards (`refactor(agent)`).

### 2026-04-25

#### Added
- Self-adapting agent with raw CDP, state diffing, multimodal input, and
  better classification (`feat(agent)`).
- Batch raw CDP, full skill guidance, resilient error handling, and
  error-aware skills (`feat(agent)`).
- OpenAI provider upgraded to the Responses API (`feat(llm)`).
- Steel debug URL surfaced in `wire run` output (`feat(cli)`).
- Agent-native CLI (`feat(cli)`).
- Benchmark reports persisted under `.wire/benchmarks/` (`feat(bench)`).
- Simplified core runtime flow and added bench tooling (`feat(core)`).

#### Fixed
- Made the agent resilient, adaptive, and able to learn across runs
  (`fix(agent)`).
- Routed raw CDP `Input.*` commands to the page-target session
  (`fix(browser)`).
- Auto-allowed safe CDP input methods in raw actions (`fix(policy)`).
- Printed the debug URL immediately on session creation (`fix(cli)`).
- Hardened CDP handling and task-file errors (`fix(cli,steel)`).

#### Documentation
- Added the `bench` command to the README and updated the test count.

### 2026-04-24 — Initial implementation

#### Added
- Bootstrapped the zero-weight workspace skeleton (`build(workspace)`).
- Core contracts and boundary validators in `shared` (`feat(shared)`).
- Initial full Wire agent system across all modules (`feat`).
- LLM-driven skill proposals replacing static promotion heuristics
  (`feat(skills)`).
- Project governance files (`chore(repo)`).

#### Fixed
- Real-answer extraction so runs stop hallucinating completion (`fix(agent)`).
- Review findings across security, structure, and DX (`fix`).
- Classification recovery for mixed-result runs and multi-object LLM parsing
  (`fix(agent)`).
- Default `skillDir` and skill-proposal debug logging (`fix(skills)`).
- Sandboxed browser exec, secured API keys, added classify tests, and
  decomposed the runtime (`fix`).
- Reverted WebSocket Bearer auth — Steel API requires the URL query param
  (`fix(steel)`).
- Steel session retry and objective-aware classification (`fix`).
- Completed planning test coverage, added skill dedup, and fixed `updatedAt`
  format (`fix`).

#### Documentation
- Updated assessment with shipped changes and added Mermaid diagrams.

[Unreleased]: https://github.com/nkkko/wire/commits/main
