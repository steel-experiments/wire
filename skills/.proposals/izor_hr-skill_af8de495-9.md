---
id: skill_af8de495-9dc3-4fd9-be58-80b17dbb61e5
scope: domain
status: proposed
source: generated
confidence: 0.84
sourceRunIds:
  - run_91351c9a-1fd4-4799-a1cb-c4dce5f85136
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_91351c9a-1fd4-4799-a1cb-c4dce5f85136` with confidence 0.84.

## Facts

- DuckDuckGo search results for a person query can surface the desired IZOR profile page.
- For this target, the desired profile URL was https://galijula.izor.hr/djelatnik/daria-ezgeta-balic/; the page also exposed same-URL anchors with a trailing #.
- When extracting info immediately after navigation, direct location.href changes can destroy the execution context; waiting for the page load/navigation to complete is safer.

## Selectors

- `a[href*='galijula.izor.hr/djelatnik/daria-ezgeta-balic']`
- `a[href='https://galijula.izor.hr/djelatnik/daria-ezgeta-balic/#']`

## Routes

- `https://duckduckgo.com/?q=Daria%20Ezgeta%20Bali%C4%87%20site%3Aizor.hr`
- `https://galijula.izor.hr/djelatnik/daria-ezgeta-balic/`

## Wait Patterns

- `Wait for DuckDuckGo results page to load before querying DOM.`
- `After setting location.href to a new page, wait for the load/navigation event before reading document.body or DOM.`
- `If navigation is triggered inside page context, execution context may be destroyed; retry after the new page settles.`

## Known Traps

- Using window.location.href navigation and then immediately reading document.body.innerText caused 'Execution context was destroyed.'
- Searching only for anchor text matching 'Daria Ezgeta Balić - Institut' failed because the page initially exposed utility links and same-page anchors, not the result link.
- Looking for an href containing the profile path without allowing a trailing '#' missed the actual anchor found on the page.
- Repeatedly clicking/searching the same selector on the results page kept returning 'profile link not found' until the broader href-based match was used.
- Matching only on innerText was insufficient; href-based matching was the reliable approach on this site.
