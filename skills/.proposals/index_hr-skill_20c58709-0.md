---
id: skill_20c58709-0857-4b6d-8829-fa9989a66b13
scope: domain
status: proposed
source: generated
confidence: 0.84
sourceRunIds:
  - run_803c643b-e8bd-49da-a2ef-32b82b8f98d4
tags:
  - auto-promoted
  - index.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "index.hr"
---

# Skill Proposal: index.hr

Auto-generated from run `run_803c643b-e8bd-49da-a2ef-32b82b8f98d4` with confidence 0.84.

## Facts

- Direct navigation to https://index.hr can result in a blank about:blank state when immediately inspected; a second navigation via setting location.href to https://index.hr successfully lands on the site.
- For verification on this site, checking document.title after navigation is sufficient to confirm the page as Index.hr.

## Routes

- `https://index.hr`
- `https://www.index.hr/`

## Known Traps

- Do not rely on the initial Page.navigate alone if the page still reports about:blank afterward; the trace showed that approach did not complete verification.
- A verification probe executed too early can capture about:blank with empty title and text, so avoid assuming navigation has finished without a follow-up check.
