---
id: skill_10b5f756-0713-44b5-9865-f3f4c487ddac
scope: domain
source: generated
tags:
  - auto-promoted
  - www.booking.com
updatedAt: 2026-04-24T22:46:53.098Z
hostnamePatterns:
  - "www.booking.com"
---

# Skill Proposal: www.booking.com

Auto-generated from run `run_cae1c0c0-5d9c-47e4-b9a5-ea2d6856c8c9` with confidence 0.85.

## Facts

- Booking.com redirects on first load with a challenge token parameter (chal_t) which destroys the execution context — do not attempt to extract data in the same code block as the navigation
- Page title is: 'Booking.com | Official site | The best hotels, flights, car rentals & accommodations'
- Main H1 heading is 'Find deals for any season'
- Navigation triggers a redirect to a URL containing '?chal_t=<timestamp>&force_referer=' before settling on the final page

## Selectors

- `h1, h2, h3 — standard heading selectors work for visible content extraction`
- `Use el.offsetHeight > 0 combined with getComputedStyle display/visibility checks for reliable visible-element filtering`

## Routes

- `https://www.booking.com — main entry point, expect redirect with chal_t challenge token before page settles`

## Wait Patterns

- `After navigating to booking.com, wait for a new page observation (execution context destruction) before running any extraction code — navigate first, then extract in a separate code block`
- `Do not use setTimeout-based waits in the same execution block as location.href navigation — the context will be destroyed`

## Known Traps

- Navigating and extracting in the same code block (using location.href + setTimeout) causes 'Execution context was destroyed' error — always navigate first and extract in a separate subsequent code block
- Booking.com issues a challenge redirect on first visit (chal_t parameter) which reloads the page, destroying any in-flight execution context
