---
id: skill_0dbee8f5-de35-49d1-b9c2-4e6fe4913761
scope: domain
status: proposed
source: generated
confidence: 0.86
sourceRunIds:
  - run_2fc7fcc9-10e0-4dd5-9445-5e0dd0add019
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_2fc7fcc9-10e0-4dd5-9445-5e0dd0add019` with confidence 0.86.

## Facts

- The 2048 game page is at https://elgoog.im/2048/ and remains on the same URL across multiple games/new games.
- The page exposes game state in DOM elements .score-container and .best-container.
- Current board tiles can be read from .tile elements; the highest tile value can be inferred from class names matching tile-(\d+).
- A bot/control button with text matching 'Start Bot' exists and can be clicked to let the game play automatically.
- New games/restarts can be triggered by clicking button or link elements by visible text, so searching both 'button,a' is more reliable than only buttons.
- Best score may not immediately reflect the highest current run during automated play, so record both current score and best separately.

## Selectors

- `.score-container`
- `.best-container`
- `.tile`
- `button,a`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After navigating to /2048/, wait for the page/app to fully settle before running long JS evaluations; early evaluations hit execution-context-destroyed errors.`
- `When the bot is running, prefer short polling snapshots of score/max tile over long-running Runtime.evaluate scripts.`
- `After clicking controls like 'Start Bot' or new game/restart, allow time for the board to update before reading score/tile state.`

## Known Traps

- Do not start a long async/looping evaluation immediately after navigation; the execution context was destroyed multiple times while the page was still settling.
- Do not rely on querying only <button> elements for controls; some clickable controls may be anchors, so search 'button,a' by text.
- Avoid very long Runtime.evaluate calls while the page is active/bot-driven; one attempt timed out after 30000ms.
- Do not assume game-over is required before restarting/starting another run; successful traces recorded multiple games while over=false.
