---
id: skill_0742e224-8cc8-43b9-8721-d9df6de8b235
scope: domain
status: proposed
source: generated
confidence: 0.84
sourceRunIds:
  - run_9e7c3ee2-8d00-4736-a88b-6572c464225e
tags:
  - auto-promoted
  - en.wikipedia.org
updatedAt: 2026-04-26
hostnamePatterns:
  - "en.wikipedia.org"
---

# Skill Proposal: en.wikipedia.org

Auto-generated from run `run_9e7c3ee2-8d00-4736-a88b-6572c464225e` with confidence 0.84.

## Facts

- Wikipedia's Special:Random redirects directly to a random article page; in this run it landed on the article titled 'Barchhawa'.
- The article title can be read from the page title after navigation, which became 'Barchhawa - Wikipedia'.

## Routes

- `https://en.wikipedia.org/wiki/Special:Random`

## Wait Patterns

- `After setting window.location.href to Special:Random, wait for the final article URL/title to update before reading page content.`

## Known Traps

- Do not assume Special:Random stays on the Special:Random URL; it redirects immediately to a concrete article page.
- Avoid reading the title before the redirect completes; the initial page is about:blank and the destination URL/title changes afterward.
