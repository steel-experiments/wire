---
id: skill_6d236a92-e421-4759-af6c-3f79c9dada74
scope: domain
status: proposed
source: generated
confidence: 0.89
sourceRunIds:
  - run_a1fc80bb-c051-4285-a2b5-6bb12f3e75cb
tags:
  - auto-promoted
  - duckduckgo.com
updatedAt: 2026-04-27
hostnamePatterns:
  - "duckduckgo.com"
---

# Skill Proposal: duckduckgo.com

Auto-generated from run `run_a1fc80bb-c051-4285-a2b5-6bb12f3e75cb` with confidence 0.89.

## Facts

- DuckDuckGo search results pages can be queried directly with a `q` parameter, e.g. `https://duckduckgo.com/?q=price+of+steel&ia=web`.
- A search results page’s `document.body.innerText` can contain the needed answer directly without further clicking.
- For this query, the relevant steel price was extracted from result text using a regex matching `Steel rose to ([0-9.,]+\s*[A-Z]{3}\/T)`.

## Routes

- `https://duckduckgo.com/?q=<encoded query>&ia=web`
