---
id: skill_859f8b8a-3f2a-41df-893e-7f84b562f1bc
scope: domain
status: proposed
source: generated
confidence: 0.67
sourceRunIds:
  - run_625c70d4-95d0-4fa4-b45f-b189311ff270
tags:
  - auto-promoted
  - news.ycombinator.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "news.ycombinator.com"
---

# Skill Proposal: news.ycombinator.com

Auto-generated from run `run_625c70d4-95d0-4fa4-b45f-b189311ff270` with confidence 0.67.

## Facts

- Hacker News is reachable at https://news.ycombinator.com/ and loads with title 'Hacker News'.
- A verification step can safely capture page state using document.title, location.href, and document.body.innerText for debugging or task confirmation.

## Routes

- `https://news.ycombinator.com/`

## Known Traps

- The run failed because the model returned an invalid action payload: 48 points; this suggests downstream action formatting/serialization can break the workflow even when navigation succeeds.
