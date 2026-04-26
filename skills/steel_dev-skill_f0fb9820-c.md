---
id: skill_f0fb9820-cea7-4be6-a4d6-5a7c9fcdd0da
scope: domain
status: active
source: generated
confidence: 0.95
sourceRunIds:
  - run_14edeca4-33a7-414a-bdf9-bc95a1bde422
tags:
  - auto-promoted
  - steel.dev
updatedAt: 2026-04-26
hostnamePatterns:
  - "steel.dev"
---

# Skill Proposal: steel.dev

Auto-generated from run `run_14edeca4-33a7-414a-bdf9-bc95a1bde422` with confidence 0.95.

## Facts

- Homepage title verified as 'Steel | Open-source Headless Browser API'.
- Site is reachable directly at https://steel.dev/ and loads the expected title after navigation from about:blank.

## Routes

- `https://steel.dev/`

## Wait Patterns

- `After setting window.location.href, confirm the page title once navigation completes.`

## Known Traps

- Starting from about:blank requires an explicit navigation to https://steel.dev/ before verifying the title.
