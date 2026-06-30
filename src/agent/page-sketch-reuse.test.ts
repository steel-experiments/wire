import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { BrowserProvider } from "../browser/bridge.js";
import type { LLMProvider } from "../providers/llm/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { SessionId, Task, TraceEvent } from "../shared/types.js";
import { createLoopState } from "./loop.js";
import { defaultAgentTurn } from "./turn.js";

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
    successCriteria: ["Page loads successfully"],
    createdAt: nowIsoUtc(),
    ...overrides,
  };
}

test("defaultAgentTurn includes PageSketch reuse guidance for repeated detail pages", async () => {
  const state = createLoopState(makeTask({
    objective: "go to https://commit-history.com/ and find stats for users, fukouda, danew, junhsss",
  }), makeSessionId());
  const observedAt = nowIsoUtc();
  const observation = (username: string): TraceEvent => ({
    id: createId("event"),
    runId: state.run.id,
    ts: observedAt,
    kind: "observation",
    payload: {
      url: `https://commit-history.com/${username}`,
      title: `${username}'s commit history`,
      pageSummary: { forms: 1, buttons: 2, dialogs: 0, headings: [`${username}'s commit history`] },
      pageSketch: {
        sections: [
          {
            id: "main",
            kind: "main",
            selectorHint: "main",
            heading: `${username}'s commit history`,
            textPreview: "#1,250\nPUBLIC RANK\n6,356\nPUBLIC COMMITS\n21\nFOLLOWERS",
            controls: [],
          },
        ],
      },
    },
  });
  state.events.push(observation("fukouda"), observation("danew"), observation("junhsss"));

  let prompt = "";
  const llm: LLMProvider = {
    model: "test-model",
    async chat(messages) {
      prompt = String(messages.find((m) => m.role === "user")?.content ?? "");
      return { content: '{"kind":"observe","summary":"Continue"}', model: "test-model" };
    },
  };

  await defaultAgentTurn(llm)(state, {} as BrowserProvider);

  assert.match(prompt, /Page sketch reuse:/u);
  assert.match(prompt, /commit-history\.com\/:id/u);
  assert.match(prompt, /seen on 3 pages/u);
  assert.match(prompt, /value\/label interpretation/u);
  assert.match(prompt, /one keyed progress entry per entity/u);
});
