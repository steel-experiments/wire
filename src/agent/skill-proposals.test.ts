// ABOUTME: Tests for skill proposal minting at run finalization — what evidence
// ABOUTME: produces a proposal and which run classifications are allowed to mint one.
import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  SessionId,
  Task,
} from "../shared/types.js";

import type { BrowserObserveInput, BrowserProvider } from "../browser/bridge.js";
import type { PolicyEngine } from "../policy/engine.js";

import { executeTask } from "./runtime.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Test task",
    mode: "task",
    objective: "Complete a test task",
    constraints: [],
    successCriteria: ["Page loads successfully"],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeSessionId(): SessionId {
  return createId("session");
}

function createMockProvider(overrides: Partial<BrowserProvider> = {}): BrowserProvider {
  return {
    async createSession() {
      throw new Error("not implemented");
    },
    async getSession() {
      throw new Error("not implemented");
    },
    async stopSession() {
      throw new Error("not implemented");
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      return {
        sessionId: input.sessionId,
        url: "https://example.com",
        title: "Example",
        tabs: [
          { id: "tab-1", title: "Example", url: "https://example.com", active: true },
        ],
      };
    },
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      return {
        ok: true,
        stdout: "ok",
        durationMs: 10,
      };
    },
    ...overrides,
  };
}

function createMockPolicyEngine(overrides: Partial<PolicyEngine> = {}): PolicyEngine {
  return {
    check(_actionId, _action) {
      return {
        id: createId("policy"),
        actionId: _actionId,
        result: "allow",
      };
    },
    ...overrides,
  };
}

// Always willing to propose a skill — so the only thing that can suppress the
// proposal is the run-classification gate.
function createEagerSkillProposer(hostname: string) {
  return {
    model: "test-model",
    async chat(messages: { role?: string; content: string | unknown }[]) {
      const isDistill = messages.some(
        (m) => typeof m.content === "string" && m.content.includes("skill-distillation agent"),
      );
      if (isDistill) {
        return {
          content: JSON.stringify({
            hostname,
            facts: ["something"],
            selectors: [],
            routes: [],
            waits: [],
            traps: [],
            confidence: 0.9,
          }),
          model: "test-model",
        };
      }
      return { content: "NONE", model: "test-model" };
    },
  };
}

test("executeTask proposes domain skill updates from reusable trace evidence", async () => {
  const task = makeTask({ objective: "Inspect example pricing" });
  const skillDir = await mkdtemp(join(tmpdir(), "wire-agent-skills-"));
  const sessionId = makeSessionId();
  let observeCount = 0;
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: new Date().toISOString(),
        status: "ready",
      };
    },
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      observeCount++;
      return {
        sessionId: input.sessionId,
        url: observeCount === 1 ? "https://example.com" : "https://example.com/pricing",
        title: observeCount === 1 ? "Example" : "Pricing",
        tabs: [
          { id: "tab-1", title: "Example", url: "https://example.com", active: true },
        ],
      };
    },
    async exec(): Promise<BrowserExecResult> {
      return {
        ok: true,
        stdout: "ok",
        durationMs: 10,
      };
    },
    async stopSession() {},
  });
  const policy = createMockPolicyEngine();

  const mockLlmProvider = {
    model: "test-model",
    async chat(messages: { content: string | import("../providers/llm/openai.js").ContentPart[] }[]) {
      const userMsg = messages.find((m) => typeof m.content === "string" && m.content.includes("[observation]"));
      if (userMsg) {
        return {
          content: JSON.stringify({
            hostname: "example.com",
            facts: ["Pricing page at /pricing"],
            selectors: [],
            routes: ["/pricing"],
            waits: [],
            traps: [],
            confidence: 0.8,
          }),
          model: "test-model",
        };
      }
      return { content: "NONE", model: "test-model" };
    },
  };

  try {
    const result = await executeTask(
      task,
      { provider, policyEngine: policy, maxSteps: 3, skillDir, llmProvider: mockLlmProvider },
      async (state) => {
        if (state.stepCount === 0) {
          return {
            kind: "exec",
            summary: "Use direct route",
            payload: { code: "window.location.href = 'https://example.com/pricing';" },
          };
        }
        if (state.stepCount === 1) {
          return { kind: "observe", summary: "Verify pricing route" };
        }
        return { kind: "finish", summary: "Done" };
      },
    );

    const proposal = result.events.find((event) => event.kind === "skill-proposal");
    assert.ok(proposal);
    assert.equal(proposal.payload.hostname, "example.com");
    assert.match(String(proposal.payload.proposal ?? ""), /hostnamePatterns/u);
    assert.equal(typeof proposal.payload.path, "string");
    const skillFile = await readFile(String(proposal.payload.path), "utf-8");
    assert.match(skillFile, /example\.com/u);
  } finally {
    await rm(skillDir, { recursive: true, force: true });
  }
});

