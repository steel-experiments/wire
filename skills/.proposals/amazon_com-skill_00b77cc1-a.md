---
id: skill_00b77cc1-a2e6-4928-8bac-4efae1bdea8f
scope: domain
status: proposed
source: generated
confidence: 0.54
sourceRunIds:
  - run_c36cb23c-37c5-4267-93f6-c004d8b67e79
tags:
  - auto-promoted
  - amazon.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "amazon.com"
---

# Skill Proposal: amazon.com

Auto-generated from run `run_c36cb23c-37c5-4267-93f6-c004d8b67e79` with confidence 0.54.

## Facts

- Amazon homepage loads at https://www.amazon.com/ with title 'Amazon.com. Spend less. Smile more.'
- A broad page-text verification approach using document.body.innerText can confirm visible promotional text on the homepage.

## Routes

- `https://www.amazon.com/`

## Known Traps

- The trace did not show a successful interaction path beyond loading the homepage; do not assume the target promotional text is already visible without further navigation or scrolling.
- Avoid relying solely on a generic page-text slice from the top of the document if the desired promo appears lower on the page or in a carousel.
