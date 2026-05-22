---
id: skill_f4f759e2-cd79-4f7f-b7a1-8bb5090f37d8
scope: domain
status: proposed
source: generated
confidence: 0.95
sourceRunIds:
  - run_a21e4547-0141-4ed3-b566-10aea676fb47
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-05-20
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_a21e4547-0141-4ed3-b566-10aea676fb47` with confidence 0.95.

## Workflow

1. Step 1: Navigate to https://example.com and wait for the page to load.
2. Step 2: After navigation completes, read document.querySelector('h1')?.innerText?.trim() and save it as a text artifact.

## Facts

- The page title is 'Example Domain'.
- The main heading text is 'Example Domain'.
- Reading the heading works reliably after the browser has already completed navigation.

## Selectors

- `document.querySelector('h1')`

## Routes

- `https://example.com/`

## Wait Patterns

- `Wait for navigation/load to complete before running DOM queries on the destination page.`

## Known Traps

- Do not combine location.href navigation and post-navigation DOM extraction in the same code-exec step; it can fail with 'Inspected target navigated or closed'.
