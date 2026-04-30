---
id: skill_d1e7be8a-d3c1-4eea-8810-35e5e119eae3
scope: domain
status: proposed
source: generated
confidence: 0.91
sourceRunIds:
  - run_2e277151-3d5d-4d47-86da-5aa43fca40a5
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_2e277151-3d5d-4d47-86da-5aa43fca40a5` with confidence 0.91.

## Facts

- The 2048 game is directly reachable at https://elgoog.im/2048/.
- The page exposes score and best values in .score-container and .best-container.
- Game tiles are represented by .tile elements whose class list includes value classes like tile-2 and position classes like tile-position-1-2.
- A fresh game session can already contain two starting tiles before any input.
- Arrow key input via Input.dispatchKeyEvent successfully advances the game and changes score/tiles.
- The page may contain a button with text matching /start bot/i, but gameplay does not require it for human-play verification.

## Selectors

- `.score-container`
- `.best-container`
- `.tile`
- `.game-message.game-over`
- `.game-message.game-won`
- `.game-over`
- `.score`
- `.best`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After navigating to /2048/, wait for .score-container or .tile to appear before reading state.`
- `After sending arrow-key events, re-read .tile and score selectors to confirm the board changed.`

## Known Traps

- Reading .score-container after play may return concatenated bonus text like "68+8" rather than a pure numeric score.
- Do not rely only on .score or .best; prefer .score-container and .best-container, with fallbacks if needed.
- Do not assume the /start bot/i button is necessary; clicking it may trigger automation unrelated to the objective.
