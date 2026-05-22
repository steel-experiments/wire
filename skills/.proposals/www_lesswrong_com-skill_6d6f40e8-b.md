---
id: skill_6d6f40e8-b8cc-4840-8607-12215186594c
scope: domain
status: proposed
source: generated
confidence: 0.8
sourceRunIds:
  - run_66df7fed-beca-431c-b3bb-79b51db8eefe
tags:
  - auto-promoted
  - www.lesswrong.com
updatedAt: 2026-05-20
hostnamePatterns:
  - "www.lesswrong.com"
---

# Skill Proposal: www.lesswrong.com

Auto-generated from run `run_66df7fed-beca-431c-b3bb-79b51db8eefe` with confidence 0.8.

## Workflow

1. Step 1: Navigate directly to https://www.lesswrong.com/.
2. Step 2: After navigation completes, extract visible homepage text from document.body.innerText or scan common text-bearing elements (a, h1-h4, div, span) for post titles.
3. Step 3: For titles, deduplicate text values and filter to likely article/post titles rather than relying only on href patterns.

## Facts

- Homepage title is 'LessWrong'.
- Homepage visible navigation includes Home, All Posts, Concepts, Library, Best of LessWrong, Sequence Highlights, and Rationality: A-Z.
- Visible homepage text contains post titles such as 'Welcome to LessWrong!', 'My hobby: running deranged surveys', and 'Irretrievability; or, Murphy's Curse of Oneshotness upon ASI'.

## Selectors

- `document.body`
- `a[href*="/posts/"]`
- `a, h1, h2, h3, h4, div, span`

## Routes

- `https://www.lesswrong.com/`

## Wait Patterns

- `Wait for navigation to finish before running DOM extraction code after setting location.href.`

## Known Traps

- Running navigation and DOM extraction in the same code execution after setting location.href can fail with 'Inspected target navigated or closed'.
- Relying only on a[href*="/posts/"] may miss or undercount homepage post titles; fallback to scanning visible text across common text elements.
