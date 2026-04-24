---
id: skill_e6e2d30b-4faf-474f-b701-300296600fea
scope: domain
source: generated
tags:
  - auto-promoted
  - booking.com
updatedAt: 2026-04-24T21:11:28.834Z
hostnamePatterns:
  - "booking.com"
---

# Skill Proposal: booking.com

Auto-generated from run `run_79c2c983-366b-444a-a3da-3c979d9510dc` with confidence 0.75.

## Facts

- Search results page loads with query parameters for destination (ss), check-in date (checkin), and check-out date (checkout)
- Additional parameters chal_t and force_referer are added during page load
- Hotel listings are rendered as property cards on the results page

## Selectors

- `[data-testid="property-card"]`
- `[data-testid="title"]`
- `[data-testid="price-and-discounted-price"]`

## Routes

- `https://www.booking.com/searchresults.html?ss={destination}&checkin={checkin_date}&checkout={checkout_date}`

## Wait Patterns

- `5000ms delay recommended before querying hotel elements to allow page rendering`

## Known Traps

- WebSocket errors may occur during data extraction - consider retry logic
- Dynamic parameters (chal_t, force_referer) are added by the page and should be handled gracefully
