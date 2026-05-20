---
id: skill_dcae5e6f-27ab-425b-b8de-c9f5a7178712
scope: domain
status: active
source: generated
confidence: 0.9
sourceRunIds:
  - run_d7a5f7b4-7318-4c87-ad30-fa94cae13588
tags:
  - auto-promoted
  - www.sec.gov
updatedAt: 2026-05-20
hostnamePatterns:
  - "www.sec.gov"
---

# Skill Proposal: www.sec.gov

Auto-generated from run `run_d7a5f7b4-7318-4c87-ad30-fa94cae13588` with confidence 0.9.

## Workflow

1. Step 1: Open the EDGAR company filings route with Apple's CIK: /cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K&dateb=&owner=include&count=5.
2. Step 2: On the EDGAR Search Results page, read rows from table.tableFile2 and skip the header row.
3. Step 3: Use the first data row as the latest filing and extract column 0 as form type and column 3 as filing date.

## Facts

- Apple's SEC CIK works reliably as 0000320193 for EDGAR company filing searches.
- The EDGAR results table for this search is rendered as table.tableFile2.
- In the results table, the first data row corresponds to the latest matching filing.
- For the observed run, the latest Apple 10-K showed form type 10-K and filing date 2025-10-31.

## Selectors

- `table.tableFile2 tr`
- `table.tableFile2 tr td`

## Routes

- `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000320193&type=10-K&dateb=&owner=include&count=5`
- `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company=Apple&type=10-K&dateb=&owner=include&count=5`

## Wait Patterns

- `After setting location.href, wait for navigation to complete before querying the DOM; querying in the same eval can fail due to target navigation.`

## Known Traps

- Do not combine location.href navigation and DOM scraping in the same code execution; it can fail with 'Inspected target navigated or closed'.
- Prefer CIK-based EDGAR search over company-name search for reliability; the run succeeded with CIK after the initial company-name navigation/scrape attempt failed.
