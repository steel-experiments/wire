---
id: skill_cac5a341-bd4a-4f11-b28e-a996921b0a00
scope: domain
status: proposed
source: generated
confidence: 0.83
sourceRunIds:
  - run_d407836b-f53a-49db-ac81-6413d60f4390
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-05-15
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_d407836b-f53a-49db-ac81-6413d60f4390` with confidence 0.83.

## Facts

- The 2048 game is available at the route /2048/ on elgoog.im.
- Useful game UI elements include .score-container and .best-container for current score and best score.
- A successful run can read multiple completed plays and confirm the current game is still active by checking over=false and won=false in collected run state.
- The bot control may be labeled either 'Start Bot' or 'Stop Bot' depending on current state, so selectors should match both.

## Selectors

- `.score-container`
- `.best-container`
- `button,input[type="button"],a matched by /new game/i`
- `button,input[type="button"],a matched by /start bot|stop bot/i`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After navigating to /2048/, wait for the actual 2048 game controls to render before querying buttons or score elements.`
- `If initial DOM text shows site-wide menu content instead of game controls, retry after the embedded game finishes loading.`

## Known Traps

- Querying controls immediately after navigation can fail with 'controls not found' because the page may still show generic site content rather than the loaded game.
- Looking only for a 'Start Bot' button is insufficient; once active, the control text may change to 'Stop Bot'.
- Broad DOM inspection too early can cause long evaluations or CDP Runtime.evaluate timeouts; keep probes short and wait for game elements first.
