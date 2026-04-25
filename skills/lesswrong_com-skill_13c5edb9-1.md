---
id: skill_13c5edb9-1742-45be-bf48-3b58c3a15752
scope: domain
source: generated
tags:
  - auto-promoted
  - lesswrong.com
updatedAt: 2026-04-25
hostnamePatterns:
  - "lesswrong.com"
---

# Skill Proposal: lesswrong.com

Auto-generated from run `run_12eb1a35-7717-4ca3-b78d-311a6e09dda0` with confidence 0.7.

## Facts

- LessWrong front page loads at https://www.lesswrong.com/
- Posts are displayed in a 'Recent' section on the front page
- Page structure contains post listings with title, author(s), timestamp, and score
- DOM selectors for post containers are inconsistent across page updates
- Text parsing of body.innerText is more reliable than CSS selectors for extracting posts
- Post pattern in text: Title\nAuthor(s)\nTime\nScore

## Selectors

- `[class*="PostsItem"]`
- `[class*="PostsPage"] > div > div`
- `li[class*="post"]`
- `.posts-item`

## Routes

- `https://www.lesswrong.com/ - front page with recent posts`

## Wait Patterns

- `Wait 3000ms minimum after navigation for content to fully render before extraction`

## Known Traps

- DOM-based selectors may fail or return empty due to dynamic class naming
- First extraction attempts with querySelectorAll return empty arrays - text parsing fallback is necessary
- Page structure is complex with nested divs - CSS selectors alone are unreliable
