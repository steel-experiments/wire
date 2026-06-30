// ABOUTME: Tests for the event bus: live delivery, replay, and unsubscribe.

import { test, expect } from "bun:test";
import { EventBus } from "./bus";
import type { RunSummary, ServerEvent } from "../src/lib/protocol";

function run(launchId: string): RunSummary {
  return { launchId, objective: "x", mode: "task", status: "starting", startedAt: "t", stepCount: 0 };
}

test("delivers events live to current subscribers", () => {
  const bus = new EventBus();
  const got: ServerEvent[] = [];
  bus.subscribe((_seq, ev) => got.push(ev));
  bus.publish({ type: "run-started", run: run("a") });
  expect(got).toHaveLength(1);
  expect(got[0]!.type).toBe("run-started");
});

test("replays only events after the given seq for reconnecting subscribers", () => {
  const bus = new EventBus();
  const s1 = bus.publish({ type: "run-started", run: run("a") });
  bus.publish({ type: "run-finished", run: run("a") });
  const replayed: ServerEvent[] = [];
  bus.subscribe((_seq, ev) => replayed.push(ev), s1);
  expect(replayed).toHaveLength(1);
  expect(replayed[0]!.type).toBe("run-finished");
});

test("unsubscribe stops further delivery", () => {
  const bus = new EventBus();
  const got: ServerEvent[] = [];
  const off = bus.subscribe((_seq, ev) => got.push(ev));
  off();
  bus.publish({ type: "run-started", run: run("a") });
  expect(got).toHaveLength(0);
});
