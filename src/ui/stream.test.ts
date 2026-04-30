// ABOUTME: Tests for the live trace stream renderer.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { TraceEvent } from "../shared/types.js";
import { createConsoleTraceSink } from "./stream.js";
import { createPalette, isColorSupported } from "./colors.js";

function ev(kind: TraceEvent["kind"], payload: Record<string, unknown>): TraceEvent {
  return {
    id: "event_test" as TraceEvent["id"],
    runId: "run_test" as TraceEvent["runId"],
    ts: "2026-04-30T00:00:00.000Z",
    kind,
    payload: payload as TraceEvent["payload"],
  };
}

function captureSink(opts: { verbose?: boolean; maxSteps?: number; color?: boolean } = {}): { lines: string[]; sink: ReturnType<typeof createConsoleTraceSink> } {
  const lines: string[] = [];
  const sinkOpts: Parameters<typeof createConsoleTraceSink>[0] = {
    color: opts.color ?? false,
    out: (l: string) => lines.push(l),
  };
  if (opts.verbose !== undefined) sinkOpts.verbose = opts.verbose;
  if (opts.maxSteps !== undefined) sinkOpts.maxSteps = opts.maxSteps;
  const sink = createConsoleTraceSink(sinkOpts);
  return { lines, sink };
}

