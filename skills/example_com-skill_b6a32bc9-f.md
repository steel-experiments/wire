---
id: skill_b6a32bc9-fea0-47e6-9b9c-316667d76259
scope: domain
status: active
source: generated
confidence: 0.95
sourceRunIds:
  - run_d7bc1919-107d-4d3c-af6b-f9103ed6ac1f
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-05-01
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_d7bc1919-107d-4d3c-af6b-f9103ed6ac1f` with confidence 0.95.

## Facts

- The homepage title is 'Example Domain'.
- The main heading text on the homepage is 'Example Domain'.

## Selectors

- `h1`

## Routes

- `https://example.com/`

## Wait Patterns

- `After setting location.href, wait for navigation/load to complete before querying the DOM.`

## Known Traps

- Executing a script that both sets location.href and waits for the new page's load in the same execution can fail with 'Execution context was destroyed'. Query the DOM in a separate step after navigation completes.
