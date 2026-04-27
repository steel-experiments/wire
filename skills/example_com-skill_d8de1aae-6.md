---
id: skill_d8de1aae-630c-4126-9bc9-50e145bf3097
scope: domain
status: active
source: generated
confidence: 0.93
sourceRunIds:
  - run_e356c8ec-7715-41fd-99de-e90f99a958c4
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_e356c8ec-7715-41fd-99de-e90f99a958c4` with confidence 0.93.

## Facts

- Navigating directly with window.location.href can destroy the execution context before async polling completes; avoid starting a long-running check in the same script that triggers navigation.
- For simple verification tasks on static pages, capturing current page state with document.title, location.href, and document.body.innerText is sufficient evidence.
- The target page at https://example.com/ is the standard Example Domain page.

## Selectors

- `h1`

## Routes

- `https://example.com/`

## Wait Patterns

- `After navigation, wait for the new document to load before querying the DOM; the prior context may be destroyed immediately after setting window.location.href.`
- `Polling for a heading can work only after the page is fully loaded, but in this run the reliable approach was to inspect the already-loaded document state instead.`

## Known Traps

- Do not combine window.location.href navigation and DOM polling in one execution context; it resulted in 'Execution context was destroyed.'
- Do not assume the old page context remains valid after navigation; any pending promise or setTimeout-based check may fail during the transition.
