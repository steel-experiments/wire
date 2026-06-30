# Wire Console

An observable web console for [Wire](../README.md): launch real-browser agents,
watch them run live, run many in parallel, and inspect the full evidence record
of every run.

This is a **consumer** of Wire, not part of the agent core. It lives in this
subfolder but is a separate Bun app with its own dependencies; it never imports
from `../src`. It talks to Wire two ways:

- **Live runs** — spawns `wire run --stream-json` and streams the NDJSON trace.
- **History** — reads the persisted run records under `~/.wire/state/`.

## Stack

- **Runtime:** Bun
- **Server:** Hono (JSON API + SSE + serves the built SPA)
- **Frontend:** Vite + React + TypeScript
- **UI:** Tailwind v4 + shadcn/ui, system/light/dark theming (default: system)

## Develop

```bash
cd console
bun install
bun run dev        # Vite on :5177, Hono API on :3000 (proxied through Vite)
```

Open http://localhost:5177 (override with `WEB_PORT`). The header status dot turns green once the SPA
reaches the Hono `/api/health` endpoint.

### Driving real runs

The server launches agents by spawning a Wire CLI. Point it at your build with
`WIRE_CMD` (space-separated; default `wire`):

```bash
# from the repo root, after `pnpm build`:
WIRE_CMD="node $PWD/dist/index.js" bun --cwd console run dev
```

It needs the same environment Wire does — `STEEL_API_KEY` plus an LLM key
(`OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `ZAI_API_KEY`). The console reads
finished run records from `~/.wire/state` (override with `WIRE_ROOT`).

```bash
bun run build      # build the SPA to dist/
bun run start      # serve the built SPA + API from Hono on :3000
bun run typecheck  # tsc --noEmit
```

## Build order

1. **Skeleton + theme** ✅ — server, SPA, theming, health probe.
2. **Orchestrator + live trace via SSE** ✅ — launch, NDJSON → bus → timeline.
3. **Parallel runs + history seeding** ✅ — multiplexed SSE, hydrate from `~/.wire/state`.
4. **Live Steel viewer** ✅ — `session` event → embedded `app.steel.dev` iframe.
5. **Approvals + record view** ✅ — pending-approval gate (`POST /api/approvals/:launchId`
   resumes via `wire approve --stream-json`) and the post-hoc evidence record.
