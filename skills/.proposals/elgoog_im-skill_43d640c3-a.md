---
id: skill_43d640c3-a00c-4e1f-9865-377a299aea54
scope: domain
status: proposed
source: generated
confidence: 0.92
sourceRunIds:
  - run_82f761d3-f980-46c6-a936-e3bef2e55f9d
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_82f761d3-f980-46c6-a936-e3bef2e55f9d` with confidence 0.92.

## Facts

- The 2048 game page loads at https://elgoog.im/2048/ and the title is 'Play 2048 Game: Google-Style Edition - elgooG'.
- The game can be interacted with by dispatching keyboard arrow-key events to the document/body; this is the working control method used in the trace.
- The page body text includes the instructions and visible controls, so `document.body.innerText` is useful for state checks.
- The game appears to expose tile elements with the `.tile` class and a board/container element matching `.tile-container` or `.game-container`.
- The visible 'Start Bot' control was not reliably present/clickable in later states; button text changed to a menu overlay with 'Return', 'Toggle light/dark theme', and 'Play the Easter Egg Now!'.

## Selectors

- `.tile`
- `.tile-container`
- `.game-container`
- `button:contains('Start Bot')`
- `button:contains('New Game')`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Use a short delay after each arrow-key dispatch (roughly 25-120ms was tried).`
- `After clicking controls or sending keys, wait briefly before reading `document.body.innerText` to let the UI update.`
- `If using the bot-start flow, verify the page state after the click because the control may not exist or may not trigger the game.`

## Known Traps

- Searching only `button` text for 'Start Bot' can fail because the control is not always present or may be hidden by overlays/menu state.
- Using `document.dispatchEvent(new KeyboardEvent(...))` worked better than trying to click a bot button, but some attempts still produced no score change if the game state was not ready.
- Reading score via `SCORE <num>` or `BEST <num>` regexes often returned null/0 because the page renders score differently (e.g. just `00`).
- Long automation loops or repeated async evaluation caused `CDP command timed out after 30000ms`.
- Some scripts caused `Execution context was destroyed`, likely from navigation or page state changes during evaluation.
- A WebSocket error occurred at the end of the run, so long-running interactions can destabilize the session.
