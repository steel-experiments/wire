---
id: skill_8f8caa5f-0662-4a73-893c-778e3ef80468
scope: domain
status: proposed
source: generated
confidence: 0.85
sourceRunIds:
  - run_751c50de-35a8-4b7d-83ea-8c421f246cd8
tags:
  - auto-promoted
  - www.grants.gov
updatedAt: 2026-05-01
hostnamePatterns:
  - "www.grants.gov"
---

# Skill Proposal: www.grants.gov

Auto-generated from run `run_751c50de-35a8-4b7d-83ea-8c421f246cd8` with confidence 0.85.

## Facts

- Directly navigating to grants search/result URLs often lands back on the Grants.gov home page instead of a results page, suggesting client-side routing or redirect behavior blocks simple deep-link automation.
- The home page contains a site search form with an input of type search named 'search' and id 'search-field'.
- Searching from the home page by filling the site search box and clicking a generic 'Search' button did not reliably reach grant opportunity results for a keyword query.
- A likely internal/search endpoint was probed at /grantsws/rest/opportunities/search/?keyword=...&oppStatus=posted, but fetch returned not-ok/empty in this run, so it should not be relied on without separate verification.

## Selectors

- `form[action='https://www.grants.gov/'] input[type='search'][name='search']#search-field`
- `input[type='search'], input[placeholder*='Search' i], input[name*='search' i]`
- `a[href*='search-results-detail/keyword/']`

## Routes

- `https://www.grants.gov/search-results-detail?keyword={query}`
- `https://www.grants.gov/search-results-detail/keyword/{query}`
- `https://www.grants.gov/search-results-detail?keyword={query}&status=posted`
- `https://www.grants.gov/grantsws/rest/opportunities/search/?keyword={query}&oppStatus=posted`

## Known Traps

- Do not assume deep links like /search-results-detail?keyword=... or /search-results-detail/keyword/... will remain on that page; in this run they repeatedly resolved back to the home page.
- Do not rely on clicking the homepage site-search control to find grants opportunities by keyword; it clicked successfully but stayed on https://www.grants.gov/ and did not produce usable results.
- Do not infer API availability from page source asset URLs; CSS/JS matches for 'Search' or 'SearchResultsDetail' were not actionable endpoints.
- A direct fetch to https://www.grants.gov/grantsws/rest/opportunities/search/?keyword=artificial%20intelligence&oppStatus=posted was unsuccessful here, so avoid repeating it as a primary strategy.
- A script-based fetch attempt against guessed candidate URLs threw an uncaught error; avoid depending on ad hoc cross-page fetch probing without error handling.
