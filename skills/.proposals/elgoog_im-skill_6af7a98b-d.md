---
id: skill_6af7a98b-d8e9-45ed-b40b-66bda969a86a
scope: domain
status: proposed
source: generated
confidence: 0.84
sourceRunIds:
  - run_727cfd55-55ea-44a6-9b6a-318b0f1c4298
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_727cfd55-55ea-44a6-9b6a-318b0f1c4298` with confidence 0.84.

## Facts

- The 2048 page at https://elgoog.im/2048/ uses a visible in-page 'Start Bot' button, but it may disappear or become unavailable after interaction/state changes, so it should be queried fresh each time before clicking.
- Game state and score are not reliably exposed as 'SCORE'/'BEST' text in the body; the page body instead shows a simple header and game messages such as 'Game Over!' and 'Try Again'.
- Sending arrow-key KeyboardEvents directly to the document can drive gameplay without needing the bot, and a simple repeated directional loop can reach a game over state.

## Selectors

- `button: text matching /start bot/i`
- `document.body.innerText for game messages like /Game Over!/i`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After clicking 'Start Bot', short waits like 300-500 ms may be enough to observe initial UI changes.`
- `Longer waits did not reliably produce readable score updates or bot status; the UI may not expose them in text form.`

## Known Traps

- Do not assume the 'Start Bot' button remains present after initial clicks; re-query the DOM before each click.
- Do not rely on parsing 'SCORE' and 'BEST' from body text on this page; those labels may be absent or rendered differently.
- Repeated rapid keyboard dispatch without pauses can lead to the game ending quickly; a naive directional loop may just trigger 'Game Over!' rather than an optimal run.
- Attempting a longer automated run with many key presses and periodic body-text polling eventually triggered a WebSocket error.
