---
id: skill_fc37d021-25be-4de9-9868-b46c1c51cd6b
scope: domain
status: proposed
source: generated
confidence: 0.97
sourceRunIds:
  - run_b4051af6-bf65-43c9-9cf4-eaf6220cd45b
tags:
  - auto-promoted
  - about:blank
updatedAt: 2026-04-30
hostnamePatterns:
  - "about:blank"
---

# Skill Proposal: about:blank

Auto-generated from run `run_b4051af6-bf65-43c9-9cf4-eaf6220cd45b` with confidence 0.97.

## Facts

- The run failed immediately because the model produced an invalid action payload: {"kind":"reconfigure","payload":{"stealth":true}}.
- The page never navigated away from about:blank, so no site-specific interaction knowledge was learned.
- A verification snippet was used to capture basic page state (title, URL, body text) via document.title, location.href, and document.body?.innerText.

## Known Traps

- Do not emit unsupported action kinds such as reconfigure.
- Do not assume a stealth reconfiguration step is valid; it caused an invalid payload error.
- about:blank contained no actionable content, so waiting or selecting elements there would be pointless.
