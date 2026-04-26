---
id: skill_11e0168d-15b2-4888-9242-56fdbc6df781
scope: domain
status: proposed
source: generated
confidence: 0.9
sourceRunIds:
  - run_a786d05b-3d91-47ea-8f14-89ecd4439d4f
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_a786d05b-3d91-47ea-8f14-89ecd4439d4f` with confidence 0.9.

## Facts

- The IZOR team page for Daria Ezgeta Balić showed her email address ezgeta@izor.hr, but no usable phone number was present.
- Searching the page text for phone-like patterns can produce false positives from addresses/postal codes such as '63' and '21000', so extracted matches must be validated.

## Selectors

- `a[href*='jadran.izor.hr/~ezgeta/bivacme/team/']`
- `a[href*='daria-ezgeta-balic']`
- `a:contains('Research team - jadran.izor.hr')`

## Routes

- `https://www.izor.hr`
- `https://jadran.izor.hr/~ezgeta/bivacme/team/`
- `https://duckduckgo.com/?q=site%3Aizor.hr+%22Daria+Ezgeta+Bali%C4%87%22+phone`

## Wait Patterns

- `After navigating to DuckDuckGo or another search results page, wait for the page context to settle before evaluating DOM; a direct immediate evaluation after location changes caused 'Execution context was destroyed.'`

## Known Traps

- Do not assume a phone number exists just because a generic phone regex finds digit groups; on this page it matched non-phone text like postal code fragments.
- Do not use target.click() on plain objects created by mapping DOM nodes; click the actual element reference (e.g. target.el.click()).
- Do not evaluate page DOM immediately after changing location.href; it can destroy the execution context.
- Do not rely on the main izor.hr homepage alone for staff contact details; the relevant team page was on jadran.izor.hr/~ezgeta/bivacme/team/.
