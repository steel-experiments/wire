---
id: skill_06633180-7157-43ca-bc4b-8f4c03d6fa2c
scope: domain
status: proposed
source: generated
confidence: 0.95
sourceRunIds:
  - run_653f5e21-788f-4dc9-9cb0-06d3ef3b54b2
tags:
  - auto-promoted
  - news.ycombinator.com
updatedAt: 2026-05-01
hostnamePatterns:
  - "news.ycombinator.com"
---

# Skill Proposal: news.ycombinator.com

Auto-generated from run `run_653f5e21-788f-4dc9-9cb0-06d3ef3b54b2` with confidence 0.95.

## Facts

- Front page stories are listed in rows with class .athing; the metadata for a story is in the immediate next sibling row.
- Story titles are in .titleline a on both the front page and item pages.
- On item pages, the main story block may be in .fatitem, but fallback selectors without .fatitem also work.
- Comments are in rows with class .comtr; collapsed comments have class .coll and should be filtered out.
- Top-level comments can be identified by indentation width 0 in the .ind img element.

## Selectors

- `.athing`
- `.athing + tr`
- `.titleline a`
- `.score`
- `.hnuser`
- `.fatitem .titleline a, .titleline a`
- `.fatitem .subtext, .subtext`
- `.comtr`
- `.comtr.coll`
- `.ind img`

## Routes

- `https://news.ycombinator.com/`
- `https://news.ycombinator.com/item?id=<story_id>`

## Wait Patterns

- `Wait for at least one .athing on the front page before extracting stories.`
- `After navigating to an item page, wait for .titleline a or .fatitem to appear before extracting story metadata and comments.`
- `When extracting comments, wait for .comtr rows to be present.`

## Known Traps

- Do not look for story metadata inside the .athing row itself on the front page; points/author/comments live in the next sibling row.
- Do not assume .fatitem is always required on item pages; use fallback selectors like .titleline a and .subtext as well.
- Do not include collapsed comments; filter out .comtr elements with class .coll.
- Do not treat the first visible comment row as necessarily top-level; check indentation via .ind img width/value and select indent 0.
