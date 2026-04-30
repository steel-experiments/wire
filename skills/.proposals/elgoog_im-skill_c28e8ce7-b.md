---
id: skill_c28e8ce7-b7ad-49cf-bcb8-371d4a4ecbe2
scope: domain
status: proposed
source: generated
confidence: 0.77
sourceRunIds:
  - run_fa043773-f79f-4176-9395-c7573ab10fc4
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_fa043773-f79f-4176-9395-c7573ab10fc4` with confidence 0.77.

## Facts

- 2048 on elgoog.im can be started with a visible 'Start Bot' control before sending keyboard moves.
- The game page body text includes a 'HOW TO PLAY' section and the score readout may not be exposed as 'SCORE'; initial readout appeared as '00'.
- Dispatching synthetic KeyboardEvent('keydown', {key, bubbles:true}) to document is a workable way to drive the game board.

## Selectors

- `button:contains('Start Bot')`
- `buttons/divs/anchors whose innerText matches /start bot/i`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Wait briefly after clicking 'Start Bot' before sending arrow-key input (about 300-500 ms was used).`
- `Short delays between key presses (around 80 ms) were used while automating moves.`

## Known Traps

- Parsing score via /SCORE\s*(\d+)/i and /BEST\s*(\d+)/i failed; the page did not expose those labels in the observed state.
- Repeated long-running Runtime.evaluate loops caused CDP command timeouts after 30000ms; avoid oversized inline evaluation loops.
- Attempting to infer game state by repeatedly reading body.innerText during extended automation sometimes timed out.
- Some attempts to start the bot or play via synthetic key events did not progress visibly, suggesting the game may require correct focus/state before input is accepted.
