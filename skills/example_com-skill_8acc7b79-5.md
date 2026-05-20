---
id: skill_8acc7b79-58a7-47ce-8e16-eef1577fa603
scope: domain
status: active
source: generated
confidence: 0.94
sourceRunIds:
  - run_e43bd40e-25bb-4c1f-ae09-bb9f3a265da0
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-05-20
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_e43bd40e-25bb-4c1f-ae09-bb9f3a265da0` with confidence 0.94.

## Workflow

1. Step 1: Navigate to https://example.com and wait for the page load to complete before running extraction code.
2. Step 2: On the loaded page, read document.title and document.querySelector('h1')?.innerText?.trim() || ''.
3. Step 3: Build the markdown table artifact from the extracted title and h1 values.

## Facts

- On https://example.com/, both document.title and the main h1 are 'Example Domain'.
- A markdown artifact was successfully created with filename 'example-summary.md'.

## Selectors

- `document.querySelector('h1')`

## Routes

- `https://example.com/`

## Wait Patterns

- `Wait for navigation/load to finish before evaluating extraction code on the destination page.`

## Known Traps

- Do not combine setting location.href and awaiting the load event with extraction/return logic in a single code execution; it failed with 'Inspected target navigated or closed'.
- Avoid running extraction code during the same execution context that triggers cross-page navigation, because the context can be destroyed on navigation.
