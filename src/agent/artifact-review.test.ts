// ABOUTME: Tests the artifact-review gate, especially that bare factoid/Q&A
// ABOUTME: tasks (no contract) still get reviewed against their objective.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { SessionId, Task, TraceEvent } from "../shared/types.js";
import type { LLMProvider } from "../providers/llm/openai.js";

import { createLoopState, type LoopState } from "./loop.js";
import { artifactReviewPayload, reviewArtifacts, shouldReviewArtifacts } from "./artifact-review.js";

function makeSessionId(): SessionId {
  return createId("session");
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Test task",
    mode: "task",
    objective: "Complete a test task",
    constraints: [],
    successCriteria: [],
    createdAt: nowIsoUtc(),
    ...overrides,
  };
}

const stubLlm: LLMProvider = {
  model: "test-model",
  async chat() {
    return { content: "{}", model: "test-model" };
  },
};

function pushArtifact(state: LoopState, content: string): void {
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: { kind: "json-output", content },
  } as TraceEvent);
}

// The crossword run (run_4bc61515): the objective is a bare question with no
// domain, save, or table keyword, so the inferred contract is empty. The agent
// passed off a crossword table as the answer and finished — the reviewer that
// would catch it was skipped because the gate required a non-empty contract.
test("shouldReviewArtifacts reviews bare factoid tasks with no contract", () => {
  const task = makeTask({
    objective: "What was the name of the 5K race at the old Great America park?",
  });
  const state = createLoopState(task, makeSessionId());
  // Contract really is empty — this is the case that used to skip review.
  assert.equal(state.contract.mustVisit.length, 0);
  assert.equal(state.contract.mustMention.length, 0);
  assert.equal(state.contract.mustProduce, undefined);
  assert.equal(state.contract.mustNotContain.length, 0);

  pushArtifact(state, JSON.stringify({ rows: [["", "SHE", "clue"]] }));

  assert.equal(
    shouldReviewArtifacts(state, { llmProvider: stubLlm }),
    true,
    "a task-mode run with a fresh artifact must be reviewed against its objective",
  );
});

test("shouldReviewArtifacts skips when there is no fresh artifact", () => {
  const state = createLoopState(makeTask(), makeSessionId());
  assert.equal(shouldReviewArtifacts(state, { llmProvider: stubLlm }), false);
});

test("shouldReviewArtifacts skips without an llm provider", () => {
  const state = createLoopState(makeTask(), makeSessionId());
  pushArtifact(state, "some content");
  assert.equal(shouldReviewArtifacts(state, {}), false);
});

test("shouldReviewArtifacts skips outside task mode", () => {
  const state = createLoopState(makeTask({ mode: "investigate" }), makeSessionId());
  pushArtifact(state, "some content");
  assert.equal(shouldReviewArtifacts(state, { llmProvider: stubLlm }), false);
});

test("artifactReviewPayload fails closed when review output cannot be parsed", () => {
  const payload = artifactReviewPayload(undefined, 2);

  assert.equal(payload.passed, false);
  assert.equal(payload.artifactCount, 2);
  assert.equal(payload.skipped, undefined);
  assert.match(String(payload.reason), /could not be parsed/u);
  assert.ok(
    Array.isArray(payload.problems) &&
    payload.problems.some((problem) => String(problem).includes("not validated")),
  );
});

test("reviewArtifacts retries once when reviewer output is not parseable JSON", async () => {
  const state = createLoopState(makeTask(), makeSessionId());
  pushArtifact(state, "final answer");
  const calls: string[] = [];
  const llm: LLMProvider = {
    model: "test-model",
    async chat(messages) {
      calls.push(String(messages.at(-1)?.content ?? ""));
      if (calls.length === 1) {
        return { content: "The artifact looks fine, so passed true.", model: "test-model" };
      }
      return { content: "{\"passed\":true,\"problems\":[]}", model: "test-model" };
    },
  };

  const review = await reviewArtifacts(state, { llmProvider: llm });

  assert.deepEqual(review, { passed: true, problems: [] });
  assert.equal(calls.length, 2);
  assert.match(calls[1]!, /previous artifact review was not parseable/u);
});
