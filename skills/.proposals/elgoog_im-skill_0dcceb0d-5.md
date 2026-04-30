---
id: skill_0dcceb0d-5252-48e8-bec3-1246199ccd01
scope: domain
status: proposed
source: generated
confidence: 0.87
sourceRunIds:
  - run_d58f5561-25b8-4ec3-81d3-567982631c60
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_d58f5561-25b8-4ec3-81d3-567982631c60` with confidence 0.87.

## Facts

- The 2048 game page is at /2048/ and uses standard 2048-style DOM classes for score, best score, tiles, and game status.
- Score can be read from .score-container and best score from .best-container.
- Game-over state is exposed via .game-message.game-over; win state via .game-message.game-won.
- Tile values are available from .tile elements by parsing their textContent.
- Button text matching /start bot/i and /new game/i may exist initially, but later checks showed hasStartBot:false, so automation should not rely on a persistent Start Bot button.
- The score/best containers may concatenate extra text, so stripping non-digits from textContent is a workable extraction approach, though it can misread values if bonus increments are included in the same container text.

## Selectors

- `.score-container`
- `.best-container`
- `.game-message.game-over`
- `.game-message.game-won`
- `.game-message`
- `.tile`
- `button:text(/start bot/i)`
- `button:text(/new game/i)`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Wait for navigation to complete to https://elgoog.im/2048/ before querying DOM.`
- `After dispatching arrow-key inputs, poll score/maxTile/game-over state from the DOM rather than assuming immediate updates.`
- `If looking for optional controls like Start Bot or New Game, check for their presence dynamically because they may not always be available.`

## Known Traps

- Do not assume a runner/history object exists or has arrays populated; attempts to read .length on undefined caused TypeError.
- Do not rely on a persistent 'Start Bot' button; later state reported hasStartBot:false even though it was initially found.
- Be careful parsing .score-container/.best-container with replace(/\D/g,''): the page can expose text that leads to inflated readings (e.g. score 9368 while best 936, later 18924 while best 1892), likely due to concatenated bonus text.
- Avoid assuming fallback selectors .score or .best are the canonical source; .score-container and .best-container are the consistent selectors observed.
- The run ended with WebSocket errors, so long-lived control loops should tolerate transport interruption and persist intermediate state externally if needed.
