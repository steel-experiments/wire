---
id: skill_977fbb5a-44b3-4ce7-ab7c-1be2e596bab2
scope: domain
status: proposed
source: generated
confidence: 0.93
sourceRunIds:
  - run_5ef6dccd-4009-49da-8aac-cec2ef69dbea
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_5ef6dccd-4009-49da-8aac-cec2ef69dbea` with confidence 0.93.

## Facts

- The staff profile for Daria Ezgeta Balić is on the Galijula subdomain, not the main izor.hr homepage.
- Searching DuckDuckGo with the exact person name plus 'site:izor.hr' can reveal the correct profile page when direct navigation is unclear.
- The target phone number was found by extracting page text from the staff profile page and scanning nearby lines for phone-like patterns.

## Selectors

- `a[href*='daria-ezgeta-balic']`
- `a[href*='galijula.izor.hr/en/djelatnik/']`

## Routes

- `https://galijula.izor.hr/en/djelatnik/daria-ezgeta-balic/`
- `https://duckduckgo.com/?q=Daria+Ezgeta+Bali%C4%87+site%3Aizor.hr&ia=web`

## Wait Patterns

- `After changing location.href, wait a couple seconds before reading document.body.innerText.`
- `When using page navigation in Wire, don't assume a Playwright page object exists; rely on location changes and then wait for DOM content.`

## Known Traps

- location.href = 'https://www.izor.hr' from about:blank caused a 'Target not found: page' error.
- Using page.goto(...) failed with 'ReferenceError: page is not defined'.
- Repeatedly navigating to DuckDuckGo without waiting did not immediately surface the result; the search page needed a click or direct query URL and then DOM inspection.
