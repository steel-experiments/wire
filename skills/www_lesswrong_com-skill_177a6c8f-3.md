---
id: skill_177a6c8f-3ea4-443a-bb86-a15c985075d0
scope: domain
source: generated
tags:
  - auto-promoted
  - www.lesswrong.com
updatedAt: 2026-04-25
hostnamePatterns:
  - "www.lesswrong.com"
---

# Skill Proposal: www.lesswrong.com

Auto-generated from run `run_b5b01520-ae4c-4846-8cb8-880741b212b5` with confidence 0.82.

## Facts

- LessWrong is a React-based SPA; navigating with location.href destroys the execution context, so subsequent code-exec calls must be separate steps after navigation completes
- Post titles appear as anchor elements whose href contains '/posts/' path segment
- Post title anchors have className containing 'PostsTitle', 'postsTitle', or 'title' but filtering by href '/posts/' is more reliable
- The page title becomes 'LessWrong' once the SPA has loaded
- fetch() is a blocked pattern in Wire browser code

## Selectors

- `a[href*='/posts/'] — matches post title links; filter by text length > 5 and < 200 to exclude noise`
- `[class*='PostsTitle'] a — alternative selector for post title anchors`
- `a.PostsTitle-link — specific class used on some post title elements`
- `.PostsItem2-title a — post item title anchor in list views`

## Routes

- `https://www.lesswrong.com/ — front page with recent/curated posts feed`

## Wait Patterns

- `After setting location.href to lesswrong.com, the execution context is destroyed; Wire must wait for the next [observation] showing url=https://www.lesswrong.com/ and title=LessWrong before running DOM queries`
- `No additional setTimeout needed once the page observation shows the correct URL and title`

## Known Traps

- Setting location.href destroys the execution context — do not chain DOM queries in the same code-exec block as navigation
- fetch() calls are blocked by Wire; use location.href for navigation instead
- Filtering links by class name alone can miss titles or include noise; combining href.includes('/posts/') with text length bounds is more robust
- Deduplication is necessary as the same post title link may appear multiple times in the DOM (e.g. in sidebar and main feed)
