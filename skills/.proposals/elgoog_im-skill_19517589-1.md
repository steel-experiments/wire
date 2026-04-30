---
id: skill_19517589-11ee-4995-91e5-c0bd07e13270
scope: domain
status: proposed
source: generated
confidence: 0.9
sourceRunIds:
  - run_3fe6941d-5700-4de9-8918-34425548f4b0
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_3fe6941d-5700-4de9-8918-34425548f4b0` with confidence 0.9.

## Facts

- The 2048 game is reachable at https://elgoog.im/2048/ and the page title is 'Play 2048 Game: Google-Style Edition - elgooG'.
- The interface exposes a visible Start Bot button and a New Game button in the page body text.
- Keyboard-based play works by dispatching document-level keydown events with ArrowUp/ArrowRight/ArrowDown/ArrowLeft.
- A repeating directional pattern can keep the game advancing for many moves without immediately ending the game.

## Selectors

- `button text matching /start bot/i`
- `button text matching /new game/i`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Wait about 250-500 ms after clicking Start Bot or New Game before sending arrow-key input.`
- `Short delays of about 35-40 ms between simulated key presses were used successfully.`

## Known Traps

- Querying score/best from body text using /SCORE\s*(\d+)/i and /BEST\s*(\d+)/i did not work on this page; scoreText and bestText remained null.
- Searching for a /start bot/i button sometimes returned false because the bot was not in a state needing restart; don't assume it is always present/active.
- Attempts to detect game over by reading body text or a game-over banner often returned false even after many moves; the page may not expose a reliable textual game-over indicator.
- Some longer evaluation loops timed out after 30s, so overly large DOM-processing or never-ending loops can fail.
- A WebSocket error occurred during a later long-running attempt, so repeated automated play can become unstable.
