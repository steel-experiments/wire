---
id: skill_f83bc7c7-5437-4feb-b1de-5ef585423894
scope: domain
status: proposed
source: generated
confidence: 0.87
sourceRunIds:
  - run_bb77f11a-4259-4272-909c-a5628a027d1b
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_bb77f11a-4259-4272-909c-a5628a027d1b` with confidence 0.87.

## Facts

- For staff profile lookups, a DuckDuckGo search query like 'Name site:izor.hr' can surface the correct institute profile quickly.
- Daria Ezgeta Balić’s profile page on izor.hr contains the phone number 021408053.

## Selectors

- `DuckDuckGo result links can be found by scanning all anchors and filtering on result text plus izor.hr hrefs.`
- `The profile page used here was https://galijula.izor.hr/djelatnik/daria-ezgeta-balic/.`

## Routes

- `https://duckduckgo.com/?q=Name+site%3Aizor.hr`
- `https://galijula.izor.hr/djelatnik/daria-ezgeta-balic/`

## Wait Patterns

- `After clicking a DuckDuckGo result, wait for the destination page to load before querying DOM again.`

## Known Traps

- Do not rely on repeated click() attempts after navigation; once on the result page the original search result DOM is gone and the selector will fail.
- Do not assume the first matching result will always be the desired profile; verify both visible text and href before navigating.
