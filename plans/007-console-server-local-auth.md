# Plan 007: Bind the console server to loopback and reject cross-origin state changes

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 8b84c05..HEAD -- console/server console/README.md console/vite.config.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (but run its checks after plan 004 if both are in flight — 004 touches `console/package.json`)
- **Category**: security
- **Planned at**: commit `8b84c05`, 2026-07-17

## Why this matters

The Wire Console server has no authentication and binds every network
interface: Bun's serve defaults to `0.0.0.0` because the exported config sets
only `port`. Its routes include two state-changing POSTs: `/api/runs` spawns
a real `wire run` subprocess (burning the operator's Steel and LLM credits,
driving a browser that may hold the operator's logged-in profiles), and
`/api/approvals/:launchId` — which takes NO request body — approves an action
the policy engine deliberately paused for a human. Consequences today:

1. Anyone on the same LAN/VPN can read all runs/traces, launch agent runs,
   and forge approvals.
2. Any website the operator visits can do the same via CSRF: browsers send
   cross-origin POSTs without preflight when the body is "simple"
   (`text/plain`), and Hono's `c.req.json()` parses the body regardless of
   Content-Type; the approvals POST needs no body at all.

Fix: bind loopback by default (explicit env opt-out), and reject non-GET
`/api` requests whose `Origin` is not local. This keeps the human-in-the-loop
approval gate meaning what it claims.

## Current state

- `console/` is a separate Bun + Hono + React app (own `package.json`,
  `bun test server/`, `tsc --noEmit`, Vite build). Per `console/CLAUDE.md`:
  server logic gets TDD; never import from `../src`; prefer platform over
  dependencies.

- `console/server/index.ts` — the whole Hono app. Route table (lines 21–58):
  `GET /api/health`, `GET /api/runs`, `GET /api/runs/:runId/events`,
  `GET /api/runs/:runId/recording`, `POST /api/runs` (launches via
  `launchRun`), `POST /api/approvals/:launchId` (approves via
  `approveLaunch`, no body read), `GET /api/events` (SSE), then static SPA
  serving. Server export, lines 112–116:

  ```ts
  const port = Number(process.env.PORT ?? 3000);

  // SSE connections are long-lived; the default 10s idle timeout would sever the
  // /api/events stream before the 15s heartbeat. 255 is Bun's max (0 = disabled).
  export default { port, fetch: app.fetch, idleTimeout: 255 };
  ```

  No `hostname` field → Bun binds `0.0.0.0`. No auth/origin middleware
  anywhere in `console/server/` (verified at planning time).

- `console/server/orchestrator.ts:175-216` — `launchRun` /`approveLaunch`
  implementations (do not modify).

- Dev flow: Vite dev server (port 5177, `console/vite.config.ts:14-18`)
  proxies `/api` to `http://localhost:3000`. Browsers set
  `Origin: http://localhost:5177` on POSTs from the dev SPA; in production
  the SPA is same-origin (`http://localhost:3000` or `http://127.0.0.1:3000`).
  Same-origin POSTs still carry an `Origin` header, so an allowlist of
  localhost origins covers both dev and prod. Non-browser clients (curl,
  scripts) send no `Origin` header at all.

- Existing server test pattern: `console/server/approvals.test.ts` — Bun test
  (`import { test, expect } from "bun:test"`). There is no HTTP-level route
  test yet; middleware can be tested by mounting it on a throwaway `Hono`
  app and calling `app.request(path, init)` (Hono's built-in test helper —
  works under `bun test` with no server bind).

- Baselines at planning time: `bun run typecheck` exit 0;
  `bun test server/` 15 pass / 0 fail.

## Commands you will need

All from `console/`:

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `bun install` | exit 0 |
| Typecheck | `bun run typecheck` | exit 0 |
| Tests | `bun test server/` | 15 existing + new pass, 0 fail |
| Build | `bun run build` | exit 0 |
| Manual bind check | `bun run start` then `lsof -iTCP:3000 -sTCP:LISTEN -n -P` | listener on `127.0.0.1:3000`, not `*:3000` |

## Scope

**In scope** (the only files you should modify):
- `console/server/security.ts` (create — the middleware)
- `console/server/security.test.ts` (create)
- `console/server/index.ts` (wire middleware + hostname)
- `console/README.md` (document the bind default and the env opt-out)
- `plans/README.md` (status row)

**Out of scope** (do NOT touch, even though they look related):
- `console/server/orchestrator.ts`, `state.ts`, `recording.ts`, `bus.ts` —
  no behavior changes there. (A `runId` path-traversal hardening in
  `state.ts:45` is a separate, unplanned finding — leave it.)
- Token/bearer auth for GET routes — deliberately deferred; loopback bind is
  the read-protection story for now.
- `console/src/**` (the SPA needs no change: same-origin requests pass the
  origin check by construction).
- CORS headers — do not add a CORS layer; the goal is to REJECT cross-origin
  writes, not enable them.

## Git workflow

- Branch: `advisor/007-console-server-local-auth`
- Conventional commit, e.g. `fix(console): bind loopback by default, reject cross-origin state-changing requests`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Write the middleware tests (red)

Create `console/server/security.test.ts` (Bun test). Mount the middleware on
a throwaway Hono app:

```ts
import { Hono } from "hono";
import { rejectCrossOriginWrites } from "./security";

const app = new Hono();
app.use("/api/*", rejectCrossOriginWrites);
app.post("/api/runs", (c) => c.json({ ok: true }));
app.get("/api/runs", (c) => c.json({ ok: true }));
```

Cases (use `await app.request("/api/runs", { method, headers })` and assert
status):

1. POST with `Origin: https://evil.example` → 403.
2. POST with `Origin: http://localhost:5177` → 200 (dev SPA via Vite proxy).
3. POST with `Origin: http://127.0.0.1:3000` → 200 (prod SPA).
4. POST with no `Origin` header → 200 (curl/scripts).
5. GET with `Origin: https://evil.example` → 200 (reads are not gated by
   this middleware; loopback bind is their protection).
6. POST with `Origin: http://localhost.evil.example` → 403 (prefix-spoof
   guard — the check must parse the origin's hostname, not substring-match).

**Verify**: `bun test server/security.test.ts` → fails (module doesn't exist).

### Step 2: Implement the middleware (green)

Create `console/server/security.ts` with the two `ABOUTME:` header lines
(repo convention). Shape:

```ts
// ABOUTME: Request-origin guard for the console API — rejects cross-origin
// ABOUTME: state-changing requests so remote sites can't forge launches/approvals.

import type { MiddlewareHandler } from "hono";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

export const rejectCrossOriginWrites: MiddlewareHandler = async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin !== undefined && !isLocalOrigin(origin)) {
      return c.json({ error: "cross-origin request rejected" }, 403);
    }
  }
  await next();
};
```

`isLocalOrigin` must parse with `new URL(origin)` (catch → not local) and
test `LOCAL_HOSTNAMES.has(url.hostname)` — hostname equality, never
`startsWith`/`includes`. Note `URL#hostname` strips brackets from IPv6, so
store `"::1"` not `"[::1]"` — write case 6 first and let the tests decide.

In `console/server/index.ts`, register it before the routes:

```ts
app.use("/api/*", rejectCrossOriginWrites);
```

**Verify**: `bun test server/` → all pass (15 existing + 6 new).

### Step 3: Bind loopback by default

In `console/server/index.ts`, change the export to:

```ts
const port = Number(process.env.PORT ?? 3000);
const hostname = process.env.HOST ?? "127.0.0.1";

export default { port, hostname, fetch: app.fetch, idleTimeout: 255 };
```

Keep the existing SSE idle-timeout comment; add one line noting the loopback
default and that `HOST=0.0.0.0` opts into network exposure.

**Verify**: `bun run start` in one shell; in another,
`lsof -iTCP:3000 -sTCP:LISTEN -n -P` → the listener address is
`127.0.0.1:3000` (not `*:3000`). Then
`curl -s http://127.0.0.1:3000/api/health` → `{"ok":true,...}`. Stop the
server.

### Step 4: Verify the real app end-to-end and document

Manual smoke: with the server from Step 3 running,
- `curl -s -X POST http://127.0.0.1:3000/api/runs -H 'Origin: https://evil.example' -H 'content-type: application/json' -d '{"objective":"x"}'` → HTTP 403.
- Same command without the Origin header → HTTP 200/400-class from the
  route itself (NOT 403) — the guard only rejects foreign origins.

Add a short "Network exposure" section to `console/README.md`: binds
`127.0.0.1` by default; set `HOST=0.0.0.0` (plus your own reverse
proxy/auth) to expose it; cross-origin POSTs are rejected.

**Verify**: `bun run typecheck` → exit 0; `bun test server/` → all pass;
`bun run build` → exit 0.

## Test plan

The six middleware cases in Step 1 (file `console/server/security.test.ts`,
modeled on `approvals.test.ts` for style, but using `app.request` — no
subprocess fixtures needed). The bind change is covered by the manual `lsof`
check in Step 3 (Bun's serve config isn't meaningfully unit-testable without
binding a socket).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun test server/` exits 0 (≥21 tests: 15 existing + 6 new)
- [ ] `bun run typecheck` exits 0; `bun run build` exits 0
- [ ] `grep -n "hostname" console/server/index.ts` → the loopback default present
- [ ] `grep -n "rejectCrossOriginWrites" console/server/index.ts` → registered on `/api/*`
- [ ] Step 4's two curl probes behave as specified (403 with foreign Origin, non-403 without)
- [ ] `console/README.md` documents the bind default and `HOST` opt-out
- [ ] No files outside the in-scope list are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `console/server/index.ts` no longer matches the "Current state" excerpts.
- The Vite dev flow breaks: start `bun run dev`, load the SPA, and if
  launching a run from the UI gets a 403, the dev origin isn't passing the
  allowlist — report the observed `Origin` header value instead of widening
  the allowlist beyond localhost hostnames.
- Bun rejects the `hostname` field in the default-export server config
  (would indicate an old Bun; planning verified on Bun 1.3.9).
- You find an existing reverse-proxy/remote deployment assumption in
  `console/README.md` that loopback binding would break — surface it first.

## Maintenance notes

- The SSE endpoint (`GET /api/events`) and all reads rely on the loopback
  bind for protection, not the origin check. If the console is ever
  deliberately exposed (`HOST=0.0.0.0`), it needs real auth — that's the
  deferred follow-up, and the README section this plan adds should say so.
- If a reverse-proxy deployment appears later, the origin allowlist needs
  the proxy's public origin — make it configurable then (env var), not now.
- Reviewer should scrutinize: hostname equality (case 6) and that no CORS
  headers were added (rejection, not enablement).
- Related unplanned findings intentionally left out: `runId` path traversal
  in `state.ts:45`; iframe `sandbox="allow-scripts allow-same-origin"` in
  `console/src/components/live-view.tsx:17`.
