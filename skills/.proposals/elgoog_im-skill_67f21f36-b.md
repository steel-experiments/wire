---
id: skill_67f21f36-bc58-4818-b1b7-1ae22a380b7b
scope: domain
status: proposed
source: generated
confidence: 0.86
sourceRunIds:
  - run_d2342586-6e4a-4205-aefc-2de58fd243b5
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_d2342586-6e4a-4205-aefc-2de58fd243b5` with confidence 0.86.

## Facts

- The 2048 game page at https://elgoog.im/2048/ can be controlled by clicking the visible 'Start Bot' control; once active, the UI changes to 'Stop Bot!' and 'New Game' remains available.
- A robust way to trigger the game controls is to query broadly with selectors like 'button, [role="button"], a' and match by visible text, because the buttons may not be found with button-only queries in some states.
- The page body text contains useful state indicators such as the score and the presence of 'Start Bot', 'Stop Bot!', and 'New Game', which can be used for verification.
- Direct keyboard dispatch attempts did not reliably progress the automation when targeted at the wrong document target, and some runs only needed clicking the bot control instead.

## Selectors

- `button, [role="button"], a`
- `button`
- `[class*="board"]`
- `.game-container`
- `.game-board`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After clicking 'Start Bot', wait about 1000-1500ms for the bot/game UI to initialize before checking state.`
- `After 'New Game' or refresh actions, wait around 1200ms or longer for the board to re-render.`
- `Reloading the page destroys the execution context; avoid awaiting further in the same script after location.reload().`

## Known Traps

- Querying only document.querySelectorAll('button') can miss the relevant controls when the page is in certain overlay/menu states; use broader queries and text matching instead.
- Attempting to locate 'Start Bot'/'New Game' with exact button text can fail because the controls may not be present as simple buttons at that moment.
- Dispatching keyboard events alone was not a reliable way to start or control the game in this trace.
- Running long scripts after calling location.reload() caused 'Execution context was destroyed.'
- A board-focused script timed out after 30s, so heavy iterative game logic or waits inside one evaluate call are risky on this page.
