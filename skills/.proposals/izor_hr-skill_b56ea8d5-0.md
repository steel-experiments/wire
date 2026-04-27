---
id: skill_b56ea8d5-03d3-46d7-a87c-6652873ea75b
scope: domain
status: proposed
source: generated
confidence: 0.83
sourceRunIds:
  - run_b6f19130-070e-4a22-9239-c384283db2fb
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_b6f19130-070e-4a22-9239-c384283db2fb` with confidence 0.83.

## Facts

- Institution staff/profile pages may be discoverable via DuckDuckGo with queries like `site:izor.hr` plus the person's name.
- For Daria Ezgeta Balić, a relevant profile page was found on `galijula.izor.hr` and a research team page on `jadran.izor.hr/~ezgeta/bivacme/team/`.
- The target research team page appears to be behind an auth wall and required user assistance.

## Selectors

- `a`

## Routes

- `https://duckduckgo.com/?q=<encoded query>&ia=web`
- `https://galijula.izor.hr/en/djelatnik/daria-ezgeta-balic/`
- `https://jadran.izor.hr/~ezgeta/bivacme/team/`

## Known Traps

- Do not assume the jadran.izor.hr research team page is directly accessible; it hits an authentication wall.
- DuckDuckGo search results may include many irrelevant anchors; filter by exact name/title before navigating.
