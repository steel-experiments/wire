---
id: skill_7f56a876-617c-4231-a7fc-ec5ea8075c7b
scope: domain
status: proposed
source: generated
confidence: 0.55
sourceRunIds:
  - run_d3518f62-e25e-4d2c-99f2-57f7d9284753
tags:
  - auto-promoted
  - news.ycombinator.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "news.ycombinator.com"
---

# Skill Proposal: news.ycombinator.com

Auto-generated from run `run_d3518f62-e25e-4d2c-99f2-57f7d9284753` with confidence 0.55.

## Facts

- Hacker News loaded successfully at https://news.ycombinator.com/
- The page title is 'Hacker News'

## Selectors

- `.athing .titleline a`

## Routes

- `https://news.ycombinator.com/`

## Known Traps

- A direct DOM query via document.querySelector('.athing .titleline a') triggered a Steel API 502 Bad Gateway error in this run, so relying on immediate JS DOM access may be unstable here.
