---
id: skill_c2de9347-d749-489c-a557-cabbcd14eda7
scope: domain
status: proposed
source: generated
confidence: 0.78
sourceRunIds:
  - run_159c295f-75de-4bf0-bed2-0bafe069a84d
tags:
  - auto-promoted
  - duckduckgo.com
updatedAt: 2026-04-30
hostnamePatterns:
  - "duckduckgo.com"
---

# Skill Proposal: duckduckgo.com

Auto-generated from run `run_159c295f-75de-4bf0-bed2-0bafe069a84d` with confidence 0.78.

## Facts

- DuckDuckGo can be used as a search starting point for finding a FocusEconomics result by querying 'steel price usd per ton'.
- A successful result in this run was the FocusEconomics snippet stating: steel price = USD 1,021 per metric ton in March.

## Selectors

- `a`

## Routes

- `https://duckduckgo.com/?q=steel+price+usd+per+ton`

## Known Traps

- Searching DuckDuckGo with the query alone may not guarantee the desired top result; this run relied on scanning all anchor tags and matching link text with /FocusEconomics/i.
- No dedicated result selector was used; if the page layout changes, clicking the first matching anchor text may fail.
