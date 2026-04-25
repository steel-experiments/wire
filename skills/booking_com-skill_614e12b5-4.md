---
id: skill_614e12b5-438a-44ca-958c-d04fd71d6c0e
scope: domain
source: generated
tags:
  - auto-promoted
  - booking.com
updatedAt: 2026-04-25
hostnamePatterns:
  - "booking.com"
---

# Skill Proposal: booking.com

Auto-generated from run `run_962ca5be-3fdd-4143-b47b-dd726416bf0e` with confidence 0.85.

## Facts

- Hotel search results are paginated with property cards
- Nightly prices are displayed for each hotel listing
- Search parameters support checkin/checkout dates in YYYY-MM-DD format
- Search supports group_adults and group_children parameters
- Results load dynamically after navigation

## Selectors

- `[data-testid="property-card"]`
- `div[data-testid="title"]`
- `span[data-testid="price-and-discounted-price"]`

## Routes

- `https://www.booking.com/searchresults.html?ss={location}&checkin={checkin_date}&checkout={checkout_date}&group_adults={adults}&no_rooms={rooms}&group_children={children}`

## Wait Patterns

- `5 second wait recommended after navigation to search results before extracting hotel data`

## Known Traps

- Price text includes currency symbols that may need parsing
- Hotel names may contain special characters or Unicode
- Some listings may have missing price or name data (handle with 'N/A' fallback)
