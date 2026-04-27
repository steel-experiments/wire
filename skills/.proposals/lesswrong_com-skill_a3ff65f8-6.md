---
id: skill_a3ff65f8-6cf5-4a2c-b68b-2771656b523e
scope: domain
status: proposed
source: generated
confidence: 0.93
sourceRunIds:
  - run_0afd61ed-b118-4fc0-94d4-86de72b106c8
tags:
  - auto-promoted
  - lesswrong.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "lesswrong.com"
---

# Skill Proposal: lesswrong.com

Auto-generated from run `run_0afd61ed-b118-4fc0-94d4-86de72b106c8` with confidence 0.93.

## Facts

- The LessWrong front page contains post links under anchors whose href includes '/posts/'.
- A reliable way to identify the front-page post title is to inspect visible anchors, then choose the first non-numeric textContent with length > 1.
- Direct navigation to https://www.lesswrong.com/ loads the homepage titled 'LessWrong'.

## Selectors

- `a[href*="/posts/"]`

## Routes

- `https://www.lesswrong.com/`

## Known Traps

- Some post link text on the front page may be numeric or otherwise non-title text, so filter out purely numeric anchor text before selecting a title.
- Only consider anchors that are visible; hidden or zero-sized elements can produce false matches.
