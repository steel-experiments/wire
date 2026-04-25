---
id: skill_3e6521b9-0ad7-4353-be7d-d46b6c4a7f63
scope: domain
source: generated
tags:
  - auto-promoted
  - httpbin.org
updatedAt: 2026-04-25
hostnamePatterns:
  - "httpbin.org"
---

# Skill Proposal: httpbin.org

Auto-generated from run `run_44fb3a14-6557-4d35-ac14-1b7256a21e32` with confidence 0.85.

## Facts

- httpbin.org/headers returns a JSON object with a 'headers' key containing all request headers including User-Agent and Accept
- The page renders as plain JSON text in the browser body with no HTML wrapping
- Navigating directly to https://httpbin.org/headers works; the page loads and the JSON is accessible via document.body.innerText
- fetch() is blocked by the Wire framework; direct navigation must be used instead

## Selectors

- `document.body.innerText — contains the raw JSON response for /headers and other httpbin JSON endpoints`

## Routes

- `https://httpbin.org/headers — returns current request headers as JSON`
- `https://httpbin.org/get — returns GET request details as JSON`
- `https://httpbin.org/ip — returns origin IP as JSON`
- `https://httpbin.org/user-agent — returns User-Agent header as JSON`

## Wait Patterns

- `After triggering navigation to httpbin.org, wait for the observation event confirming url=https://httpbin.org/headers before extracting content — the execution context is destroyed during navigation so setTimeout-based waits in the same code block will fail`

## Known Traps

- fetch() calls are blocked by Wire's security policy — use direct navigation instead
- Using location.href assignment with setTimeout in the same code block will fail because the execution context is destroyed mid-navigation — rely on the framework's navigation observation instead
- The page title for httpbin JSON endpoints is empty string, so document.title cannot be used to confirm page load; check location.href in the observation instead
