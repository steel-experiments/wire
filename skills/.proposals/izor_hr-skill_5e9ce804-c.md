---
id: skill_5e9ce804-c9f7-4f8d-89c9-9fdf74432b68
scope: domain
status: proposed
source: generated
confidence: 0.82
sourceRunIds:
  - run_723bf83f-059c-4f8e-8ab5-4683a31703dd
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_723bf83f-059c-4f8e-8ab5-4683a31703dd` with confidence 0.82.

## Facts

- The site redirects from https://www.izor.hr to https://galijula.izor.hr/ (IOR site).
- Directly setting document.body.innerHTML on about:blank before navigation can fail because document.body may be null.
- The employee profile for 'Daria Ezgeta Balić' appears to be accessible via a specific profile URL path under /en/djelatnik/.
- Searching the site text on the profile page did not reveal the target name; a broader site search or search engine may be needed.
- DuckDuckGo results page may require using the visible result link rather than expecting the target page to already be loaded.

## Selectors

- `a[href*='galijula.izor.hr']`
- `a[href*='/en/djelatnik/']`
- `a[href*='daria-ezgeta-balic']`

## Routes

- `https://www.izor.hr`
- `https://galijula.izor.hr/`
- `https://galijula.izor.hr/en/djelatnik/daria-ezgeta-balic/`
- `https://duckduckgo.com/?q=site%3Aizor.hr+%22Daria+Ezgeta+Bali%C4%87%22&ia=web`

## Wait Patterns

- `After location.href navigation, wait for the new page load before querying the DOM.`
- `When navigating through search results, inspect the current document after the results page fully loads.`

## Known Traps

- Do not assume document.body exists on about:blank before navigation; body.innerHTML access can throw.
- Do not rely on clicking or finding a profile link by exact visible text if the page text differs from the search snippet.
- Do not keep searching for 'Daria Ezgeta Balić - Institut' when the result text may be shorter or formatted differently.
- Do not expect the target profile to be present on the homepage text; it may only be reachable through a direct profile route or search result.
- Do not read DOM immediately after setting location.href inside the same async execution; navigation can interrupt the script with 'Inspected target navigated or closed'.
