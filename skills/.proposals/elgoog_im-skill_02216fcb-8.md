---
id: skill_02216fcb-81a1-4173-a616-99328c8cad48
scope: domain
status: proposed
source: generated
confidence: 0.86
sourceRunIds:
  - run_c5480256-e468-4539-8c60-ce95e4e65219
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_c5480256-e468-4539-8c60-ce95e4e65219` with confidence 0.86.

## Facts

- On elgoog.im/2048 the page title is 'Play 2048 Game: Google-Style Edition - elgooG'.
- The game's visible score/best text may appear as plain '00' in the body text rather than 'SCORE 0'/'BEST 0'; regexes for SCORE/BEST can fail.
- The page includes a 'Start Bot' button, but clicking it may not actually start or be detectable from DOM text alone.
- The 2048 board and instructions are present in body text immediately after load, including 'Slide, merge, and reach the 2048 tile!' and 'HOW TO PLAY'.
- Keyboard control attempts via dispatching synthetic Arrow key events did not produce reliable observable state changes in this run.

## Selectors

- `button:contains('Start Bot')`
- `button with text matching /start bot/i`
- `document.body.innerText for game state and instructions`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After interacting with 'Start Bot', short waits of 500-1000ms were used before reading state.`
- `The run relied on reading body text after actions rather than waiting for a dedicated score element.`

## Known Traps

- Using regexes for /SCORE\s*(\d+)/i and /BEST\s*(\d+)/i returned null on this page because the visible score rendered as '00'.
- Clicking 'Start Bot' via querySelectorAll('button') sometimes failed to find the button or did not change the page state in a detectable way.
- Dispatching synthetic KeyboardEvent('keydown'/'keyup') for ArrowUp/Left/Down/Right did not reliably drive the game.
- Repeated automated key-sending loops caused CDP Runtime.evaluate timeouts.
- Some attempts to click or drive the bot led to WebSocket errors, so retry-heavy automation is fragile here.
