---
id: skill_01272fa1-fdf4-42a6-b4c1-cc11cb564f03
scope: domain
status: proposed
source: generated
confidence: 0.96
sourceRunIds:
  - run_57278908-fbd4-4981-8650-2d9f32453afb
tags:
  - auto-promoted
  - github.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "github.com"
---

# Skill Proposal: github.com

Auto-generated from run `run_57278908-fbd4-4981-8650-2d9f32453afb` with confidence 0.96.

## Facts

- GitHub homepage does not display a public repositories count; attempts to extract it from the homepage text returned null.
- The homepage body text prominently includes navigation items like 'Skip to content', 'Navigation Menu', 'Platform', 'Solutions', 'Resources', 'Open Source', 'Enterprise', 'Pricing', 'Search or jump to...', 'Sign in', and 'Sign up'.

## Routes

- `https://github.com/`

## Wait Patterns

- `After setting location.href to https://github.com, a short wait (~500ms) was used before reading page content.`

## Known Traps

- Do not expect a 'public repositories' count on the GitHub homepage; regex searches against document.body.innerText returned no match.
- Repeated attempts with multiple regex patterns over homepage text still produced null for repository count, so the value is not available from this page.
