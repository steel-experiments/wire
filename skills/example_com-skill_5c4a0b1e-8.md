---
id: skill_5c4a0b1e-8cde-4d7d-a9f1-3149af9aca92
scope: domain
source: generated
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-04-24T20:53:09.735Z
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_d07fdb6f-77b5-4632-b4a0-4d821f3cc9ac` with confidence 0.7.

## Facts

- Page title is 'Example Domain'
- Navigation to example.com succeeds
- Direct document.title access works after page load

## Routes

- `https://example.com/`

## Wait Patterns

- `2000ms delay needed after navigation before reliable DOM access`

## Known Traps

- Execution context destroyed if code runs during page transition - wait for navigation to complete before executing code
