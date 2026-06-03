# Proposal: Session Agent

**Run Wire where the browser runs.**

Status: Draft · Owner: Niko · Date: 2026-06-02

---

## The idea in one line

Steel sessions already host a real browser in an isolated VM. Let them host the
agent too — so a Wire run executes *inside* the session, against loopback CDP,
with nothing leaving the box except the LLM call and the final evidence.

## Why now

Today the brain is local and the hands are remote.

Wire is a Node CLI on your host. It holds `STEEL_API_KEY` and your LLM key, runs
the observe→exec→policy loop locally (`src/agent/runtime.ts`), and drives the
browser over a `wss://` CDP connection to a Steel session created via
`POST /v1/sessions` (`src/providers/browser/steel.ts:317`).

That split is fine, but it means:

- The agent loop and your credentials sit on a trusted host. A rogue run —
  prompt injection, a hostile page steering the agent — has blast radius equal
  to that host.
- Every observe/exec round-trip crosses the public internet as CDP traffic.
- "Give me an isolated, disposable run" is not a primitive. You build it
  yourself with containers and supervision.

Steel already solved isolation for the browser. The Session Agent extends that
same isolation to the agent.

## What it is

A per-session, sandboxed code-runner inside the Steel VM that:

1. Accepts a **task spec** + a **Wire bundle** at session create (or via a new
   endpoint on an existing session).
2. Runs the Wire loop against **`localhost` CDP** — no public CDP egress.
3. Streams **events and artifacts** back out through the existing session
   channels (viewer URL, events, run record).
4. Dies with the session. Disposable by construction.

The browser sandbox Steel already ships gets a sibling: an agent sandbox in the
same VM, talking to Chrome over loopback.

## Why Wire fits this with zero violence

Wire is deliberately light: Node 22 + `zod` + file-based skills. Nothing about
the loop assumes it runs on your laptop.

- The browser provider already takes a base URL (`STEEL_BASE_URL`) and a CDP
  WebSocket URL (`src/providers/browser/steel.ts:43`). Point both at loopback
  and the agent doesn't know the difference.
- `exec` actions already run *inside the page* via CDP `Runtime.evaluate`. The
  action language is already sandboxed. This proposal sandboxes the part that
  isn't yet — the loop and the keys.
- Runs already serialize to a run record with checkpoints
  (`src/storage/checkpoints.ts`), so streaming them out of the VM is a transport
  change, not a model change.

No rewrite. The same binary that runs on your host runs in the session.

## Boundaries (what must not be mixed)

This is core-adjacent product surface, so the seams matter.

- **The agent runner is not the browser.** It is a separate process in the VM,
  not code injected into Chrome. Keep them as two processes sharing loopback,
  not one fused thing.
- **The task spec is not a prompt blob.** It carries objective, policy, skill
  references, and provider config as structured fields — the same shape
  `executeTask` already takes (`src/agent/runtime.ts:913`).
- **The LLM key is the one thing that still has to enter the VM.** Treat it as
  such: short-TTL, scoped, injected per run, never baked into an image. This is
  the single most important security decision in the proposal.
- **Skills stay files.** The bundle ships skill markdown into the VM filesystem;
  the loader (`src/skills/loader.ts`) is unchanged. No secret-bearing skills.

## Surface sketch (for discussion, not final)

Extend session create with an optional `agent` block:

```jsonc
POST /v1/sessions
{
  "agent": {
    "bundle": "wire@<version>",        // pinned agent image/bundle ref
    "task": {
      "objective": "…",
      "policy": { /* policy rules */ },
      "skills": ["github.com/...", "…"],
      "provider": { "name": "anthropic", "model": "…" }
    },
    "secrets": { "LLM_KEY_REF": "<scoped, short-TTL ref>" },
    "stream": ["events", "artifacts"]
  }
}
```

Response adds an agent run handle alongside the existing session fields:

```jsonc
{
  "id": "session_…",
  "websocketUrl": "wss://…",           // still available for external drivers
  "sessionViewerUrl": "https://…",
  "agentRun": {
    "id": "run_…",
    "eventsUrl": "https://…",          // SSE/stream of loop events
    "resultUrl": "https://…"           // final evidence + run record
  }
}
```

Open questions deliberately left open:

- Bundle distribution: pinned image vs. uploaded tarball vs. registry ref.
- Whether the runner is generic (any agent) or Wire-shaped first.
- Egress policy: does the VM allow only LLM + result endpoints by default?
- Pricing unit: session-seconds already exist; does an agent run add a tier?

## Fit with Steel's actual architecture (Firecracker)

This is not a generic-container proposal. It lands on what Steel already runs,
and the fit is close enough that most of the hard parts already exist.

Steel today: one real Chrome per **Firecracker microVM** on GCP Nomad, one
active session at a time (`activeSessionId`), CDP local to the box, the
deployable unit a **rootfs `.ext4` artifact + kernel** (not a Docker image),
processes supervised via the entrypoint + `chrome-cpuset` wrapper, lifecycle
managed by drain/undrain, orchestration over NATS request-reply, fed by a warm
VM pool. The security boundary is the hypervisor, not namespaces.

