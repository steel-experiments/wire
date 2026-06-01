// ABOUTME: Tests for crystallizing a completed run's trace into a re-runnable script.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { TraceEvent } from "../shared/types.js";
import { crystallizeRunScript } from "./crystallize.js";

let seq = 0;
function ev(kind: TraceEvent["kind"], payload: Record<string, unknown>): TraceEvent {
  seq += 1;
  return {
    id: `event_${seq}` as TraceEvent["id"],
    runId: "run_test" as TraceEvent["runId"],
    ts: "2026-06-01T00:00:00.000Z",
    kind,
    payload: payload as TraceEvent["payload"],
  };
}

function exec(code: string): TraceEvent {
  return ev("code-exec", { code });
}
function result(ok: boolean, extra: Record<string, unknown> = {}): TraceEvent {
  return ev("code-result", { ok, durationMs: 1, ...extra });
}

test("crystallizes successful exec steps in order, excluding observations", () => {
  const events = [
    ev("observation", { url: "https://example.com", title: "Example" }),
    exec('window.location.href = "https://example.com/page"; return { navigated: true };'),
    result(true),
    ev("observation", { url: "https://example.com/page", title: "Page" }),
    exec("return document.body.innerText;"),
    result(true, { returnValue: "hello" }),
  ];

  const crafted = crystallizeRunScript(events, { objective: "Read the page", runId: "run_test" });

  assert.equal(crafted.steps.length, 2);
  assert.equal(crafted.steps[0]!.intent, "navigate");
  assert.equal(crafted.steps[1]!.intent, "inspect");
  assert.match(crafted.steps[0]!.code, /location\.href/u);
  // Source is an annotated, ordered program carrying both steps.
  assert.match(crafted.source, /Objective: Read the page/u);
  assert.match(crafted.source, /Source run: run_test/u);
  assert.match(crafted.source, /Step 1 \(navigate\)/u);
  assert.match(crafted.source, /Step 2 \(inspect\)/u);
  const navIdx = crafted.source.indexOf("Step 1");
  const inspectIdx = crafted.source.indexOf("Step 2");
  assert.ok(navIdx >= 0 && navIdx < inspectIdx, "steps must appear in execution order");
});

test("drops a failed exec and keeps the successful retry of the same code", () => {
  const code = 'await wire.click(document.querySelector("button"));';
  const events = [
    exec(code),
    result(false, { stderr: "not found" }),
    exec(code),
    result(true),
  ];

  const crafted = crystallizeRunScript(events, {});

  assert.equal(crafted.steps.length, 1, "only the successful attempt is crystallized");
  assert.equal(crafted.steps[0]!.intent, "interact");
});

test("ignores raw-command execs (no code string) and trailing exec with no result", () => {
  const events = [
    ev("code-exec", { rawCommands: 1, methods: ["Input.dispatchMouseEvent"] }),
    result(true),
    exec("return 1;"),
    result(true),
    exec("return 2;"), // no result event follows — unresolved, must be dropped
  ];

  const crafted = crystallizeRunScript(events, {});

  assert.equal(crafted.steps.length, 1);
  assert.equal(crafted.steps[0]!.code, "return 1;");
});

test("includeFailed keeps failed steps annotated as failed", () => {
  const events = [exec("return boom();"), result(false, { stderr: "boom is not defined" })];

  const crafted = crystallizeRunScript(events, { includeFailed: true });

  assert.equal(crafted.steps.length, 1);
  assert.equal(crafted.steps[0]!.ok, false);
  assert.match(crafted.source, /FAILED/u);
});

test("a run with no successful execs yields zero steps and a self-describing header", () => {
  const crafted = crystallizeRunScript([ev("observation", { url: "https://x.com" })], { objective: "Nothing ran" });

  assert.equal(crafted.steps.length, 0);
  assert.match(crafted.source, /Objective: Nothing ran/u);
  assert.match(crafted.source, /no successful browser steps/iu);
});

test("omits the Generated line when no timestamp is supplied (deterministic output)", () => {
  const a = crystallizeRunScript([exec("return 1;"), result(true)], {});
  const b = crystallizeRunScript([exec("return 1;"), result(true)], {});
  assert.equal(a.source, b.source);
  assert.ok(!a.source.includes("Generated:"));

  const stamped = crystallizeRunScript([exec("return 1;"), result(true)], { generatedAt: "2026-06-01T00:00:00.000Z" });
  assert.match(stamped.source, /Generated: 2026-06-01T00:00:00\.000Z/u);
});
