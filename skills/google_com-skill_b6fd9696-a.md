---
id: skill_b6fd9696-ac80-4f90-83e0-a71ba9c07380
scope: domain
status: active
source: generated
confidence: 0.96
sourceRunIds:
  - run_ef9c2769-5a78-4a3f-aeae-c55578bffd11
tags:
  - auto-promoted
  - google.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "google.com"
---

# Skill Proposal: google.com

Auto-generated from run `run_ef9c2769-5a78-4a3f-aeae-c55578bffd11` with confidence 0.96.

## Facts

- Direct navigation to Google Search can trigger an interstitial/auth wall that blocks automation and requires user assistance.
- When this wall appears, the task cannot proceed without human intervention.

## Routes

- `https://www.google.com/search?q=capital+of+france`

## Known Traps

- Navigating directly to Google Search may redirect to /sorry/index with a CAPTCHA/auth wall.
- Do not assume search results are accessible without handling the verification page.
