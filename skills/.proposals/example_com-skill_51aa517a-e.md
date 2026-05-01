---
id: skill_51aa517a-e245-4703-86b4-1a8ffa76889e
scope: domain
status: proposed
source: generated
confidence: 0.92
sourceRunIds:
  - run_7a9233bc-110c-41cf-ae0f-cdace5b04fa8
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-05-01
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_7a9233bc-110c-41cf-ae0f-cdace5b04fa8` with confidence 0.92.

## Facts

- The homepage https://example.com/ has document.title 'Example Domain' and the main h1 text 'Example Domain'.

## Selectors

- `h1`

## Routes

- `https://example.com/`

## Wait Patterns

- `After navigating by setting location.href, wait for the new page to load and then run DOM queries in a fresh execution context.`

## Known Traps

- Do not rely on a promise created before navigation that accesses the DOM after location.href changes; the execution context is destroyed during navigation.