test("executeTask does not propose a skill from a failed run", async () => {
  // A skill captures durable, working browser knowledge. A run that only
  // failed must not mint one, even if the distiller would happily produce a
  // proposal from the trace.
  const task = makeTask({ objective: "Try something that never works" });
  const skillDir = await mkdtemp(join(tmpdir(), "wire-agent-skills-"));
  const sessionId = makeSessionId();
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      return { ok: false, durationMs: 5, stderr: "nope" };
    },
    async stopSession() {},
  });

  const eagerSkillProposer = createEagerSkillProposer("example.com");

  try {
    const result = await executeTask(
      task,
      { provider, policyEngine: createMockPolicyEngine(), maxSteps: 8, skillDir, llmProvider: eagerSkillProposer },
      async () => ({ kind: "exec", summary: "Probe that fails", payload: { code: "return doomedThing()" } }),
    );

    assert.ok(
      ["site-error", "agent-error"].includes(result.run.classification?.kind ?? ""),
      `expected a failure classification, got ${result.run.classification?.kind}`,
    );
    const proposal = result.events.find((event) => event.kind === "skill-proposal");
    assert.equal(proposal, undefined, "a failed run must not propose a skill");
  } finally {
    await rm(skillDir, { recursive: true, force: true });
  }
});

test("executeTask does not propose a skill from a partial-success run", async () => {
  // Live regression (run_631123ec, 2026-06-10): a question task whose result
  // was a query-echo SERP dump classified partial-success and still minted a
  // duckduckgo.com skill teaching circular SERP "verification". Skills come
  // only from runs classified task-complete.
  const task = makeTask({ objective: "Look up the gizmo entry in the parts catalog" });
  const skillDir = await mkdtemp(join(tmpdir(), "wire-agent-skills-"));
  const sessionId = makeSessionId();
  const provider = createMockProvider({
    async createSession() {
      return { id: sessionId, provider: "custom", createdAt: new Date().toISOString(), status: "ready" };
    },
    async exec(): Promise<BrowserExecResult> {
      // A query echo: percent-encoded quotes reflected back from a results page
      // instead of extracted content — classifies as a generic extraction failure.
      return {
        ok: true,
        durationMs: 5,
        returnValue: {
          match: true,
          results: [{ title: "gizmo %22parts catalog%22 Crossword Clue", href: "https://www.wordplays.com/" }],
        },
      };
    },
    async stopSession() {},
  });

  const eagerSkillProposer = createEagerSkillProposer("wordplays.com");

  try {
    const result = await executeTask(
      task,
      { provider, policyEngine: createMockPolicyEngine(), maxSteps: 8, skillDir, llmProvider: eagerSkillProposer },
      async (state) => {
        if (state.stepCount === 0) {
          return { kind: "exec", summary: "Read results", payload: { code: "return scrapeResults()" } };
        }
        return { kind: "finish", summary: "Done" };
      },
    );

    assert.equal(
      result.run.classification?.kind,
      "partial-success",
      `expected partial-success, got ${result.run.classification?.kind}`,
    );
    const proposal = result.events.find((event) => event.kind === "skill-proposal");
    assert.equal(proposal, undefined, "a partial-success run must not propose a skill");
  } finally {
    await rm(skillDir, { recursive: true, force: true });
  }
});
