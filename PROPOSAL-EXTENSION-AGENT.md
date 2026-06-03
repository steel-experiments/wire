# Proposal: Extension Agent

**The agent rides inside Chrome.**

Status: Draft · Owner: Niko · Date: 2026-06-03

Sibling to [`PROPOSAL-SESSION-AGENT.md`](PROPOSAL-SESSION-AGENT.md). Same goal —
run Wire where the browser runs — but the most literal form of it: the agent is
not a process beside Chrome, it is *inside* Chrome.

---

## The idea in one line

Steel launches Chrome with the Wire extension preloaded. The agent runs in the
extension's service worker, attaches to the tab via `chrome.debugger`, and drives
the session over **in-process CDP** — no external WebSocket, no CDP egress. The
agent genuinely lives in the browser and takes it over from within.

## How it actually works

A normal web page can't touch the browser — the sandbox forbids it, by design.
The escape hatch is not the page; it's the **launch**. Steel controls how Chrome
starts, so Steel can grant the agent a privilege a page can never grant itself:
extension permissions.

The mechanism:

- Chrome is launched with the Wire extension loaded (`--load-extension`, or
  packed and force-installed). The extension declares the **`debugger`**
  permission.
- The extension's **MV3 service worker** is the agent host. It runs the Wire
  loop in JS (WASM-backed if a component wants it).
- It attaches to the active tab via **`chrome.debugger.attach`** and issues CDP
  commands — `Page.navigate`, `Runtime.evaluate`, `DOM.*` — exactly the surface
  Wire already speaks (`src/providers/browser/steel.ts`). `chrome.debugger` *is*
  CDP, exposed in-process to a privileged extension. Chrome 125+ supports flat
  sessions, so one attach drives child targets without re-attaching.
- Nothing leaves the browser to drive the browser. The CDP transport is the
  in-process extension API, not a `wss://` socket.

So the picture is: fire a Steel session → Chrome boots with Wire inside → the
service worker takes the wheel via `chrome.debugger` → the run streams evidence
out → the VM is recycled.

## Fit with Steel's architecture (Firecracker)

This rides the same substrate as the sidecar proposal, and the injection point
is even simpler.

- **The extension ships in the rootfs.** The managed-browser `.ext4` already
  carries Chrome + FFmpeg + the `chrome-cpuset` wrapper. Add the packed Wire
  extension to the image; have the launch wrapper pass `--load-extension`. No
  separate process to supervise — Chrome *is* the process, and the agent lives
  in its extension worker.
- **One Chrome, one session per VM** → the extension worker owns the session for
  its lifetime. No multi-tenant concerns.
- **Isolation is identical to the sidecar.** Firecracker is the boundary either
  way. Running in-Chrome buys *no extra isolation* over a sidecar process on this
  substrate — be clear-eyed about that. What it buys is "literally inside the
  browser," not "more sandboxed."
- **drain/undrain** still bounds the run; recycle the VM when the worker reports
  done or times out.
- **Secrets at runtime, never baked.** The rootfs (and the extension in it) is a
  shared artifact across many VMs, so the LLM key arrives at session-create over
  NATS, short-TTL and scoped — same rule as the sidecar, same reason.

## Surface sketch

Reuse the `agent` block from the session-agent proposal; add a runner selector:

```jsonc
POST /v1/sessions
{
  "agent": {
    "runner": "extension",             // vs "sidecar"
    "bundle": "wire-ext@<version>",    // packed extension, pinned
    "task": { "objective": "…", "policy": { }, "skills": [ ], "provider": { } },
    "secrets": { "LLM_KEY_REF": "<scoped, short-TTL ref>" },
    "stream": ["events", "artifacts"]
  }
}
```

The task spec is delivered to the worker at startup (extension storage seeded at
launch, or a one-shot message from the launch wrapper). Events and results flow
out the same way as the sidecar — over the worker's `fetch` to a Steel ingest
endpoint, landing in the existing artifact store.

## What this costs — the honest part

This is a **host rewrite**, not an env-var change. The Wire loop core
(observe→exec→policy) can survive; the runtime around it cannot. Three hard
walls:

1. **No filesystem.** Wire's file-based skills (`src/skills/loader.ts`) can't
   `fs.read` in a service worker. Skills must be bundled into the extension or
   fetched and cached in extension storage. This dents the file-as-source-of-
   truth, grep-the-skills inspectability the manifesto leans on — the single
   biggest philosophical cost.
2. **No Node APIs.** No `process`, no `fs`, no Node CLI shape. The agent becomes
   service-worker code. LLM calls via `fetch` are fine; the rest needs porting.
