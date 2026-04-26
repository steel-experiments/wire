---
id: skill_5cc92dc3-0b63-4247-b2a3-6a7c82e76180
scope: domain
status: proposed
source: generated
confidence: 0.92
sourceRunIds:
  - run_4cd9d15b-d17d-4736-a270-8e7eda9d6345
tags:
  - auto-promoted
  - weather.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "weather.com"
---

# Skill Proposal: weather.com

Auto-generated from run `run_4cd9d15b-d17d-4736-a270-8e7eda9d6345` with confidence 0.92.

## Facts

- Weather.com can be used directly for NYC weather when Google search is blocked by unusual-traffic interstitials.
- The New York City weather page used in the run was the Tribeca, Manhattan location URL.
- The verified current temperature in the run was 43°F.

## Routes

- `https://www.weather.com/weather/today/l/New+York+NY+USNY0996:1:US`

## Wait Patterns

- `After setting window.location.href, wait for the weather.com page to load before reading content.`

## Known Traps

- Google search for NYC weather triggered an unusual-traffic / bot-detection page and was not usable for this task.
- Do not rely on matching temperature from the Google results page text; it returned only the interstitial, not weather data.
