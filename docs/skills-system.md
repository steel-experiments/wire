# Skills System

Skills store durable site knowledge in markdown files. They let Wire accumulate reusable knowledge across runs without growing the core.

## Skill format

A skill is a markdown file with YAML frontmatter:

```markdown
---
id: skill_stripe-dashboard
scope: domain
hostnamePatterns:
  - "dashboard.stripe.com"
tags:
  - billing
  - invoices
updatedAt: 2026-04-24
source: team
---

# Stripe Dashboard

## Durable Facts
- Invoices can be reached directly from /invoices
- CSV export triggers a background download event

## Stable Selectors
- Invoice table: table.invoices-list
- Export button: button[data-action="export"]

## Traps
- Pagination requires scroll-to-bottom before "Load More" appears
- Export dropdown closes on any outside click
```

### Frontmatter fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | `skill_*` string | yes | Unique skill identifier validated by the shared ID schema (`skill_` plus lowercase letters, numbers, or hyphens) |
| `scope` | `domain`, `workflow`, `interaction` | yes | Skill type |
| `hostnamePatterns` | string[] | no | URL hostnames this skill applies to |
| `tags` | string[] | yes | Tags for matching against task objectives |
| `updatedAt` | string (date) | yes | Last update date |
| `source` | `builtin`, `team`, `generated` | yes | Who created this skill |
| `title` | string | no | Human-readable title |
| `status` | `proposed`, `active`, `superseded`, `rejected` | no | Skill lifecycle status |
| `confidence` | number | no | Confidence score from prior runs |
| `sourceRunIds` | RunId[] | no | Runs that contributed to this skill |
| `supersedes` | SkillId[] | no | Skills replaced by this one |

### Skill scopes

- **domain** — knowledge about one site/app (URL patterns, selectors, traps)
- **workflow** — knowledge about a repeated business workflow across apps (invoice retrieval, CRM record creation)
- **interaction** — reusable browser/UI mechanics (uploads, dialogs, shadow DOM, cross-origin frames)

### Sections

Skills use `## Section Name` headings to organize content. The runtime prioritizes these sections when building guidance for the LLM:

1. **Known Traps** / **Traps**
2. **Workflow**
3. **Wait Patterns**
4. **Facts**
5. **Routes**
6. **Selectors**

Section content is capped at 1KB total per skill (with per-section budgets of 400/300/200 chars) to stay within the LLM context budget.

## What belongs in a skill

**Yes:**
- URL patterns and direct routes
- Stable CSS selectors
- Known waits with reasons
- API endpoint notes
- Traps and failure modes
- DOM quirks (iframes, shadow DOM)
- Export/upload shortcuts

**No:**
- Secrets, tokens, cookies
- Run transcripts or chain-of-thought
- Step-by-step narration of a specific run
- One-off pixel coordinates
- Temporal context ("recently changed", "new feature")

## Skill loading

Skills are loaded by `src/skills/loader.ts` using a multi-signal matching strategy:

1. **Hostname matching** — skills whose `hostnamePatterns` match the current page URL
2. **Tag matching** — skills whose `tags` overlap with keywords extracted from the task title, objective, and success criteria
3. **Scoring** — each match gets a score based on the number and type of matching signals

Skills are synced:
- At run initialization
- After every step execution (when the page URL may have changed)
- After anti-bot recovery (when a new session is created)

A `skill-load` trace event is emitted whenever the matched skill set changes. A `skill-empty` event fires once if the configured skill directory contains no loadable files.

## Skill directory resolution

Skills are loaded from a directory resolved in priority order:

1. `--skill-dir` CLI flag
2. `$WIRE_SKILLS` environment variable
3. `~/.wire/skills` (default)

## Skill parsing

`src/skills/parser.ts` handles frontmatter extraction:

1. Split the file at `---` delimiters
2. Parse the YAML-like frontmatter (flat scalars and lists only)
3. Validate against the `skillFrontmatterSchema` Zod schema
4. Extract `## Section` headings and their content

The YAML parser supports: strings, numbers, booleans, dates, and flat lists. No nested objects, no quotes, no multiline strings.

## Skill promotion

After a run completes, Wire can propose new skills via `src/skills/promote.ts`:

1. The LLM analyzes trace events to identify reusable knowledge
2. If knowledge is detected, it generates a skill proposal (markdown with frontmatter)
3. The proposal is written to the skill directory
4. If the proposal has enough reusable signal and confidence, it may be promoted to an active skill
5. Generated skills can replace lower-confidence generated skills for the same hostname, but never replace `team` or `builtin` skills

Promotion criteria:
- Knowledge must be **durable** (not one-off)
- Knowledge must be **reusable** (not task-specific)
- Knowledge must be **non-secret** (no tokens, cookies)
- Knowledge must be **narrow** (not a full product workflow)
- Knowledge must not be **narration** (not a run diary)

## Skill statistics

`src/skills/stats.ts` tracks usage statistics per skill:
- Which runs used each skill
- Whether those runs succeeded or failed
- Running confidence score

This helps future matching prioritize skills that have contributed to successful runs.

## Skill examples

The repository does not ship a root `skills/` directory. Use the frontmatter example above as the canonical shape, or point Wire at your own directory with `--skill-dir` or `$WIRE_SKILLS`.

Generated proposals are written under `.proposals/` inside the configured skill directory. Promoted active skills are written directly into that directory.

## Trust boundary: skill text is data, not instructions

Skill guidance is distilled from observed page content, so a hostile page can
plant imperative text that later re-enters prompts as a Fact or Trap. The
prompt-side filters (`shared/sanitize.ts` — injection-line stripping, system-tag
removal, length caps) are hygiene, not a security boundary: any denylist over
free text is bypassable. The load-bearing defense is the policy engine — the
action kind the policy evaluates is system-derived and cannot be relabeled by
model output, and privileged kinds gate on approval regardless of what any
skill says. Treat skill bodies accordingly when reviewing proposals: a skill
can mislead the planner into wasted steps, but it cannot grant itself a
privileged action.
