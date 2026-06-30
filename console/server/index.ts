// ABOUTME: Hono server for Wire Console — launch API, multiplexed SSE, the SPA.
// ABOUTME: Runs on Bun; in dev only the API is hit (Vite serves the frontend).

import { loadRepoEnv } from "./env";

// Share the Wire repo's STEEL_API_KEY (and WIRE_* overrides) before anything reads env.
loadRepoEnv();

import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { streamSSE } from "hono/streaming";
import type { LaunchRequest, ServerEvent } from "../src/lib/protocol";
import { EventBus } from "./bus";
import { approveLaunch, launchRun, listRuns } from "./orchestrator";
import { listRunEvents } from "./state";
import { runRecordingPlaylist } from "./recording";

const app = new Hono();
const bus = new EventBus();

app.get("/api/health", (c) => c.json({ ok: true, name: "wire-console" }));

app.get("/api/runs", async (c) => c.json({ runs: await listRuns() }));

app.get("/api/runs/:runId/events", async (c) =>
  c.json({ events: await listRunEvents(c.req.param("runId")) }),
);

// Returns the Steel HLS recording playlist (raw m3u8). hls.js loads this URL
// directly; the segment URLs inside are public signed CDN URLs.
app.get("/api/runs/:runId/recording", async (c) => {
  const playlist = await runRecordingPlaylist(c.req.param("runId"));
  if (!playlist) return c.text("recording unavailable", 404);
  return new Response(playlist, { headers: { "content-type": "application/vnd.apple.mpegurl" } });
});

app.post("/api/runs", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as Partial<LaunchRequest>;
  if (!body.objective || body.objective.trim().length === 0) {
    return c.json({ error: "objective is required" }, 400);
  }
  const run = launchRun(bus, {
    objective: body.objective.trim(),
    ...(body.mode ? { mode: body.mode } : {}),
    ...(body.maxSteps ? { maxSteps: body.maxSteps } : {}),
    ...(body.provider ? { provider: body.provider } : {}),
    ...(body.model ? { model: body.model } : {}),
  });
  return c.json({ run });
});

// The one state mutation the console performs: approve a gated action and
// resume the run via `wire approve`.
app.post("/api/approvals/:launchId", (c) => {
  const result = approveLaunch(bus, c.req.param("launchId"));
  if (!result.ok) return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

// Multiplexed live stream of every run's events. Reconnects replay from the
// Last-Event-ID the browser sends automatically.
app.get("/api/events", (c) =>
  streamSSE(c, async (stream) => {
    const since = Number(c.req.header("Last-Event-ID") ?? "0") || 0;
    const queue: { seq: number; event: ServerEvent }[] = [];
    let wake: (() => void) | null = null;

    const unsubscribe = bus.subscribe((seq, event) => {
      queue.push({ seq, event });
      wake?.();
    }, since);

    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });

    // Flush a byte immediately so proxies (e.g. Vite dev) forward the response
    // headers at once and the client's EventSource fires `open` right away —
    // otherwise the first data wouldn't arrive until the 15s heartbeat.
    await stream.writeSSE({ event: "ping", data: "" });

    try {
      while (!stream.aborted) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            wake = resolve;
            setTimeout(resolve, 15_000);
          });
          wake = null;
          if (stream.aborted) break;
          if (queue.length === 0) {
            await stream.writeSSE({ event: "ping", data: "" });
            continue;
          }
        }
        const item = queue.shift()!;
        await stream.writeSSE({ id: String(item.seq), data: JSON.stringify(item.event) });
      }
    } finally {
      unsubscribe();
    }
  }),
);

// Serve the built SPA in production. In dev, Vite owns the frontend and proxies
// /api here, so these static routes are only exercised after `bun run build`.
app.use("/assets/*", serveStatic({ root: "./dist" }));
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

const port = Number(process.env.PORT ?? 3000);

// SSE connections are long-lived; the default 10s idle timeout would sever the
// /api/events stream before the 15s heartbeat. 255 is Bun's max (0 = disabled).
export default { port, fetch: app.fetch, idleTimeout: 255 };
