---
id: skill_f9c0aed0-c517-490b-abbc-312d78872e0c
scope: domain
status: proposed
source: generated
confidence: 0.87
sourceRunIds:
  - run_7ee0c7d4-e785-4f7a-8479-0608ae2833e0
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_7ee0c7d4-e785-4f7a-8479-0608ae2833e0` with confidence 0.87.

## Facts

- Daria Ezgeta Balić contact email was found as ezgeta@izor.hr.
- No phone number was visible in the search results.
- DuckDuckGo search results can surface the target profile page and contact info.

## Selectors

- `a[href*='izor.hr']`
- `a[href*='galijula.izor.hr']`
- `a[href*='jadran.izor.hr']`

## Routes

- `https://www.izor.hr`
- `https://duckduckgo.com/?q=site%3Aizor.hr+%22Daria+Ezgeta+Bali%C4%87%22+phone`
- `https://galijula.izor.hr/en/djelatnik/daria-ezgeta-balic/`
- `https://jadran.izor.hr/azo/`

## Wait Patterns

- `Wait ~1500ms after navigating to izor.hr before reading page text.`
- `Wait ~2000ms after navigating to DuckDuckGo search results before scraping links/text.`

## Known Traps

- Using location.href to navigate while simultaneously reading document text can trigger 'Inspected target navigated or closed'.
- Element handles from querySelectorAll are plain DOM anchors; calling target.click() on a non-element/undefined target caused 'TypeError: target.click is not a function'.
- Searching for exact English link text like 'Daria Ezgeta Balić - Institut' or 'Research team - jadran.izor.hr' was unreliable because the page text did not match those strings; rely on href/domain matching instead.
- On the current search results page, top accessible links were toolbar controls ('Open toolbar', 'Povećaj tekst', etc.), so link filtering must exclude UI chrome and inspect hrefs.
- The profile/result link may not be present on the same page after navigation; re-query anchors after each page load before clicking.
