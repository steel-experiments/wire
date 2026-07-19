---
id: skill_hn-eval-v1
scope: domain
status: active
source: team
tags:
  - hacker-news
  - comments
  - stories
updatedAt: 2026-07-19
hostnamePatterns:
  - "news.ycombinator.com"
---

# Hacker News extraction

## Workflow

Navigate first, then extract in a fresh action. Call `await waitForSelector("tr.athing", 10000)` before reading stories.

For each `tr.athing`, read `.rank`, `.titleline > a` text and `href`; read points and the `item?id=` comments link from the following row's `.subtext`. Convert missing points/comments to `0`, preserve page order, and return exactly the requested fields.

For a comment task, follow the rank-1 row's observed comments link. Wait for `tr.athing.comtr`, then use the first visible top-level comment: `.hnuser`, `.commtext`, and its observed `.age a` permalink. Extract the first complete sentence without including reply UI.

## Known traps

Do not combine navigation and extraction. The story link is not the comments link. Never guess URLs.
