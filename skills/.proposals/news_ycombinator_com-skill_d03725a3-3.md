---
id: skill_d03725a3-357e-402a-aebd-99ed7ef46b29
scope: domain
status: proposed
source: generated
confidence: 0.96
sourceRunIds:
  - run_7bcb2dda-3749-4597-9edb-9afcf4e18669
tags:
  - auto-promoted
  - news.ycombinator.com
updatedAt: 2026-05-01
hostnamePatterns:
  - "news.ycombinator.com"
---

# Skill Proposal: news.ycombinator.com

Auto-generated from run `run_7bcb2dda-3749-4597-9edb-9afcf4e18669` with confidence 0.96.

## Facts

- The Hacker News homepage lists stories in rows with class '.athing'; the metadata for a story is in the immediate next sibling row.
- On a comments page ('/item?id=...'), the story title is available via '.titleline a', and subtext metadata includes '.score' for points and '.hnuser' for author.
- Comments are rendered as rows with class '.comtr'; collapsed comments also have class '.coll'.
- Top-level comments can be identified by checking the indentation image width under '.ind img' and selecting comments with width 0.

## Selectors

- `.athing`
- `.titleline a`
- `.score`
- `.hnuser`
- `.comtr`
- `.comtr.coll`
- `.ind img`

## Routes

- `https://news.ycombinator.com/`
- `https://news.ycombinator.com/item?id=<id>`

## Wait Patterns

- `After setting location.href to a comments link from the homepage, expect the execution context to be destroyed by navigation and continue extraction in a new step after the page load observation.`
- `On the homepage, find the comments link by scanning the metadata row's anchors for text matching /comment/.`

## Known Traps

- Do not navigate with location.href and then continue awaiting DOM conditions in the same code execution; the script will fail with 'Inspected target navigated or closed' because navigation destroys the execution context.
- Do not assume the story metadata is inside the '.athing' row itself; it is in the next sibling row.
