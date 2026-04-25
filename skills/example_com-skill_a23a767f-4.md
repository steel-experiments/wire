---
id: skill_a23a767f-43ef-4a94-b93c-89010fb3d68f
scope: domain
source: generated
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-04-25
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_6db7fd78-4c03-461d-93f7-466cd106e995` with confidence 0.85.

## Facts

- The main heading (h1) on example.com contains the text 'Example Domain'
- example.com is a static informational page maintained by IANA

## Selectors

- `h1 — main page heading, text content is 'Example Domain'`

## Routes

- `https://example.com/ — landing page`

## Wait Patterns

- `Navigation via location.href destroys the execution context; always split navigation and subsequent DOM queries into separate code-exec steps rather than chaining them with setTimeout in the same block`

## Known Traps

- Setting location.href and then immediately querying the DOM in the same execution block causes 'Execution context was destroyed' error — navigate first, confirm the new observation, then query
