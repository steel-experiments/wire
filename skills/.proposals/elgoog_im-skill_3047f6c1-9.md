---
id: skill_3047f6c1-9219-48dc-987e-7d0c8a90e88f
scope: domain
status: proposed
source: generated
confidence: 0.86
sourceRunIds:
  - run_a6bb36ca-cf17-4b5a-8f35-8ba44f87523b
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_a6bb36ca-cf17-4b5a-8f35-8ba44f87523b` with confidence 0.86.

## Facts

- The 2048 page at https://elgoog.im/2048/ has a visible bot control labeled 'Start Bot' that changes to 'Stop Bot!' once active.
- The page title is 'Play 2048 Game: Google-Style Edition - elgooG'.
- The game can be driven by synthetic keyboard events dispatched to document (keydown/keyup) using ArrowUp, ArrowLeft, ArrowDown, ArrowRight.
- A simple alternating arrow pattern can advance the game for many moves without immediate game over.
- The page exposes score text in the body and sometimes shows score updates like 'SCORE' / numeric score near the top, but direct score extraction via a specific selector was unreliable.
- The page body text includes the main instructions and controls, and 'Start Bot' may be present in body text even when not found through a button query if the control is rendered differently or covered by menu state.

## Selectors

- `button.menu-label`
- `input.menu-toggle-checkbox#button-check`
- `button:has-text('Start Bot')`
- `button:has-text('New Game')`
- `button:has-text('Toggle light/dark theme')`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After clicking Start Bot, wait briefly (~300ms+) before checking whether the label changed to 'Stop Bot!' or before sending moves.`
- `When sending key events, small delays between moves (about 30-35ms) were sufficient for gameplay progression.`

## Known Traps

- Searching only document.querySelectorAll('button') for 'Start Bot' can fail because the control may be in a different rendered state or obscured by menu/overlay text.
- Looking for 'Start Bot' after the bot is already running will fail because the label becomes 'Stop Bot!'.
- A generic Runtime.evaluate script that tries to read score via complex selectors or loops can time out after 30s on this page.
- Dispatching only keydown without keyup can be less reliable; the successful approach used both keydown and keyup events.
- Assuming the start control is always a standard visible button with exact text can lead to false negatives; checking broader elements or body text worked better.
