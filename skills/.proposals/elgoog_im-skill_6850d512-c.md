---
id: skill_6850d512-c8bd-4090-b687-5ef7e22b4a2a
scope: domain
status: proposed
source: generated
confidence: 0.84
sourceRunIds:
  - run_8db580e3-51a0-4a64-a2e7-d964ca6321ce
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-05-01
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_8db580e3-51a0-4a64-a2e7-d964ca6321ce` with confidence 0.84.

## Facts

- The 2048 game is available at /2048/ on elgoog.im.
- Score is shown in .score-container and best score in .best-container.
- The score container may include transient merge text like '32+12'; parse only the leading numeric portion before '+'.
- Game-over state is indicated by .game-message.game-over and win state by .game-message.game-won.
- A new game control is available via .retry-button; fallback text search over buttons/links for 'new game' or 'try again' also works.
- Board state can be reconstructed from DOM tile elements by parsing tile classes/positions; the board is a 4x4 grid.
- sessionStorage persists across reloads on this site, so it can be used to track multi-game bot state/history during a run.
- Page.reload can be used to start a fresh game while preserving sessionStorage history.

## Selectors

- `.score-container`
- `.best-container`
- `.game-message.game-over`
- `.game-message.game-won`
- `.retry-button`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After navigation to /2048/, wait for .score-container or other game UI elements before sending arrow keys.`
- `After a Page.reload used to reset the board, re-check score/best/game state from DOM before continuing; sessionStorage remains available.`

## Known Traps

- Do not parse .score-container text as a plain integer without handling '+' suffixes from recent merges (e.g. '32+12').
- Do not assume a reload clears automation state; sessionStorage survives reload and can unintentionally carry bot metadata across games.
- Avoid relying only on .retry-button text or tag type; if selector changes, use a fallback search across button/a elements by text.
- The run ended with WebSocket errors, so long interactive loops without robust reconnection/retry handling may fail before completion.
