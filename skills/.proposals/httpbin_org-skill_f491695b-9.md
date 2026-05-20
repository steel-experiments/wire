---
id: skill_f491695b-9311-45a0-bb54-c3b54fb4a625
scope: domain
status: proposed
source: generated
confidence: 0.97
sourceRunIds:
  - run_665dda97-7f09-4c80-bd6f-e14676b04b6f
tags:
  - auto-promoted
  - httpbin.org
updatedAt: 2026-05-20
hostnamePatterns:
  - "httpbin.org"
---

# Skill Proposal: httpbin.org

Auto-generated from run `run_665dda97-7f09-4c80-bd6f-e14676b04b6f` with confidence 0.97.

## Workflow

1. Step 1: Navigate directly to https://httpbin.org/headers.
2. Step 2: Read document.body.innerText and parse it as JSON.
3. Step 3: Extract fields from data.headers such as Accept and User-Agent.
4. Step 4: Return the extracted values as a JSON artifact.

## Facts

- The /headers route returns a JSON document rendered as page text.
- document.body.innerText contains valid JSON on https://httpbin.org/headers.
- The response includes a headers object with keys like Accept and User-Agent.

## Selectors

- `document.body.innerText`

## Routes

- `https://httpbin.org/headers`

## Wait Patterns

- `No special wait was needed after direct navigation to /headers; parsing page text succeeded immediately.`