3. **MV3 service worker lifetime is the real technical risk.** MV3 workers are
   *ephemeral* — Chrome terminates them after ~30s idle. An agent run is mostly
   idle: long waits on the LLM call and on page settles. A naively-ported loop
   will get its worker killed mid-run. This is solvable but it is **the** thing
   to prototype first:
   - Active `chrome.debugger` traffic and `chrome.alarms` pings reset the idle
     timer; an offscreen document can hold longer-lived state.
   - State must be checkpointed to `chrome.storage` so a worker restart resumes
     rather than loses the run — Wire already checkpoints
     (`src/storage/checkpoints.ts`), so the model survives; the storage backend
     changes.
   - Validate a multi-minute run with 30s+ LLM stalls survives worker churn
     before committing to this path.

WASM, to be explicit, is optional and orthogonal to all of the above. The loop
is JS; running it in the worker needs no WASM. WASM only earns its place if a
component is non-JS or wants a tighter sub-sandbox — it does **not** unlock any
browser control the JS worker doesn't already have via `chrome.debugger`.

## Sidecar vs extension — pick per purpose

| | **Sidecar** (session-agent) | **Extension** (this doc) |
|---|---|---|
| Where the agent runs | Node process in the VM, loopback CDP | Chrome MV3 service worker, `chrome.debugger` |
| Injection | Node + runner shim in rootfs | packed extension in rootfs + `--load-extension` |
| Wire changes | ~none (env + base URL) | substantial host rewrite |
| Skills | stay files on disk | bundled / `chrome.storage` |
| Isolation on Firecracker | hypervisor VM | identical — no extra gain |
| Long-idle runs | trivial (a normal process) | must beat MV3 worker eviction |
| "Inside Chrome" | colocated, separate process | literally inside the browser |
| Manifesto fit | clean | strains file-skills + inspectability |

The honest conclusion: on Steel's Firecracker substrate the extension delivers
**no isolation the sidecar doesn't already give**, while costing a host rewrite
and a fight with service-worker lifetime. Its value is not security — it's that
it is *literally the agent driving Chrome from inside Chrome*, distributable as a
single browser artifact with zero separate process.

## When it's worth it

- **As a demo / proof.** "Fire a browser, the agent is already inside it, taking
  over" is a genuinely striking artifact and a clean story. High signal.
- **Single-artifact distribution.** One packed extension, no companion runtime —
  attractive for customers who can't or won't run a sidecar process.
- **A path to in-page / no-CDP automation** later, if `chrome.debugger` ever
  feels heavier than needed for simple tasks.

It is **not** the production default. On this infra, the sidecar wins on effort,
manifesto fit, and operational simplicity for equal isolation.

## Plan

1. **De-risk the killer first.** Spike *only* the MV3 worker-lifetime question:
   a stub extension running a fake loop with 30–90s idle stalls, driven by
   `chrome.debugger`, checkpointing to `chrome.storage`. Prove a multi-minute run
   survives worker eviction. If this fails cheaply, stop here.
2. **Port the loop.** Lift observe→exec→policy into the worker; swap the CDP
   transport from `wss://` to `chrome.debugger`; swap the skills loader to a
   bundled/`chrome.storage` source; swap checkpoints to `chrome.storage`.
3. **Bake + launch.** Add the packed extension to the managed-browser rootfs;
   teach the `chrome-cpuset` launch wrapper to `--load-extension`; seed the task
   spec and inject the scoped LLM key at session-create over NATS.
4. **Wire the run lifecycle.** Stream events/artifacts out via worker `fetch` to
   the existing ingest path; tie completion into drain so the VM recycles.
5. **Demo, then decide.** Show it. If the story justifies maintaining a second
   runtime, keep it as the `runner: "extension"` option alongside the sidecar.
   Otherwise it remains a proof and the sidecar ships.

## Recommendation

Build the **sidecar** as the production Session Agent (see the sibling proposal).
Build the **extension** as a time-boxed spike whose first and only gate is the
MV3 worker-lifetime test. Treat it as the flagship *demo* of "the agent lives in
the browser," and promote it to a supported runner only if the demo earns the
cost of a second runtime.

---

*References:* Wire loop — `src/agent/runtime.ts`, `src/agent/loop.ts`. CDP / Steel
provider — `src/providers/browser/steel.ts`. Skills — `src/skills/loader.ts`.
Checkpoints — `src/storage/checkpoints.ts`. `chrome.debugger` —
https://developer.chrome.com/docs/extensions/reference/api/debugger.
