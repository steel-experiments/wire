---
id: skill_9d7a084b-9654-4b5b-827c-ae91f60f78cd
scope: domain
status: proposed
source: generated
confidence: 0.87
sourceRunIds:
  - run_7624f4fd-d4a4-4471-9e37-0dab3f407004
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-27
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_7624f4fd-d4a4-4471-9e37-0dab3f407004` with confidence 0.87.

## Facts

- The 2048 game is available at https://elgoog.im/2048/ and the loaded page title is 'Play 2048 Game: Google-Style Edition - elgooG'.
- The page body text includes the 2048 heading and game UI elements, which can be used to confirm the game loaded successfully.

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After navigation, verify readiness by checking document.title and that body text includes '2048' before proceeding.`

## Known Traps

- Do not assume the page is ready immediately after setting window.location.href; confirm via title/body text first.
