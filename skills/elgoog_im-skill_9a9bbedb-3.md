---
id: skill_9a9bbedb-3e73-426e-a110-81010b78353b
scope: domain
status: active
source: generated
confidence: 0.9
sourceRunIds:
  - run_bbb98d7c-1e1b-410d-badf-01b90c053220
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-05-20
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_bbb98d7c-1e1b-410d-badf-01b90c053220` with confidence 0.9.

## Workflow

1. Step 1: Navigate directly to https://elgoog.im/2048/.
2. Step 2: Play the game by dispatching arrow-key events (e.g. ArrowUp, ArrowRight, ArrowDown, ArrowLeft) via Input.dispatchKeyEvent to the page.
3. Step 3: Read .score-container for the score and .tile .tile-inner or .tile-inner for tile values.
4. Step 4: Build the JSON snapshot artifact with site, score, and maxTile.

## Facts

- The 2048 game is available directly at /2048/ on elgoog.im.
- The page title for the game is 'Play 2048 Game: Google-Style Edition - elgooG'.
- A simple dispatched arrow-key sequence successfully advances gameplay without needing visible button clicks.
- Score can be parsed from the first text node of .score-container.
- Tile values are exposed in DOM text within .tile .tile-inner or .tile-inner elements.

## Selectors

- `.score-container`
- `.tile .tile-inner`
- `.tile-inner`
- `iframe`
- `.game-container`
- `#game`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Wait for navigation to https://elgoog.im/2048/ to complete before sending key events.`
- `After sending a batch of key events, wait briefly for the DOM/score to update before scraping score and tile values.`

## Known Traps

- Do not rely on iframe, .game-container, or #game as the primary interaction target; they were only probed and the successful approach was sending page-level keyboard events directly.
- Do not require clicking into the board first when using Input.dispatchKeyEvent; the trace succeeded without a focus-click step.
