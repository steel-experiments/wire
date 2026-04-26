---
id: skill_1ff4d746-4d1a-47d8-af30-f5fca9aed0dc
scope: domain
status: proposed
source: generated
confidence: 0.84
sourceRunIds:
  - run_7bb7447c-effa-4798-b5b8-96bb9aa91efc
tags:
  - auto-promoted
  - index.hr
updatedAt: 2026-04-26
hostnamePatterns:
  - "index.hr"
---

# Skill Proposal: index.hr

Auto-generated from run `run_7bb7447c-effa-4798-b5b8-96bb9aa91efc` with confidence 0.84.

## Facts

- The homepage text can be read directly from document.body.innerText after navigation to https://www.index.hr/.
- A simple text search over trimmed body lines can verify the latest news headline without interacting with page controls.
- The verified headline was found by searching for a unique substring ('Trump evakuiran') within the homepage text.

## Routes

- `https://www.index.hr/`

## Wait Patterns

- `Wait about 2-3 seconds after loading the homepage before reading document.body.innerText, as the content may not be immediately present.`
