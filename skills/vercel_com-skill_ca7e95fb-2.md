---
id: skill_ca7e95fb-2559-45c0-8889-85f92bde581f
scope: domain
status: active
source: generated
confidence: 0.88
sourceRunIds:
  - run_d8aeadb9-859e-452b-b73a-83f92b1793eb
tags:
  - auto-promoted
  - vercel.com
updatedAt: 2026-05-20
hostnamePatterns:
  - "vercel.com"
---

# Skill Proposal: vercel.com

Auto-generated from run `run_d8aeadb9-859e-452b-b73a-83f92b1793eb` with confidence 0.88.

## Workflow

1. Step 1: Navigate directly to https://vercel.com/pricing.
2. Step 2: Wait for the page title to become "Vercel Pricing: Hobby, Pro, and Enterprise plans" or for the body text to include Hobby, Pro, and Enterprise.
3. Step 3: Extract document.body.innerText, split on newlines, trim/filter blank lines, and locate exact plan headings Hobby, Pro, and Enterprise in the flattened text.
4. Step 4: Slice a small window after each heading to capture nearby pricing/features and assemble the markdown comparison.
5. Step 5: Fallback: if flattened text parsing is insufficient, search section/div containers for one whose text includes all three plan names, then parse that container's innerText.

## Facts

- The pricing page is directly reachable at /pricing.
- The page title observed was "Vercel Pricing: Hobby, Pro, and Enterprise plans".
- A simple text-based extraction from document.body.innerText was sufficient to build a pricing comparison artifact.
- Plan names appear as exact headings: Hobby, Pro, Enterprise.
- A container-level fallback also worked by filtering section/div elements whose text included all three plan names.

## Selectors

- `section, div`
- `document.body`

## Routes

- `https://vercel.com/pricing`

## Wait Patterns

- `After setting location.href, wait for navigation to complete before evaluating DOM; a fixed 2500 ms sleep alone was not reliable.`
- `Wait until document.title matches the pricing page title or body text contains Hobby, Pro, and Enterprise before parsing.`

## Known Traps

- Running a long code block that sets location.href and continues DOM extraction in the same evaluation can fail with "Inspected target navigated or closed" because navigation interrupts execution.
- Do not rely only on a fixed post-navigation sleep; the page may navigate asynchronously and invalidate the execution context.
