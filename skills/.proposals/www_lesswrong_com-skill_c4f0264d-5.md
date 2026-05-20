---
id: skill_c4f0264d-5fe3-4f08-bd81-8e8d3a14067d
scope: domain
status: proposed
source: generated
confidence: 0.89
sourceRunIds:
  - run_2cfc1b95-8360-4dfa-878d-bb985e8b117f
tags:
  - auto-promoted
  - www.lesswrong.com
updatedAt: 2026-05-20
hostnamePatterns:
  - "www.lesswrong.com"
---

# Skill Proposal: www.lesswrong.com

Auto-generated from run `run_2cfc1b95-8360-4dfa-878d-bb985e8b117f` with confidence 0.89.

## Workflow

1. Step 1: Navigate to https://www.lesswrong.com/ and wait for the homepage to finish loading.
2. Step 2: Query article links with document.querySelectorAll('a[href*="/posts/"]') instead of broader post URL regexes.
3. Step 3: Extract trimmed textContent, filter out short labels (e.g. text length < 8), and deduplicate titles to get readable post titles from the homepage.

## Facts

- Homepage article links on LessWrong are discoverable via anchor hrefs containing '/posts/'.
- Useful post titles can be extracted directly from anchor text on the homepage.
- Deduplication is needed because multiple anchors can repeat the same post title.

## Selectors

- `a[href*="/posts/"]`

## Routes

- `https://www.lesswrong.com/`

## Wait Patterns

- `After setting location.href, wait for navigation/load to complete before querying the DOM; a fixed 3s sleep during navigation caused the execution context to be lost.`

## Known Traps

- Running DOM queries immediately after setting location.href in the same code block can fail with 'Inspected target navigated or closed'.
- Using a broader href regex for '/(posts|s)/' was unnecessary; '/posts/' anchor matching worked reliably on the homepage.
