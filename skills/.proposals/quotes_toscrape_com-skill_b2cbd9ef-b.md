---
id: skill_b2cbd9ef-b6a9-49f8-b387-4f380c5071ed
scope: domain
status: proposed
source: generated
confidence: 0.67
sourceRunIds:
  - run_24d088d8-4d87-4729-a52e-116c7d04da76
tags:
  - auto-promoted
  - quotes.toscrape.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "quotes.toscrape.com"
---

# Skill Proposal: quotes.toscrape.com

Auto-generated from run `run_24d088d8-4d87-4729-a52e-116c7d04da76` with confidence 0.67.

## Facts

- The target site for this task is the JavaScript version of Quotes to Scrape at https://quotes.toscrape.com/js/.
- A direct navigation attempt via window.location.href was used, but the browser API returned a 502 Bad Gateway error instead of completing the navigation.

## Routes

- `https://quotes.toscrape.com/js/`

## Known Traps

- Do not rely on window.location.href for navigation in this environment; it triggered a Steel API 502 Bad Gateway error.
