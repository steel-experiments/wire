---
id: skill_885f38a7-036e-4126-b533-6360b861f8fe
scope: domain
status: proposed
source: generated
confidence: 0.74
sourceRunIds:
  - run_8e2ba9a5-bf22-48a2-9b26-b51c6df0766e
tags:
  - auto-promoted
  - izor.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "izor.hr"
---

# Skill Proposal: izor.hr

Auto-generated from run `run_8e2ba9a5-bf22-48a2-9b26-b51c6df0766e` with confidence 0.74.

## Facts

- To find a staff profile on izor.hr, a site-restricted DuckDuckGo query like `site:izor.hr <name>` can surface the relevant profile page.
- For the target profile, the phone number was present somewhere on the page content even when `document.body.innerText` initially looked noisy; the successful lookup ultimately identified the number 021408053.

## Selectors

- `On the profile page, plain body text extraction via `document.body.innerText` was used to search for phone/email patterns.`

## Routes

- ``https://duckduckgo.com/?q=<encoded name> site%3Aizor.hr&ia=web``
- `Profile route pattern: `https://galijula.izor.hr/djelatnik/<slug>/` (example: `https://galijula.izor.hr/djelatnik/daria-ezgeta-balic/`)`

## Wait Patterns

- `After setting `location.href` to DuckDuckGo, a navigation delay was needed; the initial attempt used a `setTimeout` of 1500 ms, but the execution context was destroyed because the page navigated.`
- `When moving from search results to the target profile, rely on the navigation completing before running DOM queries.`

## Known Traps

- Do not assume code can continue after `location.href = ...` in the same execution context; the first navigation attempt failed with `Execution context was destroyed`.
- Do not assume the first body-text scrape is immediately meaningful; the profile page contained accessibility/navigation text, so regex-based phone extraction may require more targeted inspection if the number is not obvious.
