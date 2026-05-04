---
id: skill_4eee0800-6c98-4d8b-aaf9-5577a98740ef
scope: domain
status: proposed
source: generated
confidence: 0.82
sourceRunIds:
  - run_2f7cdef3-4353-4ecc-bcca-613d6d53b2b3
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-05-04
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_2f7cdef3-4353-4ecc-bcca-613d6d53b2b3` with confidence 0.82.

## Facts

- The 2048 game is at route /2048/ on elgoog.im.
- Game state can be read from DOM without interacting with menus.
- Score and best score are exposed in .score-container and .best-container.
- Game-over and win states are detectable via .game-message.game-over / .game-over and .game-message.game-won / .game-won.
- Current board tiles are available as .tile elements; tile values can be parsed from class names like tile-64 via /tile-(\d+)/, with textContent as a fallback.
- The game responds to keyboard arrow events; traces showed Input.dispatchKeyEvent with ArrowDown affecting gameplay.

## Selectors

- `.score-container`
- `.best-container`
- `.game-message.game-over`
- `.game-over`
- `.game-message.game-won`
- `.game-won`
- `.tile`
- `button`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After navigation to /2048/, wait for .score-container and .tile elements before reading state.`
- `When monitoring progress, poll score/tiles/over state from the DOM rather than relying on button presence.`

## Known Traps

- Searching for buttons labeled 'Start Bot' or 'New Game' was unreliable here; hasStart/hasNew stayed false repeatedly even while the game was active.
- Using button discovery to infer whether the game or bot has started is a bad signal on this page.
- Long-running control via repeated CDP key dispatch/polling ended with Steel CDP WebSocket errors, so keep sessions shorter or checkpoint state frequently.
