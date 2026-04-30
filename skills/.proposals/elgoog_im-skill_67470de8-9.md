---
id: skill_67470de8-9ac5-4d54-9673-ac5a56d3eff0
scope: domain
status: proposed
source: generated
confidence: 0.89
sourceRunIds:
  - run_d0f2154a-7a29-4c4d-8bcd-06917e4cb827
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_d0f2154a-7a29-4c4d-8bcd-06917e4cb827` with confidence 0.89.

## Facts

- The 2048 clone is hosted at https://elgoog.im/2048/ and the page title is 'Play 2048 Game: Google-Style Edition - elgooG'.
- A visible 'Start Bot' control exists and can be clicked to begin automated play.
- The game exposes score and best score in elements matching '.score-container' and '.best-container'.
- The in-game status message is available in '.game-message'; after failed/ended runs it showed 'Keep Going! Try Again'.
- A 'New Game' control is available and can be clicked to restart the board during repeated attempts.
- The objective was successfully validated across repeated restarts, with the best score reaching 6828.

## Selectors

- `button.menu-label`
- `button.back-btn`
- `button[aria-label='Return']`
- `.score-container`
- `.best-container`
- `.game-message`
- `button:contains('Start Bot')`
- `button:contains('New Game')`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After clicking 'Start Bot', wait about 800ms before sending keyboard input.`
- `After clicking 'New Game', wait about 500ms before attempting to start the bot again.`
- `When reading score/state after a restart or bot click, allow the page a short pause before checking '.score-container' and '.game-message'.`

## Known Traps

- Dispatching keyboard events too soon after starting the bot can result in only a single move being processed.
- A direct DOM-execution attempt failed with 'Execution context was destroyed', so scripts should tolerate page context refreshes or re-query the DOM after navigation/state changes.
- The game can remain in a 'Keep Going! Try Again' state even when score values are still present; don't treat that message alone as proof of a fresh successful restart.
- Clicks based on exact innerText matching can be brittle if the UI text changes or includes nested labels; re-query buttons carefully each time.
