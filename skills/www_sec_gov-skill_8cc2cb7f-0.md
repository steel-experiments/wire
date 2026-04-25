---
id: skill_8cc2cb7f-079d-4030-a34e-6f4b7e915223
scope: domain
source: generated
tags:
  - auto-promoted
  - www.sec.gov
updatedAt: 2026-04-25
hostnamePatterns:
  - "www.sec.gov"
---

# Skill Proposal: www.sec.gov

Auto-generated from run `run_71ae865f-847a-4fcc-893b-032c51f493bc` with confidence 0.9.

## Facts

- Apple Inc's CIK on EDGAR is 0000320193
- Apple's most recent 10-K was filed on 2024-11-01 (for fiscal year ending 2024)
- Searching by company name 'Apple' returns a list of companies, not direct filings; use the CIK directly to get Apple Inc filings
- After triggering a location.href navigation, the execution context is destroyed before the next await resolves — split navigation and post-navigation scraping into separate code blocks

## Selectors

- `table.tableFile2 tr — rows in EDGAR filing results table`
- `table.tableFile2 tr td:nth-child(1) — form type cell`
- `table.tableFile2 tr td:nth-child(4) — filing date cell`

## Routes

- `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K&dateb=&owner=include&count=5 — Apple Inc 10-K filings list`
- `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Apple&type=10-K&dateb=&owner=include&count=5 — company name search (returns multiple companies, less reliable)`

## Wait Patterns

- `After location.href navigation wait at least 3000ms before querying the DOM`
- `Never chain location.href + await + DOM query in a single code block; the execution context will be destroyed mid-execution`

## Known Traps

- Searching by company name 'Apple' on EDGAR returns a company list page, not filings — always use the direct CIK URL for reliable filing data
- location.href navigation destroys the execution context, causing ok=false errors; always split navigation and scraping into separate code-exec blocks
