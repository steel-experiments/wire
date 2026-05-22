---
id: skill_a3610631-4c71-449c-b43f-ffac607b4c54
scope: domain
status: proposed
source: generated
confidence: 0.93
sourceRunIds:
  - run_4cc888f6-3a20-48c6-a366-1603b6ae4f39
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-05-20
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_4cc888f6-3a20-48c6-a366-1603b6ae4f39` with confidence 0.93.

## Workflow

1. Step 1: Navigate directly to https://example.com.
2. Step 2: After navigation completes, read document.title with a separate script execution.

## Facts

- The page title at https://example.com/ is 'Example Domain'.

## Routes

- `https://example.com/`

## Wait Patterns

- `Wait for navigation/load to finish before querying document.title.`

## Known Traps

- Do not combine setting location.href and awaiting a load event in the same script execution; the execution context can be destroyed with error 'Inspected target navigated or closed'.
