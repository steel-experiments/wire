---
id: skill_6975f69e-9050-43a4-9e78-74614bb9f07e
scope: domain
status: active
source: generated
confidence: 0.92
sourceRunIds:
  - run_d44b08a0-a921-4406-9416-24bea92bf192
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-05-20
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_d44b08a0-a921-4406-9416-24bea92bf192` with confidence 0.92.

## Workflow

1. Step 1: Navigate to https://example.com.
2. Step 2: After navigation completes, read document.title and document.querySelector('p')?.innerText?.trim() from the loaded page.
3. Step 3: Save the result as markdown in example-summary.md using format `# {title}` followed by the first paragraph.

## Facts

- The page title is available as `document.title` after load.
- The first paragraph can be extracted with `document.querySelector('p')?.innerText?.trim()`.
- The final URL resolves to `https://example.com/`.

## Selectors

- `p`

## Routes

- `https://example.com/`

## Wait Patterns

- `Run extraction only after navigation/load has completed; a separate post-navigation evaluation worked reliably.`

## Known Traps

- Do not combine `location.href = 'https://example.com'` navigation with a pending `load` listener and artifact return in the same code execution; it failed with `Inspected target navigated or closed`.
- Avoid relying on a single eval that both triggers navigation and waits for load, because the execution context may be destroyed on navigation.
