---
id: skill_30ee9bb9-9a34-4887-a0fb-b08693382232
scope: domain
source: generated
tags:
  - auto-promoted
  - booking.com
updatedAt: 2026-04-24T21:31:30.210Z
hostnamePatterns:
  - "booking.com"
---

# Skill Proposal: booking.com

Auto-generated from run `run_81dd047a-b8f2-4bb1-8985-dac2bb18fcf4` with confidence 0.75.

## Facts

- Search results page loads with challenge token (chal_t parameter)
- Price extraction requires searching multiple container types, not a single dedicated selector
- [data-testid="property-card"] reliably identifies individual hotel cards
- Hotel names found in [data-testid="title"] elements
- Price data may not be in [data-testid="price"] but in role="heading" or .ps-2 containers
- Initial execution context destruction occurs during navigation, retry after page load

## Selectors

- `[data-testid="property-card"]`
- `[data-testid="title"]`
- `[role="heading"]`
- `.ps-2`

## Routes

- `https://www.booking.com/searchresults.html?ss={location}&checkin={checkin_date}&checkout={checkout_date}&group_adults={adults}&no_rooms={rooms}`

## Wait Patterns

- `5000ms after navigation to search results page`
- `Page load wait necessary after challenge token redirect`

## Known Traps

- Execution context destroyed on initial navigation - requires retry logic
- [data-testid="price"] selector returns N/A - price is in alternative containers
- Price extraction needs fallback selectors: role="heading" or .ps-2 classes
