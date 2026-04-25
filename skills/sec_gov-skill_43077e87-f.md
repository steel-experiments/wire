---
id: skill_43077e87-f1d4-4c34-b913-e9444798390f
scope: domain
source: generated
tags:
  - auto-promoted
  - sec.gov
updatedAt: 2026-04-25
hostnamePatterns:
  - "sec.gov"
---

# Skill Proposal: sec.gov

Auto-generated from run `run_fcb983ba-3cd3-453f-9730-63458a7753da` with confidence 0.85.

## Facts

- SEC EDGAR search results for company filings are accessible via browse-edgar endpoint with action=getcompany parameter
- S-1 filings contain date in 4th column (index 3) of results table
- Filing links are in anchor tags with href containing 'Archives' path
- Figma CIK is 1579878

## Selectors

- `table tr for filing rows`
- `td for table cells`
- `a[href*="Archives"] for filing document links`

## Routes

- `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&company={company}&type=S-1 for filtered S-1 filings search`

## Wait Patterns

- `5000ms wait after navigation to SEC EDGAR search results page to ensure table loads`
