// ABOUTME: Integration test — orchestrator spawns a fake wire, parses NDJSON,
// ABOUTME: republishes trace to the bus, and finalizes from the run record.

import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "./bus";
import { launchRun, listRuns } from "./orchestrator";
import type { ServerEvent } from "../src/lib/protocol";

test("launches a run, streams trace events, and finalizes from state", async () => {
  const root = mkdtempSync(join(tmpdir(), "wire-console-"));
  const fixture = join(import.meta.dir, "__fixtures__", "fake-wire.ts");
  process.env.WIRE_ROOT = root;
  process.env.WIRE_CMD = `bun ${fixture}`;

  const bus = new EventBus();
  const events: ServerEvent[] = [];
  const finished = new Promise<void>((resolve) => {
    bus.subscribe((_seq, ev) => {
      events.push(ev);
      if (ev.type === "run-finished") resolve();
    });
  });

  launchRun(bus, { objective: "Return the title of example.com" });
  await finished;

  const traces = events.filter((e) => e.type === "trace");
  expect(traces.length).toBe(4); // session event is captured separately, not a timeline step

  // The session event surfaces the public embeddable player (debugUrl), not the
  // auth-gated dashboard (liveUrl), as the live view URL.
  const withUrl = events.find((e) => e.type !== "trace" && e.run.liveViewUrl);
  expect(withUrl && withUrl.type !== "trace" ? withUrl.run.liveViewUrl : undefined).toBe(
    "https://api.steel.dev/v1/sessions/fake/player",
  );

  const final = events.find((e) => e.type === "run-finished")!;
  if (final.type !== "run-finished") throw new Error("unreachable");
  expect(final.run.status).toBe("finished");
  expect(final.run.runId).toBe("run_fake_test");
  expect(final.run.stepCount).toBe(1);
  expect(final.run.classification).toBe("task-complete");
  expect(final.run.result).toBe("Example Domain");

  // History seeding must not duplicate a run that already ran live this session.
  const all = await listRuns();
  const fake = all.filter((r) => r.runId === "run_fake_test");
  expect(fake).toHaveLength(1);
  expect(fake[0]!.status).toBe("finished");
});
