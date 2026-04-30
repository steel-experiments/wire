---
id: skill_f4834b71-221f-4d49-ac1c-39997a3e259e
scope: domain
status: proposed
source: generated
confidence: 0.85
sourceRunIds:
  - run_9d8dd6be-1dae-4a4d-9056-af58267d7256
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_9d8dd6be-1dae-4a4d-9056-af58267d7256` with confidence 0.85.

## Facts

- The 2048 game is at route /2048/ on elgoog.im.
- The page exposes standard 2048 DOM structures including .score-container, .best-container, .tile, .tile-inner, .tile-container, and .game-message.game-over.
- Score and best can also be found by locating text labels SCORE and BEST and reading their nextElementSibling.
- Buttons present include a menu button ('MENU Menu') and a back button ('Return'); automation also searched for buttons containing 'new game' and 'start bot'.
- Game-over state can be detected either via .game-message.game-over or body text matching /game over|try again/i.

## Selectors

- `.score-container`
- `.best-container`
- `.tile`
- `.tile-inner`
- `.tile-container`
- `.game-message.game-over`
- `button`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After loading /2048/, wait for score containers or tile elements before interacting.`
- `Long-running in-page async loops are fragile here because the page may reload and destroy the execution context; prefer short polling scripts with re-observation between runs.`

## Known Traps

- A long code-exec script failed with 'Execution context was destroyed', indicating the page can reload mid-script and invalidate DOM handles.
- Repeated follow-up code-exec attempts encountered WebSocket errors, so avoid relying on many successive long browser-side executions in one session.
- A play attempt timed out with score 0 and best 0; don't assume bot/start controls are present or effective without first confirming matching button text exists.
- Using only generic text-search over all elements for state works, but standard 2048 selectors (.score-container, .best-container, .game-message.game-over) are more reliable when available.
