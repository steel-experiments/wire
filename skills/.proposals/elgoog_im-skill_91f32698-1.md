---
id: skill_91f32698-140a-48df-8440-30efc094a8dd
scope: domain
status: proposed
source: generated
confidence: 0.87
sourceRunIds:
  - run_388cc2c6-3a37-465c-b4fb-a1170c68837e
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_388cc2c6-3a37-465c-b4fb-a1170c68837e` with confidence 0.87.

## Facts

- The 2048 page at https://elgoog.im/2048/ shows a menu overlay and a main game screen with the title 'Play 2048 Game: Google-Style Edition - elgooG'.
- The page exposes a Start Bot control, but on this run clicking it never produced an observable state change in the page text, score, or game-over indicators.
- The visible board state can include plain tile numbers in body text (e.g. '2 2'), so reading document.body.innerText can confirm the game has started even when dedicated score selectors fail.

## Selectors

- `button with text matching /start bot/i`
- `button with text matching /new game/i`
- `button,input[type=button],.button,[role=button] for enumerating actionable controls`
- `[class*="board"], [id*="board"] as a loose board presence check`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After clicking Start Bot, short waits of about 500-1500 ms were tried repeatedly before checking for board/score changes.`
- `A longer wait of 12-15 seconds still did not reveal score or game-over text changes in body text.`

## Known Traps

- Do not rely on document.body.innerText regexes for 'SCORE' or 'BEST' on this page; they returned null throughout the run.
- Do not assume Start Bot actually starts visible gameplay immediately; repeated clicks plus waits showed no clear progression in the text snapshot.
- Do not trust generic element searches for text containing 'score' because they matched unrelated page script text instead of a live score element.
- If Start Bot is absent from the currently available controls, the page may be in an overlay/alternate state; the control list at one point only contained menu/theme/share/close and not Start Bot.
