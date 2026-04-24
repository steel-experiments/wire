---
id: skill_4c867949-0e73-42cc-b82c-52756f28b000
scope: domain
source: generated
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-04-24T21:27:45.620Z
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_128fe073-043a-4b68-8c4e-e0e3ee7c436d` with confidence 0.7.

## Facts

- The site has a heading element containing 'Example Domain'
- Navigation to example.com loads successfully with title 'Example Domain'

## Selectors

- `h1`
- `h2`
- `h3`

## Routes

- `https://example.com/`

## Wait Patterns

- `Allow page load after navigation before querying DOM`

## Known Traps

- Avoid executing code during page navigation transitions - execution context may be destroyed; wait for navigation to complete before running queries
