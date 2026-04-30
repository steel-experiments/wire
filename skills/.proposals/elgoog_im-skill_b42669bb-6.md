---
id: skill_b42669bb-6ed6-4167-b1ef-d9050bfabfbf
scope: domain
status: proposed
source: generated
confidence: 0.91
sourceRunIds:
  - run_374c5764-965f-4011-9012-64405728ebcd
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_374c5764-965f-4011-9012-64405728ebcd` with confidence 0.91.

## Facts

- The 2048 page is at /2048/ on elgoog.im.
- Working score selectors are .score-container and .best-container; earlier guesses like p.score/.score and p.best/.best returned null/0 on this site.
- Game status text is exposed in .game-message and often reads 'Keep Going! Try Again' when a run has ended.
- Game-over detection works by checking .game-message text for 'try again' or 'game over'; selector .game-message.game-over alone may miss ended states on this implementation.
- A 'New Game' control is available by visible text and can be clicked to reset between runs.
- Visible buttons/controls include text like 'MENU Menu', 'Return', and theme toggle controls, so text-based button matching should be scoped carefully.

## Selectors

- `.score-container`
- `.best-container`
- `.game-message`
- `button:contains('New Game')`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After clicking 'New Game', wait briefly for the board/state to reset before reading score or sending moves.`
- `Long async evaluate loops on this page can hit the 30s CDP Runtime.evaluate timeout; prefer short polling/evaluate calls.`
- `Be prepared for execution context destruction after actions that reload/reset the game; reacquire the page context and selectors afterward.`

## Known Traps

- Do not rely on p.score/.score or p.best/.best for score reading here; they produced null/0.
- Do not assume .game-message.game-over is always present; text-based detection on .game-message was more reliable.
- Avoid long-running in-page async scripts/loops; they repeatedly caused 'CDP command timed out after 30000ms: Runtime.evaluate'.
- After clicking reset/new-game or triggering reload-like behavior, previously running evaluate code can fail with 'Execution context was destroyed'.
- Naively parsing all digits from .best-container can capture stale/large accumulated best values (e.g. 9664); parse carefully and expect best to persist across runs, making it unsuitable as per-run score.
- Global objects like window.gameManager were not available/reliable for control; DOM selectors and text-based controls were used instead.
