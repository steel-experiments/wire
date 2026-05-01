---
id: skill_68319446-cbb9-441b-bba6-9c58a11a04af
scope: domain
status: proposed
source: generated
confidence: 0.9
sourceRunIds:
  - run_bdc7c5fa-b3b8-4498-80a2-77140329a098
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-05-01
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_bdc7c5fa-b3b8-4498-80a2-77140329a098` with confidence 0.9.

## Facts

- The 2048 game is served at /2048/ with title 'Play 2048 Game: Google-Style Edition - elgooG'.
- Current score is readable from .score-container and best score from .best-container.
- Game end state can be detected via .game-message.game-over and win state via .game-message.game-won.
- Board state is represented by .tile elements whose class names include both tile value (tile-<n>) and position (tile-position-x-y).
- When multiple .tile elements overlap during animations, taking the maximum value per parsed cell yields a stable 4x4 grid.
- Arrow key input works to play the game and changes score/grid state.
- A visible 'Start Bot' button was not found via button text search, and the game already accepted manual keyboard input.
- The page contains many non-game buttons (e.g. menu/theme/easter egg controls), so generic button clicking is noisy and not needed for gameplay.

## Selectors

- `.score-container`
- `.best-container`
- `.game-message.game-over`
- `.game-message.game-won`
- `.tile`
- `.game-container`
- `.grid-container`

## Routes

- `/2048/`

## Wait Patterns

- `After navigation to /2048/, wait for .score-container and .tile elements before reading state.`
- `After sending an Arrow key, wait for tile/score state to change before issuing another move to avoid repeated no-op loops.`

## Known Traps

- Do not rely on finding a 'Start Bot' button by scanning button text; it returned null and was unnecessary.
- Avoid generic mouse clicks on the board/container as a gameplay mechanism; keyboard Arrow keys are the reliable control path.
- Do not treat repeated identical actions as safe progress; the run hit an abort after the same action was attempted 8 times in a row.
- Do not parse board state by blindly counting all .tile elements as distinct cells; animations can create duplicates, so resolve each cell by parsing tile-position-x-y and keeping the max value.
