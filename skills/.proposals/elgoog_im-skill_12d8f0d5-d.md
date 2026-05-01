---
id: skill_12d8f0d5-d0c6-422d-94be-ebfafcb5f568
scope: domain
status: proposed
source: generated
confidence: 0.89
sourceRunIds:
  - run_c59eb9ce-52d8-47d0-8198-96c03f289db3
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-05-01
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_c59eb9ce-52d8-47d0-8198-96c03f289db3` with confidence 0.89.

## Facts

- The 2048 game is available at the route /2048/.
- Game state can be read directly from DOM elements without interacting with a canvas.
- After gameplay, .score-container text may include a transient gain suffix like '96+8'; .best-container provides the best score separately.
- Game-over and win states are exposed via .game-message.game-over and .game-message.game-won.
- Tiles are represented as .tile elements whose class names encode value and position, e.g. tile-2 and tile-position-x-y.

## Selectors

- `.score-container`
- `.best-container`
- `.game-message.game-over`
- `.game-message.game-won`
- `.tile`
- `.game-container`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After navigation to /2048/, wait until .score-container and initial .tile elements are present before reading state.`
- `After dispatching arrow-key moves, wait briefly for DOM updates/animations before re-reading score and tiles.`

## Known Traps

- Do not rely on a 'Start Bot' button existing; although attempted, no such button was found in the successful state (started:false).
- Do not parse .score-container as a plain integer without cleaning, because it can contain bonus text like '+8' appended to the current score.
- Avoid assuming focus is unnecessary; key input was sent after focusing .game-container or falling back to document.body.
