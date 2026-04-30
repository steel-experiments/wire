---
id: skill_1648ed56-d524-42f4-9867-cd01956e881b
scope: domain
status: proposed
source: generated
confidence: 0.77
sourceRunIds:
  - run_8e7aafe2-2243-4c55-b407-a73a80c61975
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_8e7aafe2-2243-4c55-b407-a73a80c61975` with confidence 0.77.

## Facts

- The 2048 game is embedded in the elgooG page and can be affected by site overlays/menus; the page body text may include menu items, theme toggles, and Easter-egg promotions that are unrelated to the game state.
- A reliable way to inspect the board is to read `.tile` elements and parse `tile-position-X-Y` classes plus their numeric text content.
- The game can be driven with keyboard arrow inputs, but events sent to `document.dispatchEvent` or `window.dispatchEvent` did not reliably affect the game in this trace; CDP `Input.dispatchKeyEvent` was more effective.
- The UI may show a bot/start control labeled 'Start Bot', but clicking it or sending key spam did not produce a stable gameplay state in this trace.
- The page sometimes exposes score/best values in `.score-container` / `.best-container`, but text scraping can be unreliable because the page may show unrelated injected text or overlays.

## Selectors

- `.tile`
- `div.tile`
- `button`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Wait briefly after navigation and after clicking 'Start Bot' or any overlay-dismiss action before reading board state.`
- `If the page seems unresponsive, re-read the DOM after a short sleep because overlays and game state can change asynchronously.`

## Known Traps

- Do not rely on `button:contains(...)` selectors; `:contains` is not a valid CSS selector in `querySelector` and caused a failure.
- Do not assume `document.dispatchEvent(new KeyboardEvent(...))` or `window.dispatchEvent(...)` will move the 2048 board; these approaches were ineffective here.
- Do not spam arrow keys repeatedly and expect progress; repeated identical key-spam attempts led to no meaningful change and eventually aborted re-planning.
- Do not trust `document.body.innerText` alone for score/game-over detection on this page; it can return unrelated site text and overlay content instead of clean game state.
