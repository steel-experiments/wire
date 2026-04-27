---
id: skill_dc3ca777-3b4a-4bf0-bb47-1fed2a346496
scope: domain
status: proposed
source: generated
confidence: 0.83
sourceRunIds:
  - run_e6fd2990-406f-48cc-994c-e5c71def5dd4
tags:
  - auto-promoted
  - weather.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "weather.com"
---

# Skill Proposal: weather.com

Auto-generated from run `run_e6fd2990-406f-48cc-994c-e5c71def5dd4` with confidence 0.83.

## Facts

- Directly navigating to weather.com weather/today location URLs did not reliably render page text in this run; document.body.innerText was empty after waiting.
- A guessed London weather URL returned a 404 Not Found page, so canonical city URL patterns were not validated here.
- Trying to interact after triggering navigation can destroy the execution context; wait for navigation to complete before reading or mutating the page.
- Using fetch from about:blank does not help when the browser has not first navigated to the target site.

## Selectors

- `input[type="search"]`
- `input[placeholder*="Search"]`
- `input`

## Routes

- `https://weather.com/weather/today/l/London+England+United+Kingdom`
- `https://weather.com/weather/today/l/London+England+United+Kingdom?canonicalCityId=...`

## Wait Patterns

- `page.goto(url,{waitUntil:'domcontentloaded'})`
- `wait 5-8 seconds after navigation attempt before reading text`
- `avoid executing DOM reads immediately after location.assign because the execution context may be destroyed`

## Known Traps

- Guessing weather.com city URLs can land on 404 Not Found pages.
- Reading page text on weather.com immediately after navigation may return empty content.
- Using page.goto and then later referring to page in a context where it is undefined causes ReferenceError: page is not defined.
- Triggering location.assign/window.location.href and then continuing to execute in the same context can fail with Execution context was destroyed.
- Submitting search/forms after the page has already navigated away or while the context is being destroyed is unreliable.
