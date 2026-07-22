---
id: skill_88a3e7aa-e42a-4b03-9c23-19bc559fae00
scope: domain
status: proposed
source: generated
confidence: 0.78
sourceRunIds:
  - run_6ad057a0-fab4-404f-9aee-5c9235e8a885
tags:
  - auto-promoted
  - play2048.co
updatedAt: 2026-04-27
hostnamePatterns:
  - "play2048.co"
---

# Skill Proposal: play2048.co

Auto-generated from run `run_6ad057a0-fab4-404f-9aee-5c9235e8a885` with confidence 0.78.

## Facts

- The game page loads with a tutorial overlay that can block play; dismissing the overlay is necessary before sending moves.
- Keyboard interaction is the primary control mechanism; arrow key events are dispatched to play 2048.
- A simple corner-building move pattern was attempted repeatedly, but in this trace the score remained 0 and no visible board state change was captured from DOM queries.
- The page body text reliably includes the tutorial prompt and score/best labels, which can be used as a basic readiness check.

## Selectors

- `button,div,span text()='×' for closing the tutorial overlay`
- `.tile was queried but returned no elements in this trace`

## Routes

- `https://play2048.co/`

## Wait Patterns

- `Wait ~200-300 ms after clicking the overlay close button before sending arrow keys.`
- `Wait ~80-150 ms between key presses when automating move sequences.`
- `Wait ~300-400 ms after a move sequence before reading score/body text.`

## Known Traps

- Dispatching arrow-key KeyboardEvent events to window did not produce observable progress in this trace; the score stayed at 0.
- Repeatedly clicking a '×' element by text may not always remove the overlay if multiple candidates exist; the close action should be verified.
- Querying for .tile elements returned none in this run, so relying on tile DOM inspection without confirming the board structure is brittle.
- Several different move sequences were tried, including corner-stack strategies, but none showed measurable advancement here.
