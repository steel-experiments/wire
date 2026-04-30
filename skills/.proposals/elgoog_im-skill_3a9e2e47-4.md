---
id: skill_3a9e2e47-49fe-4fc3-9f9e-4c19af93a10e
scope: domain
status: proposed
source: generated
confidence: 0.9
sourceRunIds:
  - run_896b82bf-2555-4fb2-a9f6-7d1b4b4f8e6a
tags:
  - auto-promoted
  - elgoog.im
updatedAt: 2026-04-30
hostnamePatterns:
  - "elgoog.im"
---

# Skill Proposal: elgoog.im

Auto-generated from run `run_896b82bf-2555-4fb2-a9f6-7d1b4b4f8e6a` with confidence 0.9.

## Facts

- The 2048 game is playable at https://elgoog.im/2048/ and can be started by clicking the in-page control labeled 'Start Bot'.
- After starting, the control changes to 'Stop Bot!', indicating the bot is running.
- The page body text includes the current score and board state, but score/best are not always exposed with simple SCORE/BEST label matching; reading the raw page text is more reliable than searching for dedicated score elements.
- The game can be interacted with using keyboard arrow keys: ArrowLeft, ArrowUp, ArrowRight, ArrowDown.

## Selectors

- `button,input,[role="button"],a with text matching /start bot/i`

## Routes

- `https://elgoog.im/2048/`

## Wait Patterns

- `Wait for the page to load after navigation before querying the DOM.`
- `After clicking Start Bot, expect a short delay before the UI updates to 'Stop Bot!'.`

## Known Traps

- Do not assume the score and best values are exposed as plain text labels matching /^SCORE\s*(\d+)/i or /^BEST\s*(\d+)/i; that approach returned null in the trace.
- A naive search for a clickable element with exact trimmed text 'Start Bot' may fail after the bot is already running because the button label changes to 'Stop Bot!'.
