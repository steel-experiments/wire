---
id: skill_0428b95f-e00c-4dbb-a0ba-508be69e9858
scope: domain
status: proposed
source: generated
confidence: 0.92
sourceRunIds:
  - run_75dc9360-746e-4538-b581-8c3f2d08af19
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_75dc9360-746e-4538-b581-8c3f2d08af19` with confidence 0.92.

## Facts

- 2048 is playable at /2048/ on elgoog.im.
- The page exposes standard 2048 DOM structure: score and best are readable from .score-container/.score and .best-container/.best.
- Board tiles are represented by .tile elements with value and position encoded in class names like tile-2 and tile-position-x-y.
- Game end states can be detected from .game-message.game-over/.game-over and .game-message.game-won/.game-won; win text may also appear in body text.
- After reaching 2048, a 'Keep Going!' control appears and can be clicked to continue play.
- A restart control labeled 'Try Again' or 'New Game' is available via button or link text matching /try again|new game/i.
- Arrow key events successfully drive the game (ArrowLeft, ArrowDown were used repeatedly).
- Score text parsing by stripping non-digits can be misleading on this site because text may concatenate score increments or neighboring labels, producing impossible values; tile-derived maxTile is more reliable than parsed score for validation.

## Selectors

- `.score-container`
- `.score`
- `.best-container`
- `.best`
- `.tile`
- `.game-message.game-over`
- `.game-over`
- `.game-message.game-won`
- `.game-won`
- `a,button`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `After navigation to /2048/, wait for score container or .tile elements before reading state.`
- `After dispatching arrow keys, allow a short delay for tile animation/DOM updates before re-reading board state.`
- `When checking win/lose state, prefer visible game-message elements; hidden overlays may exist in DOM.`

## Known Traps

- Do not assume a 'Start Bot' button exists; button text search found many buttons but no reliable start-bot control.
- Do not trust raw numeric parsing of .score/.best text alone; runs produced impossible values like 213322048 and truncated best values, likely from concatenated text.
- Do not treat mere presence of .game-over/.game-won in DOM as definitive; verify visibility because hidden state elements may remain mounted.
- The session ended with WebSocket errors, so long-running control loops should tolerate transport interruption and persist intermediate results.
