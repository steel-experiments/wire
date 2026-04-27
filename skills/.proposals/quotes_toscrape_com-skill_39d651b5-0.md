---
id: skill_39d651b5-0811-4e0d-a520-1eac6db4286d
scope: domain
status: proposed
source: generated
confidence: 0.88
sourceRunIds:
  - run_3b6cfe39-a291-445e-9874-ee353a74bcda
tags:
  - auto-promoted
  - quotes.toscrape.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "quotes.toscrape.com"
---

# Skill Proposal: quotes.toscrape.com

Auto-generated from run `run_3b6cfe39-a291-445e-9874-ee353a74bcda` with confidence 0.88.

## Facts

- The JS version of the site is at https://quotes.toscrape.com/js/ and can be reached by directly setting window.location.href.
- The page title after navigation is 'Quotes to Scrape'.

## Routes

- `https://quotes.toscrape.com/js/`

## Known Traps

- Do not treat quote text as an action payload; the model can emit a quote string that is not valid structured output.
- After navigating directly with window.location.href, the page may need a follow-up observation before using the DOM.
