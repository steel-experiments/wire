---
id: skill_b98cada8-29cf-4f9f-b0d5-99a1b3bbb561
scope: domain
status: proposed
source: generated
confidence: 0.93
sourceRunIds:
  - run_198c8a50-9707-42a5-b235-becca57a1c14
tags:
  - auto-promoted
  - google.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "google.com"
---

# Skill Proposal: google.com

Auto-generated from run `run_198c8a50-9707-42a5-b235-becca57a1c14` with confidence 0.93.

## Facts

- Google search for weather-related queries can trigger an abuse/interstitial flow instead of returning results.
- A direct Google search for 'NYC weather' and 'NYC weather temperature' returned 'About this page' with 'Our systems have detected unusual traffic from your computer network' text.
- A later Google search for 'NYC weather now' redirected to /sorry/index with a continue parameter back to the search URL, indicating an auth/captcha wall.
- weather.com path guessed as /weather/today/l/New+York+NY?par=google returned a 404 page, so that route is not reliable.

## Routes

- `https://www.google.com/search?q=NYC+weather`
- `https://www.google.com/search?hl=en&q=NYC+weather+temperature`
- `https://www.google.com/search?q=NYC+weather+now`
- `https://www.weather.com/weather/today/l/New+York+NY?par=google`
- `https://www.google.com/sorry/index?continue=...`

## Wait Patterns

- `Polling document.body.innerText every 500ms for up to 10-15s to detect weather text or temperature patterns.`
- `Waiting for a temperature regex like /-?\d+\s*°\s*[FC]/i before extracting weather values.`

## Known Traps

- Google search results may be blocked by unusual-traffic / sorry pages; do not rely on search scraping for weather data in automation.
- The weather.com route used here produced 404, so avoid assuming that URL pattern is valid.
- If Google redirects to /sorry/index, the task is blocked behind a challenge and requires user assistance rather than more retries.
