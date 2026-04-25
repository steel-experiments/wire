---
id: skill_f0bdc404-bbb7-4969-b942-2abb31683d12
scope: domain
source: generated
tags:
  - auto-promoted
  - news.ycombinator.com
updatedAt: 2026-04-25
hostnamePatterns:
  - "news.ycombinator.com"
---

# Skill Proposal: news.ycombinator.com

Auto-generated from run `run_d3a2fbc1-3986-41a6-9e85-7c636b74aa97` with confidence 0.9.

## Facts

- The Hacker News homepage can be verified directly from the page body text; the page title is 'Hacker News'.
- Top posts are listed in table rows with class '.athing'; the visible ranking/order can be taken from the first 10 '.athing' rows.
- Each story title is in '.titleline a' and the destination URL is the anchor href.
- The score for a story is in the next sibling row of '.athing', inside '.score'.
- The source site label, when present, is in '.sitestr' on the story row.

## Selectors

- `.athing`
- `.titleline a`
- `.score`
- `.sitestr`

## Routes

- `https://news.ycombinator.com/`

## Wait Patterns

- `After navigating to Hacker News, wait for the page to load before reading '.athing' rows or body text.`

## Known Traps

- The homepage can briefly be about:blank after setting location.href; verify the URL/title changed before scraping.
- Story metadata (like score) is not on the '.athing' row itself; it is on the next sibling row.
- When extracting top posts, limit to the first 10 '.athing' rows to match 'Top Hacker News posts today'.
