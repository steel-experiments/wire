---
id: skill_f4b87686-811b-4efd-a96c-5751be081237
scope: domain
status: proposed
source: generated
confidence: 0.78
sourceRunIds:
  - run_0c4efda8-49f7-4170-abf1-4309ec151230
tags:
  - auto-promoted
  - duckduckgo.com
updatedAt: 2026-04-27
hostnamePatterns:
  - "duckduckgo.com"
---

# Skill Proposal: duckduckgo.com

Auto-generated from run `run_0c4efda8-49f7-4170-abf1-4309ec151230` with confidence 0.78.

## Facts

- Searching DuckDuckGo for a broad query like 'hajduk' can surface the relevant entity directly in the web results.
- The intended result in this run was HNK Hajduk Split, a Croatian professional football club based in Split.

## Routes

- `https://duckduckgo.com/?q=hajduk&ia=web`

## Known Traps

- Setting location.href to a DuckDuckGo search URL returned immediately with the old page state in the code result; rely on the subsequent navigation/observation rather than the synchronous return value.
- Avoid assuming the first broad search result is unrelated; for 'hajduk', the search result can directly identify HNK Hajduk Split.
