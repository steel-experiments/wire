---
id: skill_f51d528e-b11c-4b0d-84f2-d1d3df79487f
scope: domain
status: active
source: generated
confidence: 0.94
sourceRunIds:
  - run_538954ab-4b53-47a1-9ee7-0fe3874300d5
tags:
  - auto-promoted
  - httpbin.org
updatedAt: 2026-05-20
hostnamePatterns:
  - "httpbin.org"
---

# Skill Proposal: httpbin.org

Auto-generated from run `run_538954ab-4b53-47a1-9ee7-0fe3874300d5` with confidence 0.94.

## Workflow

1. Step 1: Navigate directly to https://httpbin.org/headers.
2. Step 2: After the page finishes navigation, read document.body.innerText and parse it as JSON.
3. Step 3: Extract parsed.headers['User-Agent'] and parsed.headers['Accept'] and build the output JSON artifact.

## Facts

- The /headers route returns JSON in the page body that can be parsed directly from document.body.innerText.
- Useful fields are under the top-level headers object, including 'User-Agent' and 'Accept'.
- A reliable artifact shape used in the run was { site: 'Httpbin', userAgent, accept }.

## Selectors

- `document.body.innerText`

## Routes

- `https://httpbin.org/headers`

## Wait Patterns

- `Wait until navigation to /headers completes before executing DOM-reading/parsing code.`

## Known Traps

- Combining location.href navigation and JSON extraction in a single code execution failed with 'Inspected target navigated or closed'. Do navigation first, then run extraction in a separate step.
- Do not parse the body before the page has completed navigation/loading.
