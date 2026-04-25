---
id: skill_d8129b5b-1ee0-4e7a-bf2f-dd91dbcd150a
scope: domain
source: generated
tags:
  - auto-promoted
  - www.booking.com
updatedAt: 2026-04-25
hostnamePatterns:
  - "www.booking.com"
---

# Skill Proposal: www.booking.com

Auto-generated from run `run_a627db4e-0beb-4718-a2ea-278f12845a6b` with confidence 0.82.

## Facts

- Search results page loads with challenge/captcha parameters appended to URL (chal_t, force_referer) but still renders results
- Navigation via window.location.href destroys execution context; subsequent code-exec steps work fine after waiting
- Hotel data is available in the DOM after ~3 seconds of waiting post-navigation
- At least 5 property cards were present for Tokyo search with dates 2026-06-10 to 2026-06-12

## Selectors

- `[data-testid="property-card"] — top-level container for each hotel listing`
- `[data-testid="title"] inside property-card — hotel name`
- `[data-testid="price-and-discounted-price"] or similar price element inside property-card — nightly/total price`

## Routes

- `Search results: https://www.booking.com/searchresults.html?ss={city}&checkin={YYYY-MM-DD}&checkout={YYYY-MM-DD}`

## Wait Patterns

- `After window.location.href navigation, execution context is destroyed; the next code-exec block should wait ~3000ms before querying the DOM`
- `Total recommended wait after navigation before scraping: 3000ms (content is rendered by then)`

## Known Traps

- window.location.href navigation always destroys the execution context — ok=false error is expected and harmless; do not retry navigation, just proceed with next code-exec
- Booking.com appends challenge parameters (chal_t, force_referer) to the URL automatically; these do not block content loading
- Do not rely on the navigation code-exec return value; always use a fresh code-exec block to read results
