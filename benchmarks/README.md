# wire benchmarks

Canonical task corpus for testing wire's browser infrastructure and agent. Each task is curated to be **human pass@1** and **agent pass@16** — doable, not aspirational.

## Files

| file | purpose |
|---|---|
| `schema.ts` | Zod source-of-truth for the task schema. |
| `emit-schema.ts` | Regenerates `benchmark_tasks.schema.json` from `schema.ts`. Run with `pnpm emit-schema` (or `bun run benchmarks/emit-schema.ts`). |
| `benchmark_tasks.schema.json` | Auto-emitted Draft 2020-12 JSON Schema (do not hand-edit). |
| `benchmark_tasks.json` | The 210-task corpus. Validated against the schema. |
| `default.json` | 7-task smoke/regression set run by `wire bench`. A case may carry an optional `sessionConfig` (proxy/stealth/captcha/userAgent) so anti-bot and fair-access sites measure capability, not default-config blocking. |
| `demo_tasks.json` | 80 sales-recording demo prompts. **Not** a graded benchmark; different shape. A curated, depersonalized subset of these is included in `benchmark_tasks.json` under `source.name = "wire-demo"`. |

## Running the default suite (`wire bench`)

```bash
wire bench                          # run benchmarks/default.json, print a report
wire bench --min-pass-rate 0.6      # exit non-zero only if pass rate < 0.6 (CI gate)
wire bench --benchmarks <path>      # run a different suite file
```

Reports persist to `~/.wire/state/benchmarks/`.

### Baseline (2026-06-02)

Locked at **5/7** typical, **6/7** when SEC EDGAR's fair-access request succeeds. A
task passes if its classification matches the expected one with full keyword
relevance, **or** the LLM judge scores it ≥ 0.8.

| task | status | notes |
|---|---|---|
| example-title | ✅ stable | |
| wire-click-trusted-event | ✅ stable | trusted-input click |
| booking-search | ✅ stable | needs `sessionConfig` stealth+proxy+captcha |
| lesswrong-posts | ✅ stable | |
| httpbin-headers | ✅ stable | |
| sec-edgar-filing | ⚠️ flaky | declared `userAgent`; SEC still rate-limits intermittently |
| elgoog-2048 | ❌ hard | iframe game; not yet reliably solved |

### Gating

The default `wire bench` gate is strict (all tasks must pass) — not suitable for CI
given the flaky/hard tail. Use `--min-pass-rate` for a variance-tolerant gate.
**Recommended CI floor: `--min-pass-rate 0.6`** — tolerates the sec-edgar flake and
the elgoog miss, but catches any regression that drops a stable task (→ 4/7 = 0.57).

A single run is noisy (live sites + LLM nondeterminism); for a trustworthy number,
run 2–3× and take the mode, or raise the floor only after stabilizing the tail.

## Task shape

```jsonc
{
  "id": "sec-edgar-apple-10k",        // stable slug
  "prompt": "Navigate to ... return the most recent filing date and form type.",
  "source": {
    "name": "wire-default",            // wire-original|wire-default|wire-demo|webvoyager|mind2web|gaia|...
    "task_id": "sec-edgar-filing",     // upstream id (when applicable)
    "license": "CC-BY-NC-4.0",         // upstream license (when applicable)
    "modified": true,                  // true if we tweaked the prompt or graders
    "notes": "wire reformulation"      // free-form provenance note
  },

  "vertical": "financial-services",    // GTM slicing dimension
  "tier": "session",                   // scrape | session | research | agent
  "capabilities": ["navigate", "extract-table"],
  "infra": ["none"],                   // proxy | profile | credentials | captcha | stealth | recording
  "tags": ["gov", "table"],
  "entry_url": "https://...",
  "auth": { "type": "credentials", "key": "github-bench" },  // optional

  "difficulty": 2,                     // 1-5 (agent difficulty; human pass@1 by curation)
  "max_steps": 8,

  "graders": [                         // implicit AND across the array
    { "type": "regex", "pattern": "\\b\\d{4}-\\d{2}-\\d{2}\\b" },
    { "type": "llm-judge",
      "rubric": "Answer cites a real 10-K filing date for Apple in YYYY-MM-DD form.",
      "must_have": ["10-K"] }
  ],

  "dynamic_content": "low",            // low | medium | high — informs grader strictness
  "last_verified": "2026-05-04",
  "disabled": null                     // or { reason, since } to skip a flaky task
}
```

