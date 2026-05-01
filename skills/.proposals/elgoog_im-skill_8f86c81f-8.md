---
id: skill_8f86c81f-8da2-4466-b781-3ecec2e17cb7
scope: domain
status: proposed
source: generated
confidence: 0.94
sourceRunIds:
  - run_207034aa-03c5-4a2f-b1c6-e8efab9f53a6
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-05-01
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_207034aa-03c5-4a2f-b1c6-e8efab9f53a6` with confidence 0.94.

## Facts

- The 2048 game is directly playable at https://elgoog.im/2048/.
- Game state is readable from DOM: .score-container for current score, .best-container for high score, .game-message.game-over and .game-message.game-won for terminal states.
- Tiles are exposed as .tile elements, and numeric values can be read from .tile .tile-inner text.
- The score container may include a transient increment suffix like '560+8'; the best score is shown separately and can be used as a stable recorded high score.
- Sending real browser-level key events via Input.dispatchKeyEvent successfully advances the game and updates score/highscore.
- A repeating move strategy biased toward Down/Left can keep the game active and raise the high score; sequences using Down+Left with occasional Up or Right worked.

## Selectors

- `.score-container`
- `.best-container`
- `.game-message.game-over`
- `.game-message.game-won`
- `.tile`
- `.tile .tile-inner`

## Routes

- `/2048/`

## Wait Patterns

- `After dispatching a batch of Input.dispatchKeyEvent actions, re-read score/tile state from the DOM to confirm movement and score changes.`
- `If validating score, prefer reading .best-container after moves because .score-container can temporarily include a '+N' animation suffix.`

## Known Traps

- No visible 'Start Bot' button was found; repeated attempts to locate/click a button matching /start bot/i returned started:false and had no effect.
- Dispatching synthetic KeyboardEvent keydown/keyup on document.body did not move tiles or change score on this page.
- Do not rely on .score-container being a plain integer string during animations; values like '1108+8' appear.
- Checking immediately after failed synthetic input can misleadingly show the initial 2 tiles only; use browser-level input instead.
