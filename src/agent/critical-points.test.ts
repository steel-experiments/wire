// ABOUTME: Tests for LLM-authored critical-point checklists and per-criterion review.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Task } from "../shared/types.js";
import type { ChatMessage, ChatResponse, LLMProvider } from "../providers/llm/openai.js";
import {
  parseCriticalPoints,
  proposeCriticalPoints,
  criticalPointsToChecklist,
  parseCriterionVerdicts,
  summarizeCriticalPointReview,
  reviewCriticalPoints,
  type CriticalPoint,
} from "./critical-points.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "CP test",
    mode: "task",
    objective: "Open vercel.com and netlify.com and save a pricing comparison table",
    constraints: [],
    successCriteria: ["Table has both vendors"],
    createdAt: nowIsoUtc(),
    ...overrides,
  };
}

// A fake provider that returns canned content (or throws) so the LLM-calling
// functions can be exercised deterministically without a network.
function fakeLlm(content: string | (() => never)): LLMProvider {
  return {
    model: "fake",
    chat: async (_messages: ChatMessage[]): Promise<ChatResponse> => {
      if (typeof content === "function") content();
      return { content: content as string, model: "fake" };
    },
  };
}

const points: CriticalPoint[] = [
  { id: "cp1", text: "Visit vercel.com pricing" },
  { id: "cp2", text: "Visit netlify.com pricing" },
];

test("parseCriticalPoints assigns sequential ids and trims a string array", () => {
  const parsed = parseCriticalPoints('["Visit vercel.com", "  Visit netlify.com  ", ""]');
  assert.deepEqual(parsed, [
    { id: "cp1", text: "Visit vercel.com" },
    { id: "cp2", text: "Visit netlify.com" },
  ]);
});

test("parseCriticalPoints tolerates code fences and {text} objects", () => {
  const parsed = parseCriticalPoints('```json\n[{"text":"A"},{"text":"B"}]\n```');
  assert.deepEqual(parsed.map((p) => p.text), ["A", "B"]);
  assert.deepEqual(parsed.map((p) => p.id), ["cp1", "cp2"]);
});

test("parseCriticalPoints returns [] for NONE or unparseable content", () => {
  assert.deepEqual(parseCriticalPoints("NONE"), []);
  assert.deepEqual(parseCriticalPoints("the model rambled with no json"), []);
});

test("proposeCriticalPoints returns parsed points, and [] when the LLM throws", async () => {
  const ok = await proposeCriticalPoints(makeTask(), fakeLlm('["Visit vercel.com","Visit netlify.com"]'));
  assert.equal(ok.length, 2);
  assert.equal(ok[0]!.id, "cp1");

  const degraded = await proposeCriticalPoints(makeTask(), fakeLlm(() => { throw new Error("boom"); }));
  assert.deepEqual(degraded, []);
});

test("criticalPointsToChecklist renders an enumerated checklist", () => {
  const checklist = criticalPointsToChecklist(points);
  assert.match(checklist, /cp1: Visit vercel\.com pricing/u);
  assert.match(checklist, /cp2: Visit netlify\.com pricing/u);
});

test("parseCriterionVerdicts tolerates string booleans and case-mismatched ids", () => {
  // Common LLM deviations must not falsely mark a met criterion as unmet (which
  // would fail a genuinely complete task): met as the string "true", and an
  // upper-cased id "CP1" against the canonical "cp1".
  const verdicts = parseCriterionVerdicts(
    '[{"id":"CP1","met":"true"},{"id":"cp2","met":"yes"}]',
    points,
  );
  assert.equal(verdicts.find((v) => v.id === "cp1")!.met, true);
  assert.equal(verdicts.find((v) => v.id === "cp2")!.met, true);
});

test("parseCriterionVerdicts maps by id and defaults missing criteria to unmet", () => {
  const verdicts = parseCriterionVerdicts(
    '[{"id":"cp1","met":true,"note":"seen"},{"id":"cp999","met":true}]',
    points,
  );
  assert.equal(verdicts.length, 2);
  assert.equal(verdicts.find((v) => v.id === "cp1")!.met, true);
  // cp2 had no verdict in the response → defaults to unmet, not silently passed.
  assert.equal(verdicts.find((v) => v.id === "cp2")!.met, false);
});

test("summarizeCriticalPointReview passes only when every point is met", () => {
  const allMet = summarizeCriticalPointReview(points, [
    { id: "cp1", met: true },
    { id: "cp2", met: true },
  ]);
  assert.equal(allMet.passed, true);
  assert.deepEqual(allMet.unmet, []);

  const oneMissing = summarizeCriticalPointReview(points, [
    { id: "cp1", met: true },
    { id: "cp2", met: false, note: "no netlify evidence" },
  ]);
  assert.equal(oneMissing.passed, false);
  assert.deepEqual(oneMissing.unmet, ["Visit netlify.com pricing"]);
});

test("summarizeCriticalPointReview with no points does not gate (passes)", () => {
  const review = summarizeCriticalPointReview([], []);
  assert.equal(review.passed, true);
});

test("reviewCriticalPoints judges per criterion and degrades to pass on LLM failure", async () => {
  const judged = await reviewCriticalPoints(
    makeTask(),
    points,
    "evidence text",
    fakeLlm('[{"id":"cp1","met":true},{"id":"cp2","met":false,"note":"missing"}]'),
  );
  assert.equal(judged.passed, false);
  assert.deepEqual(judged.unmet, ["Visit netlify.com pricing"]);

  const degraded = await reviewCriticalPoints(
    makeTask(),
    points,
    "evidence",
    fakeLlm(() => { throw new Error("network"); }),
  );
  assert.equal(degraded.passed, true, "a reviewer failure must not block completion");
});
