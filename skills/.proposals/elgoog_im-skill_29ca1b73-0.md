---
id: skill_29ca1b73-0704-4c5b-81c2-1673bf26896e
scope: domain
status: proposed
source: generated
confidence: 0.83
sourceRunIds:
  - run_ffefa152-c767-4e5f-aa0f-f59286fe3e22
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_ffefa152-c767-4e5f-aa0f-f59286fe3e22` with confidence 0.83.

## Facts

- The 2048 game is on https://elgoog.im/2048/ and the page title is 'Play 2048 Game: Google-Style Edition - elgooG'.
- A 'Start Bot' button exists on the page and can be clicked before sending moves.
- The page body text contains the game UI text, including score/best labels and the instructions section, so DOM text scraping is possible for state detection.
- Arrow key input was attempted by dispatching KeyboardEvent keydown/keyup events to document, window, and document.body.

## Selectors

- `button: has text matching /start bot/i`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Wait briefly after clicking 'Start Bot' before sending arrow-key input (about 300-500 ms was used).`

## Known Traps

- Dispatching keyboard events only to document.body did not appear to affect the game.
- Dispatching keyboard events to document and window alone also did not visibly start the bot or change score.
- Clicking 'Start Bot' without an additional wait still showed score 0 in DOM reads.
- Heuristic/snake-pattern move sequences attempted after starting the bot did not immediately produce visible progress in the sampled DOM state.
- Reading score/best via regex on body text can fail because the displayed UI sometimes shows compact numeric text like '00' and the literal labels 'SCORE'/'BEST' may not be present in the scraped text.
