---
id: skill_08cc3e4e-9e47-4a73-b97d-660b066a8d8b
scope: domain
status: proposed
source: generated
confidence: 0.71
sourceRunIds:
  - run_4c214fcf-b7f7-487a-a46b-c9efd4879aba
tags:
  - auto-promoted
  - example.com
updatedAt: 2026-04-26
hostnamePatterns:
  - "example.com"
---

# Skill Proposal: example.com

Auto-generated from run `run_4c214fcf-b7f7-487a-a46b-c9efd4879aba` with confidence 0.71.

## Facts

- Navigating directly to https://example.com via a redirect URL worked as a reliable path to reach the target page.

## Routes

- `https://httpbin.org/redirect-to?url=https://example.com`

## Known Traps

- Do not assume the target must be opened directly; this run used an intermediate redirect endpoint to land on https://example.com.
