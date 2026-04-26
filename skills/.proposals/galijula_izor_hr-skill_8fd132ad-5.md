---
id: skill_8fd132ad-510b-4c2f-a83c-57def398f670
scope: domain
status: proposed
source: generated
confidence: 0.84
sourceRunIds:
  - run_feaba911-c664-45f0-904c-720e4fae3d66
tags:
  - auto-promoted
  - galijula.izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "galijula.izor.hr"
---

# Skill Proposal: galijula.izor.hr

Auto-generated from run `run_feaba911-c664-45f0-904c-720e4fae3d66` with confidence 0.84.

## Facts

- DuckDuckGo search with query `Daria Ezgeta Balić site:izor.hr` led to the relevant profile page on galijula.izor.hr.
- The target profile page title was `Daria Ezgeta Balić - Institut`.
- The phone number found on the profile page was `021408053`.

## Selectors

- ``a` elements on DuckDuckGo results page; the correct result contained text like `Daria Ezgeta Balić - Institut` and href including `galijula.izor.hr`.`

## Routes

- ``https://duckduckgo.com/?q=` + encodeURIComponent(`Daria Ezgeta Balić site:izor.hr`)`
- ``https://galijula.izor.hr/djelatnik/daria-ezgeta-balic/``

## Wait Patterns

- `After setting `location.href` to DuckDuckGo search, wait for the page body text to load before scraping results.`
- `A short delay after navigation is needed before inspecting search results or the destination page.`

## Known Traps

- Navigating and then immediately reading the page can fail with `Inspected target navigated or closed` if the context changes mid-evaluation.
- Avoid assuming the first search result is correct; verify the result text and href match the target profile.
- Do not use an unencoded query string in the DuckDuckGo URL; use `encodeURIComponent`.
