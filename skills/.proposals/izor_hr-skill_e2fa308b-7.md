---
id: skill_e2fa308b-7dd7-4cef-be3d-055db015f7e8
scope: domain
status: proposed
source: generated
confidence: 0.88
sourceRunIds:
  - run_607433b9-aac2-4840-ac18-6f1d937671e2
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_607433b9-aac2-4840-ac18-6f1d937671e2` with confidence 0.88.

## Facts

- Staff profile pages on galijula.izor.hr can contain phone numbers in the page HTML/text, even when the name search on the main site does not find a direct match.
- For this site, a direct staff-profile URL pattern worked: /en/djelatnik/{slug}/ .
- Searching DuckDuckGo with site:izor.hr plus the person’s full name can help locate the relevant staff profile page when site navigation/search fails.
- Once on the staff profile page, extracting phone-like strings from both document.body.innerText and document.documentElement.innerHTML is effective.

## Selectors

- `a[href*='/en/djelatnik/']`
- `document.body.innerText`
- `document.documentElement.innerHTML`

## Routes

- `https://www.izor.hr`
- `https://duckduckgo.com/?q=site%3Aizor.hr%20%22Daria%20Ezgeta%20Bali%C4%87%22&ia=web`
- `https://galijula.izor.hr/en/djelatnik/daria-ezgeta-balic/`

## Wait Patterns

- `After setting location.href, wait for the new page context to load before querying the DOM.`
- `On DuckDuckGo, read results from document.body.innerText after navigation completes.`

## Known Traps

- Directly navigating with location.href on izor.hr initially produced 'Target not found: page' in the automation context.
- The main site name lookup for Daria Ezgeta Balić returned found:false and did not expose the needed phone.
- Repeated DuckDuckGo searches with minor query variants were mostly redundant; the reliable result came from opening the specific staff profile URL.
- Naive phone extraction matched a misleading numeric string '020061100918315'; prefer tighter Croatian phone patterns and validate against profile context.
