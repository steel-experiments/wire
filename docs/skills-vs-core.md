# Skills vs. Core: Where Knowledge Lives

`AGENTS.md` asks one question of every new piece of knowledge or behavior:

- True for one site or task pattern? → **skill**
- True for many sites; expressible as a thin callable function? → **helper**
- True regardless of site or task; a property of how Wire itself works? → **core**

This page is the operational version of that question. It exists because the
tempting shortcut — appending "one more line" to the system prompt — is how a
small core quietly grows site lore and task-pattern lore that compounds forever.

## How a skill actually loads

Before reaching for a skill, know what triggers one, because the trigger
constrains what a skill can carry.

Each step, `syncMatchedSkills` (`src/agent/skill-context.ts`) computes two signals
and asks the matcher to score every skill against them:

1. **Hostname** — the current page's hostname, matched against a skill's
   `hostnamePatterns` (exact or single trailing wildcard, `matcher.ts`).
2. **Tags** — `deriveSkillTags(task)` splits the task title, objective, and
   success criteria into words (≥4 chars, capped at 12) plus the task mode.

`scoreSkills` (`src/skills/matcher.ts`) awards points for hostname matches
**and**, independently, for tag overlap. A skill with **no `hostnamePatterns`**
still loads if its `tags` overlap the derived tags — and because the objective
is known before the first navigation, a tag-matched skill is available **from
step 1**. There is no separate "task-pattern trigger" to build; tag matching
is it.

Two consequences fall out of this, and they decide most placement questions:

- **The trigger is objective words.** A skill can only fire on knowledge the
  user's wording will surface. "Search Google for X" derives the tag `search`;
  "Look up the cheapest laptop" derives neither `search` nor any reliable
  intent tag. Knowledge that must apply regardless of phrasing cannot live in a
  tag-matched skill without an intent classifier — and adding one re-creates
  the keyword-heuristic smell we work to keep out of core.
- **Skills cannot see action type.** Tags come from the objective, not from
  what the agent is about to do. Guidance like "for `data:` URLs, navigate with
  a raw `Page.navigate`" or "dismiss cookie modals first" is keyed on the
  *current action*, which no tag can express. That guidance is structurally
  core.

## Placement decision tree

```
Is it true for exactly one site (routes, selectors, traps)?
  └─ yes → DOMAIN SKILL (hostnamePatterns). Prefer auto-promotion from a run.

Is it a cross-site task pattern the user's wording reliably names
(e.g. "fill out the form", "export to CSV")?
  └─ yes, and a trigger word is dependable → WORKFLOW SKILL (tags, no hostname)
  └─ yes, but intent is under-worded (e.g. "search") → CORE. Coverage must be
       unconditional; do not trade it for prompt-weight savings.

Is it keyed on the action the agent is taking, not the objective
(data: URLs, cookie/modal dismissal, the wire.click contract)?
  └─ CORE. Tags cannot reach it.

Is it a property of Wire's own environment
(headless detection, captcha exposure, observation shape)?
  └─ CORE.

Is it a thin reusable function over many sites (extractTable, fillByLabel)?
  └─ HELPER, not prose.
```

## Worked examples

| Knowledge | Home | Why |
| --- | --- | --- |
| "On dashboard.stripe.com, invoices are at `/invoices`" | domain skill | One site. Auto-promotes from a successful run. |
| "To fill a form, label the inputs then submit" | workflow skill | Cross-site; `form`/`submit` is a dependable trigger word. |
| "Use DuckDuckGo/Bing; Google captchas our headless browser" | **core** | Search intent is badly under-worded, and the captcha exposure is a property of Wire's environment. Unconditional coverage matters more than the saved lines. |
| "For `data:` URLs, use a raw `Page.navigate`" | **core** | Keyed on action type; no objective tag can trigger it. |
| Auth-wall hostnames (`accounts.google.com`, `auth0.com`) | **core** | `detectAuthWall` (`src/profiles/auth.ts`) runs outside the skill loader; a skill doc cannot wire into it. |
| `extractTable(selector)` | helper | A thin callable function, not guidance. |

## The standing rule

The skill mechanism's job is to keep core from **growing**, not to relocate
prose that is already correctly unconditional. When in doubt, ask whether the
knowledge's trigger (a hostname, or a word the user will reliably say) is
dependable. If it is, it belongs in a skill. If coverage must hold regardless
of site or phrasing, it is core — and that is not a failure of discipline, it
is the boundary working.

See [Skills System](skills-system.md) for the file format, loading, matching,
and promotion details.
