---
id: skill_27c5ad36-1f6a-4cfd-a6a7-2221dedbc722
scope: domain
source: curated
tags:
  - curated
  - elgoog.im
updatedAt: 2026-04-26
hostnamePatterns:
  - "elgoog.im"
confidence: 0.95
---

# Skill: elgoog.im 2048 (curated)

## Facts

- The 2048 game is at https://elgoog.im/2048/. Page title: 'Play 2048 Game: Google-Style Edition - elgooG'.
- The game is inside an `<iframe>`. Access game DOM via `document.querySelector('iframe').contentDocument`.
- You MUST click the "Play the Easter Egg Now!" button on the main page to start the game. Without this click, the game grid is empty and score stays 0.
- The original 2048 game uses `.tile-container .tile` elements with value classes `.tile-{N}` and position classes `.tile-position-{row}-{col}`.
- Win: `.game-message.game-won` element appears inside the iframe document. Score will be > 0.
- Loss: `.game-message.game-over` element appears inside the iframe document.

## Selectors

- `iframe` — game container (same-origin, contentDocument accessible)
- Button text "Play the Easter Egg Now!" — click to launch game
- `iframe.contentDocument.querySelector('.tile-container .tile')` — game tiles
- `iframe.contentDocument.querySelector('.game-message.game-won')` — win detection
- `iframe.contentDocument.querySelector('.game-message.game-over')` — loss detection
- `iframe.contentDocument.querySelector('.score-container')` — score

## Workflow

1. Navigate to https://elgoog.im/2048/
2. Click "Play the Easter Egg Now!" button: `const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('Play the Easter Egg')); if(btn) btn.click(); return 'clicked';`
3. Verify game started: `const doc = document.querySelector('iframe').contentDocument; return JSON.stringify({tiles: doc.querySelectorAll('.tile').length, score: doc.querySelector('.score-container')?.textContent});` — tiles should be > 0
4. Play moves via wireActions with CDP Input.dispatchKeyEvent keyDown+keyUp pairs. Send 30+ moves per exec. Strategy: keep highest in corner, prefer DOWN+LEFT cycle.
5. Observe after each batch to check for `.game-message.game-won`
6. When won, extract: `const doc = document.querySelector('iframe').contentDocument; return JSON.stringify({won: !!doc.querySelector('.game-message.game-won'), score: doc.querySelector('.score-container')?.textContent});`

## Traps

- NEVER use /2048/.test(bodyText) or body.innerText.includes('2048') to detect winning. The word "2048" is in the page title and URL. ONLY use the selector `.game-message.game-won` inside the iframe contentDocument.
- NEVER declare won when score is "0". A 0 score means no moves were made.
- You MUST click "Play the Easter Egg Now!" before playing. The game does not auto-start on page load.
- All game DOM queries must go through `iframe.contentDocument`. The main page `document` does not contain game tiles.
- Code is auto-wrapped as `(async () => { YOUR_CODE })()`. Use bare `return` not nested IIFEs.
- Do NOT search for a "Start Bot" button — it does not exist. The correct button is "Play the Easter Egg Now!".
