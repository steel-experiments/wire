---
id: skill_ddef643b-1aaf-4ac2-9315-3194f75c5b14
scope: domain
status: proposed
source: generated
confidence: 0.92
sourceRunIds:
  - run_5f9cbcd3-5163-4df3-9db5-8d51e4b86ae2
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_5f9cbcd3-5163-4df3-9db5-8d51e4b86ae2` with confidence 0.92.

## Facts

- The 2048 game is hosted at https://elgoog.im/2048/ and the page title is 'Play 2048 Game: Google-Style Edition - elgooG'.
- The game can be started/activated by clicking a button whose label matches /start bot/i.
- Keyboard arrow key events dispatched to the page can drive gameplay and increase score.
- The page exposes score and best score in elements with classes .score-container and .best-container.
- A game-over state can be detected with .game-message.game-over, and a win state with .game-message.game-won.
- After some moves, the score text may include a bonus-style suffix on a new line (e.g. '108\n+24' or '492\n+16'), so trim or parse carefully.

## Selectors

- `.score-container`
- `.best-container`
- `.tile`
- `.game-message.game-over`
- `.game-message.game-won`
- `button (label matching /start bot/i)`
- `button, .button, a (for restart/new game/refresh after game over)`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After clicking the Start Bot button, wait about 500 ms before reading initial game state.`
- `After dispatching a batch of keyboard moves, wait about 700 ms before checking score/state.`
- `If reloading after game over, wait about 1200 ms for the board to come back.`

## Known Traps

- Do not assume the score text is a plain integer; it may include a newline and incremental delta text like '492\n+16'.
- Do not rely on game over being present; in this run it was false, so code should handle both active and terminal states.
- Do not use only document.body keyboard dispatch if targeting the game specifically; dispatching to .game-container or document both appeared to work, but use bubbling KeyboardEvent with proper key/keyCode/which values.
- Do not expect the Start Bot click to immediately change the score; the board may still show score 0 and 2 tiles right after activation.
