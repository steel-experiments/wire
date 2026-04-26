---
id: skill_7c5fc1bb-61c6-413f-a8b1-c37d4a288786
scope: domain
status: proposed
source: generated
confidence: 0.84
sourceRunIds:
  - run_519c7083-f00d-43ae-9053-40837196f08a
tags:
  - auto-promoted
  - index.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "index.hr"
---

# Skill Proposal: index.hr

Auto-generated from run `run_519c7083-f00d-43ae-9053-40837196f08a` with confidence 0.84.

## Facts

- Index.hr homepage loads with title 'Index.hr'.
- The latest headline can be found in the page body text on the homepage without needing a dedicated article page.
- A reliable way to extract the top news is to split document.body.innerText into non-empty lines and search for the latest prominent headline, optionally near the 'PRIJELOMNA VIJEST' section.

## Routes

- `https://www.index.hr/`

## Wait Patterns

- `Wait a few seconds after navigation for the homepage content to render (about 3 seconds worked in this trace).`

## Known Traps

- A Page.navigate call may report ok=false even though the navigation still proceeds; do not treat that alone as fatal.
- Immediately reading location.href after Page.navigate can still show about:blank; a manual location.href assignment was needed as a fallback.
- Index.hr homepage initially shows cookie/privacy text before news content, so headline extraction should ignore those banner lines.
