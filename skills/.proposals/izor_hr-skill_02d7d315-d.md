---
id: skill_02d7d315-d484-40d4-85a2-dc377ce18747
scope: domain
status: proposed
source: generated
confidence: 0.89
sourceRunIds:
  - run_31003a46-19f2-400c-bede-8c844a082356
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_31003a46-19f2-400c-bede-8c844a082356` with confidence 0.89.

## Facts

- DuckDuckGo search with the person's full name plus site:izor.hr can quickly find the relevant staff page.
- For izor.hr staff pages, the phone number may appear directly in the page text and can be extracted with a loose phone regex.
- The relevant result for Daria Ezgeta Balić was on the subdomain galijula.izor.hr at a /djelatnik/ slug.

## Selectors

- `a[href]`

## Routes

- `https://duckduckgo.com/?q=Daria%20Ezgeta%20Bali%C4%87%20site%3Aizor.hr`
- `https://galijula.izor.hr/djelatnik/daria-ezgeta-balic/`

## Wait Patterns

- `Wait briefly after DuckDuckGo navigation before scraping results; about 1200 ms was enough in this run.`

## Known Traps

- Repeated Page.navigate attempts to DuckDuckGo did not succeed in the trace; using location.href navigation worked more reliably.
- Trying to wait for window load inside an async script caused an Uncaught error in this run.
- Scraping immediately after navigation can miss the search results; a short explicit delay is needed.
