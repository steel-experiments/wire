---
id: skill_53b95f56-c6cd-4fc3-9180-125a3d279484
scope: domain
status: proposed
source: generated
confidence: 0.89
sourceRunIds:
  - run_0d504885-987a-4d9f-8de8-afa2717f7419
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_0d504885-987a-4d9f-8de8-afa2717f7419` with confidence 0.89.

## Facts

- The 2048 page at https://elgoog.im/2048/ exposes a clickable 'Start Bot' control that is not always a real <button>; it may be a div or other element containing that text, so searches should inspect button, div, and a elements.
- After clicking 'Start Bot', the page can continue showing the board text without immediately changing score; automation should verify state after a short wait.
- The board/game state text is embedded in document.body.innerText and can include score, best, game over, and tile values.
- A successful keyboard control test used synthetic KeyboardEvent 'keydown'/'keyup' with ArrowUp/ArrowLeft/ArrowDown/ArrowRight.
- The page title is 'Play 2048 Game: Google-Style Edition - elgooG' and the game UI text includes 'Slide, merge, and reach the 2048 tile!'

## Selectors

- `button.menu-label`
- `button.back-btn`
- `button.easter-egg-nav__menu-toggle`
- `button, div, a:contains('Start Bot')`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Wait about 500-1200 ms after clicking 'Start Bot' before checking whether the bot/game state changed.`
- `If using keyboard dispatch, a brief pause (~50-100 ms) between moves was used.`
- `For longer play loops, check for 'game over' after each move rather than only at the end.`

## Known Traps

- Selecting only document.querySelectorAll('button') fails to find 'Start Bot' because it may not be a button element.
- Using /start bot/i against button.textContent alone repeatedly failed when the control was not in a button tag.
- Dispatching synthetic KeyboardEvent to document sometimes produced no visible effect or timed out when wrapped in long async loops.
- Running a long automation loop can trigger 'Execution context was destroyed' timeouts on this page.
- Even after clicking 'Start Bot', the page can remain in a state where score stays 0 and game over becomes true quickly, so don't assume the bot started successfully just because the element was clicked.
