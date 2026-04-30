---
id: skill_80b6eacd-bc74-4234-a52c-6bca137c18ae
scope: domain
status: proposed
source: generated
confidence: 0.84
sourceRunIds:
  - run_eb9ab259-ad1e-49b4-a887-b00b5e8746b8
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_eb9ab259-ad1e-49b4-a887-b00b5e8746b8` with confidence 0.84.

## Facts

- The 2048 clone is at https://elgoog.im/2048/ and the page title is 'Play 2048 Game: Google-Style Edition - elgooG'.
- A visible 'Start Bot' button exists on the page, but repeatedly clicking it did not produce progress in this trace; keyboard-driven play attempts also failed to advance the game state.
- The game board and score are rendered in the page body text, with score/best elements available via generic selectors containing 'score' and 'best'.
- After clicking Start Bot, the body text still showed the initial 2048 instructions and starting tiles, suggesting the bot did not activate or the page did not accept the attempted input method.
- Directly dispatching KeyboardEvent('keydown', {key, code, bubbles:true}) to document was attempted as the input method for moves.

## Selectors

- `button:contains('Start Bot') via innerText matching /Start Bot/i`
- `button:contains('New Game') via innerText matching /New Game/i`
- `'.score-container, [class*=score]'`
- `'.best-container, [class*=best]'`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Waited about 1000-1500ms after clicking 'Start Bot' before checking score/body text.`
- `Waited about 500-800ms before attempting repeated keyboard moves after starting the bot.`

## Known Traps

- Clicking the 'Start Bot' button repeatedly did not change the score or game state in this trace.
- Dispatching synthetic keydown events to document with ArrowUp/ArrowRight/ArrowDown/ArrowLeft did not reliably advance the game; attempts often led to no state change or CDP runtime timeouts.
- Long-running loops / repeated runtime evaluation caused 'CDP command timed out after 30000ms: Runtime.evaluate'.
- Reading and iterating too much DOM/game state inside a single evaluate call appears to risk timeouts on this page.
