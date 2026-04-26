---
id: skill_55337bfa-f8ea-4861-99c9-d86c3d8a9762
scope: domain
status: proposed
source: generated
confidence: 0.83
sourceRunIds:
  - run_f3419711-f8e3-4479-ab25-cfeeca94f703
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_f3419711-f8e3-4479-ab25-cfeeca94f703` with confidence 0.83.

## Facts

- The Daria Ezgeta Balić staff page is on the galijula subdomain, not the main izor.hr domain: https://galijula.izor.hr/en/djelatnik/daria-ezgeta-balic/
- DuckDuckGo search for site:izor.hr can surface the correct staff page for a person-name lookup

## Selectors

- `Search result links on DuckDuckGo matching the person name or the institute domain`

## Routes

- `https://duckduckgo.com/?q=site%3Aizor.hr+%22Daria+Ezgeta+Bali%C4%87%22&ia=web`
- `https://galijula.izor.hr/en/djelatnik/daria-ezgeta-balic/`

## Wait Patterns

- `After setting location.href to a new page, wait for navigation to complete before reading document.body; immediate DOM access can fail or inspect a closed target`
- `A short post-click wait (about 2.5s) was used before extracting page text, though navigation timing was still fragile in the trace`

## Known Traps

- Trying to access document.body right after location.href navigation caused 'Inspected target navigated or closed'
- Using a generic 'page' target after navigation led to 'Target not found: page'
- Clicking the DuckDuckGo result and then immediately inspecting the old context also caused 'Inspected target navigated or closed'
