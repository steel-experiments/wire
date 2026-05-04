---
id: skill_6b71bbb6-cc73-4467-9c83-e46dcd378ca6
scope: domain
status: proposed
source: generated
confidence: 0.9
sourceRunIds:
  - run_56af8f7d-641d-4baf-934d-99d372c737ab
tags:
  - auto-promoted
  - news.ycombinator.com
updatedAt: 2026-05-01
hostnamePatterns:
  - "news.ycombinator.com"
---

# Skill Proposal: news.ycombinator.com

Auto-generated from run `run_56af8f7d-641d-4baf-934d-99d372c737ab` with confidence 0.9.

## Facts

- On the front page, each story row uses `.athing` and its metadata is in the immediately following sibling row.
- Story title links are inside `.titleline a` on both the front page and item page.
- On item pages, story metadata is in `.subtext`, including `.score` for points and `.hnuser` for author.
- Comments on item pages use `.comtr`; collapsed comments have the `coll` class.
- Top-level comments can be identified by checking indentation width from `.ind img` and selecting comments with zero indentation.

## Selectors

- `.athing`
- `.titleline a`
- `.subtext`
- `.score`
- `.hnuser`
- `.comtr`
- `.comtr.coll`
- `.ind img`

## Routes

- `https://news.ycombinator.com/`
- `https://news.ycombinator.com/item?id=<story_id>`

## Wait Patterns

- `Wait for `.athing` on the front page before extracting the first story.`
- `After navigating to an item page, wait for `.subtext` or `.comtr` before extracting metadata and comments.`

## Known Traps

- Do not assume front-page points match item-page points; the score may change between navigations.
- Do not include `.comtr.coll` when extracting visible comments.
- Do not assume the comments link text is fixed to exactly 'comments'; matching `/comment/` against metadata links is more robust.