## Grader types

- `contains` — substring match against final answer
- `regex` — pattern match
- `json-schema` — structural validation of a structured answer
- `url-match` — regex against the final URL
- `llm-judge` — rubric evaluated by `gpt-5.4-mini` (default; per-task overridable)

Multiple graders compose with AND. For OR semantics, write a single `llm-judge` whose rubric encodes the disjunction.

## Source attribution

Tasks are tagged by provenance:

| source | count | notes |
|---|---|---|
| `wire-default` | 6 | Direct port from `default.json`. |
| `wire-demo` | 10 | Depersonalized from `demo_tasks.json`. |
| `wire-original` | 100 | Authored fresh for this corpus. |
| `webvoyager` | 40 | wire reformulations; sites & style match the WebVoyager corpus. License: research-only. |
| `mind2web` | 24 | wire reformulations. License: CC-BY-NC-4.0. |
| `gaia` | 10 | wire-style multi-hop retrieval & synthesis. License: Apache-2.0. |
| `assistantbench` | 10 | wire-style aggregation tasks. License: MIT. |
| `browsecomp` | 10 | wire-style trivia / multi-hop. License: research-only. |

For license-encumbered sources (CC-BY-NC, research-only), prompts are reformulated rather than copied verbatim. `modified: true` and `notes` capture this. Always set `modified: true` if you tweak a copied prompt or grader.

## Credentials & profiles

Schema stores only an abstract `key`. The resolver (`src/shared/secrets.ts`) walks providers in declared order:

1. **env / `.env`** — `WIRE_SECRET_<KEY>_USERNAME`, `_PASSWORD`, `_TOTP_SECRET`
2. **`pass`** — `pass show wire/<key>/username` etc. (gpg-encrypted, unix default)
3. **macOS Keychain** — `security find-generic-password -s wire-<key> -a username -w`
4. **1Password CLI (`op`)** — `op read "op://Wire/<key>/username"`

Order configurable: `WIRE_SECRETS_PROVIDER=env,pass,keychain,op` (default).

Profile-typed auth (e.g. `{ "type": "profile", "key": "reddit-bench" }`) resolves to a Steel browser-profile id via the same chain (`WIRE_PROFILE_<KEY>` etc.).

Every auth-required task references a `*-bench` test account — never a personal one. Never commit real credentials; the `key` is opaque.

## Side-effect tasks

Tasks tagged `side-effect` mutate real accounts (star, follow, post, clap, create issue). They live behind the `wire-bench-*` test accounts and can be filtered out for CI gating:

```bash
jq '[.tasks[] | select(.tags | index("side-effect") | not)]' benchmark_tasks.json
```

## Distribution

| dimension | breakdown |
|---|---|
| **tier** | session 112, scrape 50, research 32, agent 16 |
| **difficulty** | 1: 28 / 2: 66 / 3: 62 / 4: 39 / 5: 15 |
| **infra** | none 138, stealth 57, credentials 8, profile 7, captcha 3, proxy 3 |
| **dynamic_content** | low 86, medium 48, high 76 |
| **auth-required** | 15 |
| **side-effect** | 8 |

## Adding a task

1. Pick a stable `id` (lowercase, hyphenated, never reused).
2. Set `source` honestly. If derived from an upstream benchmark, mark `modified` and add `notes`.
3. Curation contract: confirm a competent human can complete it pass@1. If not, don't add it.
4. Set `difficulty` and `max_steps` against the agent's expected ceiling.
5. Prefer at least one cheap grader (`contains` / `regex`) before the `llm-judge` to short-circuit obvious failures.
6. Set `dynamic_content` honestly — it informs how strict graders should be.
7. Update `last_verified` whenever you re-confirm the task works on a real run.

## Validating

```bash
jq '.tasks | length' benchmark_tasks.json                      # should be >= 200
jq '[.tasks[].id] | length == (unique | length)' benchmark_tasks.json   # true
ajv validate -s benchmark_tasks.schema.json -d benchmark_tasks.json     # if ajv-cli installed
```
