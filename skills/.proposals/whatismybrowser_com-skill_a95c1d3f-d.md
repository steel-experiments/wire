---
id: skill_a95c1d3f-dd95-4aed-903c-1372f3d525cf
scope: domain
status: proposed
source: generated
confidence: 0.79
sourceRunIds:
  - run_6bc8958e-afe8-4950-ac63-4898b8830db7
tags:
  - auto-promoted
  - whatismybrowser.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "whatismybrowser.com"
---

# Skill Proposal: whatismybrowser.com

Auto-generated from run `run_6bc8958e-afe8-4950-ac63-4898b8830db7` with confidence 0.79.

## Facts

- For simple page changes in this environment, assigning window.location.href can successfully navigate when page.goto/page is unavailable.
- The target site can be read after navigation by checking document.body.innerText from the loaded page.

## Routes

- `https://www.whatismybrowser.com/`

## Wait Patterns

- `After setting window.location.href, allow the navigation to complete before reading the page.`

## Known Traps

- Do not rely on page.goto in the code-exec context here; it failed with Uncaught and then page was not defined.
- Avoid assuming the `page` object is available inside injected code; use window/location-based navigation instead.
- The initial regex/text extraction attempt after direct navigation failed, so verify that the page has actually loaded before parsing text.
