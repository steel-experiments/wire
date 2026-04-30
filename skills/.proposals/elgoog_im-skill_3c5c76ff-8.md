---
id: skill_3c5c76ff-837d-4676-86a7-bb776ba19a51
scope: domain
status: proposed
source: generated
confidence: 0.86
sourceRunIds:
  - run_6cb42818-03b3-41ca-826c-569ddb9c4bd6
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_6cb42818-03b3-41ca-826c-569ddb9c4bd6` with confidence 0.86.

## Facts

- The 2048 game is hosted at https://elgoog.im/2048/ and loads as a browser-playable page titled 'Play 2048 Game: Google-Style Edition - elgooG'.
- The page includes both keyboard-play and an on-page automation control labeled 'Start Bot' plus a 'New Game' button in the visible text.
- Game state may be harder to read from explicit score elements; body text can include the board cells and menu items, but score/best were not reliably extractable from the DOM used in the trace.

## Selectors

- `button`
- `button, [role="button"], .btn`
- `.game-container, .game`
- `canvas`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After clicking UI controls like Start Bot or New Game, wait about 500-800 ms before re-reading page state.`
- `Keyboard input was sent as paired keydown/keyup events on document; repeated move sequences may need a short pause between attempts if automation depends on UI updates.`

## Known Traps

- Simply dispatching ArrowUp/ArrowLeft/ArrowDown/ArrowRight keydown/keyup events on document did not reliably start or reset the game.
- Clicking a 'New Game' control by text search often failed because the expected button was not found in the queried DOM at that moment, even though 'New Game' appeared in page text.
- Searching for a 'Start Bot' button and clicking it did not start the bot in this run.
- Reading score/best via regex from body text timed out once and generally returned null, so do not rely on simple SCORE/BEST text extraction here.
- The run got stuck repeating the same action; if progress stalls after several identical attempts, re-plan instead of looping.