What that buys the Session Agent, mostly for free:

- **Isolation is already there, and it's hypervisor-grade.** "Blast radius = the
  disposable VM" is literally true — Firecracker, not a container. Wire-in-VM
  inherits it.
- **One Chrome, one session per VM** → an agent run cleanly *owns* the box for
  its duration. No multi-tenant agent concerns; loopback CDP with no contention.
- **drain/undrain already is agent-run lifecycle** — finish the active run, then
  recycle. Reuse it; don't recycle a VM mid-run.
- **managed-browser already supervises Chrome + FFmpeg.** Wire becomes a *third
  supervised process*, launched/killed off the same `activeSessionId`
  transitions.
- **NATS + artifact store already exist** as the transport for events and
  results. `eventsUrl`/`resultUrl` map onto plumbing Steel already operates.
- **Warm pool** → if the runner ships in the rootfs, added cold-start is ~one
  process spawn.

The genuinely new work, scoped honestly:

1. **Rootfs integration (the main lift).** Bake a pinned **Node runtime + a thin
   `wire-runner` shim** into the managed-browser `.ext4`. Do *not* bake the full
   agent + task — that couples Wire's release cadence to browser releases.
   Deliver the **pinned Wire bundle ref + task spec at session-create over
   NATS**. This is the concrete answer to the "bundle distribution" open
   question above: stable shim in the image, versioned bundle + task at runtime.
2. **Lifecycle hook** in managed-browser: launch Wire on session-active, tie its
   completion into drain so the VM isn't recycled mid-run.
3. **Runtime secret injection** — and the architecture *forces the right answer*:
   the rootfs is a **shared artifact across many VMs**, so the LLM key can never
   be baked in. It must arrive at session-create over NATS, short-TTL and scoped.
   The single most important security decision is made correct by construction.
4. **A cpuset carve.** Chrome ~85% / FFmpeg ~15% leaves nothing named for Wire,
   but Wire is **I/O-bound** — nearly all wall-clock is blocked on the LLM call
   and CDP waits — so a thin slice (≈5% off Chrome) is plenty. Confirm a real
   number on the smallest VM size before committing. Tuning, not a blocker.

This is a contained, well-bounded build, not a research project: a sprint-scale
spike to a working internal demo. The new pieces are rootfs bake + lifecycle
hook + scoped secret injection. Everything else, Steel already operates.

## What we get

- **Real isolation for the whole run**, not just the browser. Blast radius =
  the disposable, single-tenant, hypervisor-isolated VM.
- **CDP stays on loopback.** The agent↔browser round-trips that cross the public
  internet today stay inside the VM.
- **A disposable-run primitive** Steel customers can call directly instead of
  rebuilding with their own VM/container supervision.
- **A product story only Steel can tell**: "your agent runs where the browser
  runs, fully isolated." Wire becomes the reference agent for it.

## What it costs / risks

- **Credential surface.** The LLM key enters an ephemeral VM. Mitigated by
  short-TTL scoped keys, never by image baking. Non-negotiable.
- **New product surface to maintain.** A code-runner in the VM is more than a
  CDP endpoint. It needs its own lifecycle, limits, and observability.
- **Egress is not the win — be honest about it.** Chrome in the VM already needs
  broad open-web egress, so colocating Wire does *not* shrink the network
  surface. What we actually gain is: CDP stays loopback (no agent↔browser
  internet traffic) and the agent + credentials are confined to a disposable,
  single-tenant VM. We trade CDP-over-internet for LLM-over-internet on top of
  the browser's existing web egress. Pitch this as **per-run hypervisor-isolated
  agent execution**, not as egress reduction.
- **Generality pull.** "Run any agent in a session" is tempting and will balloon
  scope. Start Wire-shaped, prove it, generalize only if demand is real.

## The fallback that ships today

Self-hosted `steel-browser` is a Docker image (Node 22 + Chromium + Fastify API,
CDP on `ws://localhost:3000`). Building one image of `steel-browser` + the Wire
CLI, with `STEEL_BASE_URL` pointed at loopback, gives the same isolated-run
shape *now* with no Wire changes — just a Dockerfile and two env vars.

That self-hosted sidecar is the proof of concept. This proposal is the same
model, productized on Steel Cloud so customers don't have to build it.

## Recommendation

1. Build the self-hosted sidecar first. It validates the loopback-CDP model and
   the credential handling with near-zero risk.
2. Use it to settle the open questions — bundle format, egress policy, pricing.
3. Then ship the Session Agent as a Steel Cloud primitive, Wire-shaped first.

---

*References:* Wire loop — `src/agent/runtime.ts`, `src/agent/loop.ts`. Steel
provider — `src/providers/browser/steel.ts`. Skills — `src/skills/loader.ts`.
Steel self-hosting — https://docs.steel.dev/overview/self-hosting/docker.
