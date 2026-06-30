// ABOUTME: Integration test for the approval gate: pause on approval-request,
// ABOUTME: then resume to completion via approveLaunch -> `wire approve`.

import { test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventBus } from "./bus";
import { approveLaunch, launchRun } from "./orchestrator";
import type { RunSummary, ServerEvent } from "../src/lib/protocol";

test("surfaces a pending approval, then resumes and finishes on approve", async () => {
  const root = mkdtempSync(join(tmpdir(), "wire-appr-"));
  const fixture = join(import.meta.dir, "__fixtures__", "fake-wire-approval.ts");
  process.env.WIRE_ROOT = root;
  process.env.WIRE_CMD = `bun ${fixture}`;

  const bus = new EventBus();
  let awaiting: RunSummary | undefined;
  const reachedGate = new Promise<void>((resolve) => {
    bus.subscribe((_seq, ev: ServerEvent) => {
      if (ev.type === "run-finished" && ev.run.status === "awaiting-approval") {
        awaiting = ev.run;
        resolve();
      }
    });
  });

  const run = launchRun(bus, { objective: "Buy the thing" });
  await reachedGate;

  expect(awaiting?.status).toBe("awaiting-approval");
  expect(awaiting?.pendingApproval?.approvalId).toBe("appr_1");
  expect(awaiting?.pendingApproval?.riskKind).toBe("purchase");

  let finished: RunSummary | undefined;
  const resumedDone = new Promise<void>((resolve) => {
    bus.subscribe((_seq, ev: ServerEvent) => {
      if (ev.type === "run-finished" && ev.run.status === "finished") {
        finished = ev.run;
        resolve();
      }
    });
  });

  const result = approveLaunch(bus, run.launchId);
  expect(result.ok).toBe(true);
  await resumedDone;

  expect(finished?.status).toBe("finished");
  expect(finished?.classification).toBe("task-complete");
  expect(finished?.pendingApproval).toBeUndefined();
});

test("approveLaunch rejects when there is no pending approval", () => {
  const bus = new EventBus();
  expect(approveLaunch(bus, "does-not-exist")).toEqual({ ok: false, error: "unknown run" });
});