test("stream renders first observation with [init] prefix", () => {
  const { lines, sink } = captureSink({ maxSteps: 30 });
  sink.onEvent(ev("observation", { url: "https://example.com/page", title: "Example Domain" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\[init  \]/u);
  assert.match(lines[0]!, /◉ observe/u);
  assert.match(lines[0]!, /example\.com/u);
  assert.match(lines[0]!, /Example Domain/u);
});

test("stream renders subsequent observations as continuation (no step number)", () => {
  const { lines, sink } = captureSink({ maxSteps: 10 });
  sink.onEvent(ev("observation", { url: "https://a.com", title: "A" }));
  sink.onEvent(ev("code-exec", { code: "f()" }));
  sink.onEvent(ev("code-result", { ok: true, durationMs: 1 }));
  sink.onEvent(ev("observation", { url: "https://b.com", title: "B" }));
  assert.match(lines[0]!, /\[init  \]/u);
  assert.match(lines[1]!, /\[ 1\/10\]/u);
  assert.ok(!/\[\s*\d/u.test(lines[3]!), `expected no step prefix on follow-up observation: ${JSON.stringify(lines[3])}`);
  assert.match(lines[3]!, /◉ observe/u);
});

test("stream code-exec increments step counter; observations do not", () => {
  const { lines, sink } = captureSink({ maxSteps: 10 });
  sink.onEvent(ev("observation", { url: "https://a.com", title: "A" }));
  sink.onEvent(ev("code-exec", { code: "f()" }));
  sink.onEvent(ev("observation", { url: "https://b.com", title: "B" }));
  sink.onEvent(ev("code-exec", { code: "g()" }));
  sink.onEvent(ev("code-exec", { code: "h()" }));
  assert.match(lines[1]!, /\[ 1\/10\]/u);
  assert.match(lines[3]!, /\[ 2\/10\]/u);
  assert.match(lines[4]!, /\[ 3\/10\]/u);
});

test("stream truncates long code in code-exec line", () => {
  const { lines, sink } = captureSink();
  const longCode = "x".repeat(300);
  sink.onEvent(ev("code-exec", { code: longCode }));
  assert.match(lines[0]!, /⚙ exec/u);
  assert.ok(lines[0]!.includes("…"));
  assert.ok(lines[0]!.length < 300);
});

test("stream code-result prefers returnValue over stdout when ok", () => {
  const { lines, sink } = captureSink();
  sink.onEvent(ev("code-result", {
    ok: true,
    durationMs: 5,
    stdout: "ignored",
    returnValue: { score: 4668 },
  }));
  assert.match(lines[0]!, /→ ok/u);
  assert.match(lines[0]!, /4668/u);
  assert.ok(!lines[0]!.includes("ignored"));
});

test("stream code-result prefers stderr over returnValue when err", () => {
  const { lines, sink } = captureSink();
  sink.onEvent(ev("code-result", {
    ok: false,
    durationMs: 12,
    stderr: "TypeError: x is not a function",
    returnValue: { something: "else" },
  }));
  assert.match(lines[0]!, /→ err/u);
  assert.match(lines[0]!, /TypeError/u);
  assert.ok(!lines[0]!.includes("something"));
});

test("stream renders ↻ marker on repeat code-exec", () => {
  const { lines, sink } = captureSink();
  const code = "[...document.querySelectorAll('button')].find(b=>/start bot/i.test(b.textContent))";
  sink.onEvent(ev("code-exec", { code }));
  sink.onEvent(ev("code-exec", { code }));
  sink.onEvent(ev("code-exec", { code }));
  // Different code resets the counter.
  sink.onEvent(ev("code-exec", { code: "doSomethingElse()" }));
  sink.onEvent(ev("code-exec", { code: "doSomethingElse()" }));
  assert.ok(!lines[0]!.includes("↻"), `first occurrence should not have repeat marker: ${lines[0]}`);
  assert.match(lines[1]!, /↻×2/u);
  assert.match(lines[2]!, /↻×3/u);
  assert.ok(!lines[3]!.includes("↻"), "different code resets repeat counter");
  assert.match(lines[4]!, /↻×2/u);
});

test("stream hides policy-check by default, shows in verbose", () => {
  const quiet = captureSink();
  quiet.sink.onEvent(ev("policy-check", { result: "allow", policyKind: "exec" }));
  assert.equal(quiet.lines.length, 0);

  const loud = captureSink({ verbose: true });
  loud.sink.onEvent(ev("policy-check", { result: "deny", policyKind: "exec.dangerous" }));
  assert.equal(loud.lines.length, 1);
  assert.match(loud.lines[0]!, /⛔ deny/u);
});

test("stream shows skill-load by default with friendly labels when available", () => {
  const { lines, sink } = captureSink();
  sink.onEvent(ev("skill-load", {
    skills: ["skill_uuid_one", "skill_uuid_two"],
    labels: ["apple_com", "google_com"],
    hostname: "apple.com",
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /▸ skills/u);
  assert.match(lines[0]!, /apple_com/u);
  assert.match(lines[0]!, /google_com/u);
  assert.ok(!lines[0]!.includes("skill_uuid"), "should prefer label over raw id");
});

test("stream skill-load falls back to ids when labels are absent", () => {
  const { lines, sink } = captureSink();
  sink.onEvent(ev("skill-load", { skills: ["apple-com", "search-results"], hostname: "apple.com" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /apple-com/u);
});

test("stream skill-load shows '(+N more)' when more than 4 labels", () => {
  const { lines, sink } = captureSink();
  sink.onEvent(ev("skill-load", {
    labels: ["a", "b", "c", "d", "e", "f", "g"],
    skills: ["1", "2", "3", "4", "5", "6", "7"],
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /7:/u);
  assert.match(lines[0]!, /a, b, c, d/u);
  assert.match(lines[0]!, /\(\+3 more\)/u);
});

test("stream skill-load shows full list in verbose", () => {
  const { lines, sink } = captureSink({ verbose: true });
  sink.onEvent(ev("skill-load", {
    labels: ["a", "b", "c", "d", "e", "f", "g"],
    skills: ["1", "2", "3", "4", "5", "6", "7"],
  }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /a, b, c, d, e, f, g/u);
  assert.ok(!lines[0]!.includes("more"), "verbose should show full list with no 'more' suffix");
});

test("stream renders finish thought-summary with done prefix", () => {
  const { lines, sink } = captureSink();
  sink.onEvent(ev("thought-summary", { kind: "finish", summary: "Found price: $1,299" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /\[done\]/u);
  assert.match(lines[0]!, /✓ finish/u);
  assert.match(lines[0]!, /\$1,299/u);
});

test("stream renders error events", () => {
  const { lines, sink } = captureSink();
  sink.onEvent(ev("error", { message: "boom", code: "EAGENT" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /✗ error/u);
  assert.match(lines[0]!, /\[EAGENT\]/u);
  assert.match(lines[0]!, /boom/u);
});

test("stream renders approval-request with continuation prefix", () => {
  const { lines, sink } = captureSink({ maxSteps: 10 });
  sink.onEvent(ev("approval-request", { summary: "Buy MacBook Pro" }));
  assert.match(lines[0]!, /⚠ approval/u);
  assert.match(lines[0]!, /Buy MacBook Pro/u);
});

test("stream renders skill-proposal with done prefix", () => {
  const { lines, sink } = captureSink({ maxSteps: 10 });
  sink.onEvent(ev("skill-proposal", { skillId: "skill_apple", promoted: true }));
  assert.match(lines[0]!, /\[done  \]/u);
  assert.match(lines[0]!, /✦ skill/u);
  assert.match(lines[0]!, /promoted/u);
});

test("stream step prefix turns yellow at >=80% of budget", () => {
  const { lines, sink } = captureSink({ maxSteps: 10, color: true });
  for (let i = 0; i < 10; i++) {
    sink.onEvent(ev("code-exec", { code: `f${i}()` }));
  }
  // Step 8 == 80% → yellow (\x1b[33m)
  assert.ok(lines[7]!.includes("\x1b[33m"), `expected yellow at 80%: ${JSON.stringify(lines[7])}`);
  // Step 10 == 100% → red (\x1b[31m)
  assert.ok(lines[9]!.includes("\x1b[31m"), `expected red at 100%: ${JSON.stringify(lines[9])}`);
});

test("stream step prefix is dim when budget low", () => {
  const { lines, sink } = captureSink({ maxSteps: 10, color: true });
  sink.onEvent(ev("code-exec", { code: "f()" }));
  assert.ok(lines[0]!.includes("\x1b[2m"), `expected dim at low budget: ${JSON.stringify(lines[0])}`);
});

test("colors disabled produces no ANSI codes", () => {
  const { lines, sink } = captureSink();
  sink.onEvent(ev("observation", { url: "https://a.com", title: "A" }));
  sink.onEvent(ev("code-result", { ok: true, durationMs: 5, stdout: "x" }));
  for (const line of lines) {
    assert.ok(!/\x1b\[/u.test(line), `expected no ANSI in: ${JSON.stringify(line)}`);
  }
});

test("isColorSupported respects NO_COLOR and FORCE_COLOR", () => {
  assert.equal(isColorSupported({ NO_COLOR: "1" } as NodeJS.ProcessEnv, true), false);
  assert.equal(isColorSupported({ FORCE_COLOR: "1" } as NodeJS.ProcessEnv, false), true);
  assert.equal(isColorSupported({ FORCE_COLOR: "0" } as NodeJS.ProcessEnv, true), false);
  assert.equal(isColorSupported({} as NodeJS.ProcessEnv, false), false);
  assert.equal(isColorSupported({} as NodeJS.ProcessEnv, true), true);
});

test("createPalette wraps strings only when enabled", () => {
  const off = createPalette(false);
  assert.equal(off.red("x"), "x");
  const on = createPalette(true);
  assert.ok(on.red("x").includes("\x1b["));
});
