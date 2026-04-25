---
id: skill_952628bf-cbbd-4764-93e2-f70f4c0b9083
scope: domain
source: generated
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-04-25
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_12dd8aef-4dd6-47dd-be4a-f0995232554c` with confidence 0.75.

## Facts

- example.com is a real domain maintained by IANA for documentation and illustrative examples
- The page body contains minimal text: 'Example Domain' heading plus a short description and 'Learn more' link
- No authentication or cookies required to access

## Selectors

- `document.title => 'Example Domain'`
- `document.body.innerText contains 'Example Domain'`
- `a[href='https://www.iana.org/domains/reserved'] — the 'Learn more' link`

## Routes

- `https://example.com/ — single static page, no subpages of significance`

## Wait Patterns

- `Navigation from about:blank via window.location.href destroys the execution context; always await a fresh page observation before executing further code rather than resolving in the same script`

## Known Traps

- Setting window.location.href and then trying to read document state in the same script execution will fail with 'Execution context was destroyed' — split navigation and extraction into separate code blocks
