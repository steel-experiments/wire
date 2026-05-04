---
id: skill_bffee213-64d0-4d07-8e19-bb7c6391db59
scope: domain
status: proposed
source: generated
confidence: 0.88
sourceRunIds:
  - run_d9b3ae46-4155-4774-848a-fa8a862acd1c
tags:
  - auto-promoted
  - news.ycombinator.com
updatedAt: 2026-05-01
hostnamePatterns:
  - "news.ycombinator.com"
---

# Skill Proposal: news.ycombinator.com

Auto-generated from run `run_d9b3ae46-4155-4774-848a-fa8a862acd1c` with confidence 0.88.

## Facts

- On the front page, each story row uses `.athing` and its metadata is in the immediately following sibling row.
- Story title links on the front page are under `.titleline a`.
- On item/comment pages, the story header can be selected with `.fatitem .titleline a`, with fallback `.titleline a`.
- Story metadata such as points and author are in `.subtext`; points use `.score` and author uses `.hnuser`.
- Comment rows use `.comtr`. Collapsed comments have class `coll` and should be excluded when extracting visible comments.
- Top-level comments can be identified by checking the indentation image width inside the comment row; top-level comments have the smallest indent (commonly width `0`).

## Selectors

- `.athing`
- `.titleline a`
- `.fatitem .titleline a`
- `.subtext`
- `.score`
- `.hnuser`
- `.comtr`
- `.comtr.coll`

## Routes

- `https://news.ycombinator.com/`
- `/item?id=<story_id>`

## Wait Patterns

- `Wait for `.athing` on the front page before reading the first story.`
- `After following the comments link to `/item?id=...`, wait for `.fatitem` or `.comtr` before extracting story and comment data.`

## Known Traps

- Do not read story metadata from the `.athing` row itself on the front page; points/author/comments are in the next sibling row.
- Exclude comment rows with class `coll` or you may capture collapsed/hidden comments.
- Avoid assuming every comment is top-level; use the indentation marker (indent image width) to distinguish nesting.
