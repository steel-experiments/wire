---
id: skill_e62e4f6d-2fdd-498a-ac05-8beafd199651
scope: domain
status: proposed
source: generated
confidence: 0.94
sourceRunIds:
  - run_46b54594-cf64-4242-9d56-479c6898fab6
tags:
  - auto-promoted
  - news.ycombinator.com
updatedAt: 2026-05-01
hostnamePatterns:
  - "news.ycombinator.com"
---

# Skill Proposal: news.ycombinator.com

Auto-generated from run `run_46b54594-cf64-4242-9d56-479c6898fab6` with confidence 0.94.

## Facts

- On the Hacker News front page, each story row uses `.athing` and its metadata is in the immediate `nextElementSibling`.
- Story title links are found with `.titleline a`.
- Points are in `.score`, author in `.hnuser`, and the comments link can be found by scanning metadata-row anchors for text containing `comment`.
- Comments pages use `/item?id=...` routes.
- On an item page, visible comments are `.comtr` rows; collapsed comments have the `coll` class and should be filtered out.
- Top-level comments can be identified by checking indentation width from `.ind img` and selecting comments with width `0`.

## Selectors

- `.athing`
- `.titleline a`
- `.score`
- `.hnuser`
- `.comtr`
- `.comtr.coll`
- `.ind img`
- `.subtext`

## Routes

- `https://news.ycombinator.com/`
- `https://news.ycombinator.com/item?id=<story_id>`

## Known Traps

- Do not assume all `.comtr` comments are visible; filter out rows with the `coll` class.
- Do not assume the comments link has a fixed selector; on the metadata row it is more reliable to find an anchor whose text contains `comment`.
- Do not read front-page metadata from inside `.athing`; the score/author/comments are in the next sibling row.
