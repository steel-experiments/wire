---
id: skill_e3a5aed7-598d-4ce1-b8a2-1ef3d6d83d59
scope: domain
status: proposed
source: generated
confidence: 0.88
sourceRunIds:
  - run_104388d6-1d5a-4b1e-938b-6910af5a2e8c
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_104388d6-1d5a-4b1e-938b-6910af5a2e8c` with confidence 0.88.

## Facts

- The 2048 page at elgoog.im can be reached directly at /2048/.
- The visible Start Bot control on the page may not have the 'button' tag text match expected by simple /start bot/i button scans; selector strategy should not rely only on document.querySelectorAll('button').find(...).
- After starting the bot, keyboard events were successfully dispatched to the page using document.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true})).
- Game state can be read from '.score-container, .score' and '.best-container, .best'.
- Game-over state can be detected with '.game-message.game-over, .game-over, .game-message:not(.hidden)' and by inspecting visible text for 'GAME OVER'.
- The page contains a sidebar/menu and an easter-egg overlay that can change the set of visible buttons, so a broad button scan may return unrelated controls.

## Selectors

- `.score-container, .score`
- `.best-container, .best`
- `.game-message.game-over`
- `.game-over`
- `.game-message:not(.hidden)`
- `button[aria-label='Return']`
- `button.menu-label`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Wait ~500-1200ms after attempting to click Start Bot before reading the board or score.`
- `If using the bot, allow brief pauses (~25ms) between arrow-key dispatches.`
- `After navigation or reload, re-query DOM elements before interacting because execution context can be destroyed.`

## Known Traps

- Avoid assuming the Start Bot control is found by searching only for a <button> with text matching /start bot/i; that approach repeatedly returned clicked:false.
- Avoid reading score from generic text matching 'SCORE' in body text; it often returned unrelated snippets or malformed values.
- Avoid long-running async loops inside a single Runtime.evaluate when the page may reload or mutate heavily; one attempt failed with 'Execution context was destroyed.' and another timed out after 30s.
- Avoid relying on page text alone to detect whether the bot started; several attempts showed the Start Bot text still present while the board state changed.
- Avoid assuming Start Bot is always available as a standard button in the current DOM state; a later DOM snapshot showed different buttons/overlays and no reliable Start Bot/New Game buttons.
