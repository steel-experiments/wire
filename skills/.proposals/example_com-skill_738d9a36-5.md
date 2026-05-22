---
id: skill_738d9a36-583e-4a27-997d-cc0d478c7952
scope: domain
status: proposed
source: generated
confidence: 0.92
sourceRunIds:
  - run_1ce1139e-143c-473b-98a2-980db0126ca6
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-05-20
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_1ce1139e-143c-473b-98a2-980db0126ca6` with confidence 0.92.

## Workflow

1. Step 1: Navigate to https://example.com/.
2. Step 2: Verify document.title equals "Example Domain".
3. Step 3: Optionally confirm the page heading via document.querySelector('h1')?.innerText?.trim() equals "Example Domain".

## Facts

- The canonical page URL resolves to https://example.com/.
- The page title is "Example Domain".
- The main h1 text is "Example Domain".

## Selectors

- `h1`

## Routes

- `https://example.com/`

## Wait Patterns

- `After navigation, wait for the page load/navigation to complete before evaluating page state.`

## Known Traps

- Executing code that sets location.href and waits on the same execution context can fail with "Inspected target navigated or closed" because navigation destroys the context; navigate first, then run verification in a fresh evaluation context.
