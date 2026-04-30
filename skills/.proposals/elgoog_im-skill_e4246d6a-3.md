---
id: skill_e4246d6a-31f8-4c88-bb78-a83ad9853bfa
scope: domain
status: proposed
source: generated
confidence: 0.86
sourceRunIds:
  - run_41fed9c2-7847-498b-8449-9f0d7a8169ac
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_41fed9c2-7847-498b-8449-9f0d7a8169ac` with confidence 0.86.

## Facts

- The 2048 game page at https://elgoog.im/2048/ exposes the game directly in the body DOM and can be controlled by keyboard arrow events.
- The on-page bot control is not reliably labeled as 'Start Bot' in button text; in some states the visible control text changes to 'Stop Bot!' after activation.
- Game state and score can often be read from document.body.innerText rather than from dedicated score elements.

## Selectors

- `button.menu-label`
- `button.back-btn`
- `button:contains('Start Bot')`
- `button:contains('Stop Bot!')`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After clicking the bot/start control, wait about 500-1200 ms before checking for tiles or sending keyboard input.`
- `Use short delays (~80 ms) between synthetic key events when dispatching arrow keys.`

## Known Traps

- Searching only for a button whose text matches /start bot/i can fail because the button text is not stable or may not exist in the current DOM state.
- Dispatching KeyboardEvent to document may not be sufficient for gameplay in this site; the working approach used browser-level input via Input.dispatchKeyEvent.
- Relying on body text patterns like /SCORE\s*\d+/ can be misleading because the page may render the current score in a different format or omit the label entirely.
- The page can start in a state where the game board is already active and the bot control text has changed, so attempting to click 'Start Bot' repeatedly may do nothing.
