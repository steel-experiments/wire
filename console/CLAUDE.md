# Wire Console — build notes

Crew: **Turbo Diesel** (agent) and **Nikodemus Maximum Overdrive** (Niko). Keep it fast, keep it elegant, keep it lean.

## What this is

An observable web console for Wire. It is a **consumer** of Wire, not part of the
agent core. It lives in `wire/console/` but is a separate Bun app with its own
dependencies and its own LOC — it is **outside** the `wire/src/` budgets and the
architecture-fitness check (those only walk `src/`).

## Hard rules

- **Never import from `../src`.** Talk to Wire only via the CLI (`wire run --stream-json`)
  and the persisted state under `~/.wire/state/`. If you need a Wire type, copy the
  minimal shape locally; do not reach into the core.
- **Read-only except approvals.** The server launches agents and reads evidence. The
  only state mutation it performs is approving/denying a pending policy action. Anything
  else that changes state goes through the Wire CLI, never reimplemented here.
- **Not a chatbot.** Wire is `task -> run -> evidence`. The UI makes evidence inspectable
  and approvals fast. No conversational surface.
- **Lean.** Prefer the platform and shadcn copy-in components over new dependencies.

## Stack

Bun · Hono (API + SSE + static SPA) · Vite + React + TS · Tailwind v4 + shadcn/ui.
Theme: system | light | dark, default system, persisted to `localStorage`.

## Layout

```
console/
  server/   index.ts (Hono app), dev.ts (runs Vite + API together)
  src/      React SPA — components/, lib/, App.tsx, main.tsx, index.css
```

## Conventions

- Every code file starts with two `ABOUTME:` comment lines.
- Match surrounding style; smallest reasonable change.
- TDD for non-trivial server logic (orchestrator parsing, the event bus).
