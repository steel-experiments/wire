// ABOUTME: Tests for the agent runtime — executeTask, cancelSignal, pauseToken,
// ABOUTME: existingSession, and LLM usage aggregation.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { executeTask } from "./runtime.js";
import type { RuntimeConfig } from "./runtime.js";
import type { BrowserProvider, BrowserObserveInput } from "../browser/bridge.js";
import type { ActionHandler } from "./actions.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { LLMProvider, ChatResponse } from "../providers/llm/openai.js";
import { createId } from "../shared/ids.js";
import type { Task, BrowserSession, BrowserObservation } from "../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(): Task {
  return {
    id: createId("task"),
    title: "test task",
    mode: "task",
    objective: "test objective",
    constraints: [],
    successCriteria: ["done"],
    createdAt: new Date().toISOString(),
  };
}

function makeSession(): BrowserSession {
  return {
    id: createId("session"),
    provider: "steel",
    status: "ready",
    liveUrl: "https://example.com",
    createdAt: new Date().toISOString(),
  };
}

function makeObservation(): BrowserObservation {
  return {
    sessionId: makeSession().id,
    url: "https://example.com",
    title: "Test Page",
    tabs: [],
  };
}

/** Creates a minimal runtime config with mocked provider and policy. */
function makeConfig(overrides: Partial<RuntimeConfig> = {}): RuntimeConfig {
  let sessionCreated = false;

  const mockProvider: BrowserProvider = {
    createSession: async () => {
      if (sessionCreated) throw new Error("createSession called twice");
      sessionCreated = true;
      return makeSession();
    },
    getSession: async () => makeSession(),
    stopSession: async () => {},
    observe: async (_input: BrowserObserveInput) => makeObservation(),
    exec: async () => ({ ok: true, durationMs: 0 }),
  };

  const mockPolicy: PolicyEngine = {
    check: (_actionId, _action) => ({ id: createId("policy"), actionId: createId("action"), result: "allow" as const, rules: [] }),
  };

  return {
    provider: mockProvider,
    policyEngine: mockPolicy,
    maxSteps: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Change 2: cancelSignal
// ---------------------------------------------------------------------------

test("executeTask exits immediately when cancelSignal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();

  let createSessionCalls = 0;
  let observeCalls = 0;
  const base = makeConfig();
  const config = makeConfig({
    cancelSignal: controller.signal,
    provider: {
      ...base.provider,
      createSession: async () => {
        createSessionCalls++;
        return makeSession();
      },
      observe: async (_input: BrowserObserveInput) => {
        observeCalls++;
        return makeObservation();
      },
    },
  });

  const result = await executeTask(makeTask(), config);

  const cancelEvent = result.events.find(
    (e) => e.kind === "thought-summary" && e.payload.reason === "User cancelled",
  );
  assert.ok(cancelEvent, "should have a 'User cancelled' thought-summary event");
  assert.equal(createSessionCalls, 0, "should not create a browser session after early cancellation");
  assert.equal(observeCalls, 0, "should not run the initial observation after early cancellation");
});

test("executeTask without cancelSignal behaves normally (fallback to no-op)", async () => {
  const config = makeConfig();

  const result = await executeTask(makeTask(), config);

  // Without an LLM provider, the agent falls back to observe-then-finish.
  assert.ok(result.events.length > 0, "should have trace events");
  const cancelled = result.events.find(
    (e) => e.kind === "thought-summary" && e.payload.reason === "User cancelled",
  );
  assert.ok(!cancelled, "should NOT have a 'User cancelled' event");
});

// ---------------------------------------------------------------------------
// Change 3: pauseToken
// ---------------------------------------------------------------------------

test("executeTask pauses when pauseToken is set, resumes when unpaused", async () => {
  let paused = true;
  let resumeResolve!: () => void;
  const resumePromise = new Promise<void>((resolve) => { resumeResolve = resolve; });

  const config = makeConfig({
    pauseToken: {
      isPaused() { return paused; },
      async waitWhilePaused() { await resumePromise; },
    },
  });

  // Resume after a short delay so the pause actually blocks the loop
  setTimeout(() => {
    paused = false;
    resumeResolve();
  }, 50);

  const result = await executeTask(makeTask(), config);

  const pauseEvent = result.events.find(
    (e) => e.kind === "thought-summary" && e.payload.reason === "Paused for user takeover",
  );
  const resumeEvent = result.events.find(
    (e) => e.kind === "thought-summary" && e.payload.reason === "Resumed after user takeover",
  );
  assert.ok(pauseEvent, "should have a 'Paused' event");
  assert.ok(resumeEvent, "should have a 'Resumed' event");
});

test("executeTask does not emit a resume event when cancellation ends a pause", async () => {
  const controller = new AbortController();
  let paused = true;
  let releasePause!: () => void;
  const waitWhilePaused = new Promise<void>((resolve) => { releasePause = resolve; });

  const config = makeConfig({
    cancelSignal: controller.signal,
    pauseToken: {
      isPaused() { return paused; },
      async waitWhilePaused() { await waitWhilePaused; },
    },
  });

  setTimeout(() => controller.abort(), 20);
  setTimeout(() => {
    paused = false;
    releasePause();
  }, 50);

  const result = await executeTask(makeTask(), config);
  const reasons = result.events
    .filter((e) => e.kind === "thought-summary")
    .map((e) => e.payload.reason)
    .filter((reason): reason is string => typeof reason === "string");

  assert.ok(reasons.includes("Paused for user takeover"), "should emit a pause event");
  assert.ok(reasons.includes("User cancelled"), "should emit a cancel event");
  assert.ok(!reasons.includes("Resumed after user takeover"), "should not emit a resume event after cancellation");
});

// ---------------------------------------------------------------------------
// Change 4: existingSession
// ---------------------------------------------------------------------------

test("executeTask with existingSession skips createBrowserSession", async () => {
  let createSessionCalled = false;
  let sessionCreatedCallbackFired = false;

  const session = makeSession();
  const config = makeConfig({
    existingSession: session,
    onSessionCreated: async () => { sessionCreatedCallbackFired = true; },
    provider: {
      ...makeConfig().provider,
      createSession: async () => {
        createSessionCalled = true;
        return makeSession();
      },
    },
  });

  const result = await executeTask(makeTask(), config);

  assert.ok(result.events.length > 0, "should have trace events");
  assert.ok(!createSessionCalled, "should NOT call createBrowserSession");
  assert.ok(!sessionCreatedCallbackFired, "should NOT call onSessionCreated");
  assert.equal(result.sessionId, session.id, "should use the provided session");
});

test("executeTask closes a replacement session created after reconfiguring an existing session", async () => {
  const existingSession = makeSession();
  const replacementSession: BrowserSession = {
    ...makeSession(),
    id: createId("session"),
    liveUrl: "https://replacement.example.com",
  };
  let createdSessions = 0;
  const stoppedSessionIds: string[] = [];

  const reconfigureHandler: ActionHandler = {
    kind: "reconfigure",
    description: "test reconfigure",
    async execute(state, action, provider) {
      const oldSessionId = state.sessionId;
      const newSession = await provider.createSession({ sessionConfig: action.payload ?? {} });
      await provider.stopSession(oldSessionId);
      state.sessionId = newSession.id;
      if (newSession.liveUrl) state.sessionLiveUrl = newSession.liveUrl;
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: new Date().toISOString(),
        kind: "thought-summary",
        payload: { summary: action.summary, kind: "reconfigure" },
      });
      return {};
    },
  };

  const config = makeConfig({
    existingSession,
    actionHandlers: [reconfigureHandler],
    provider: {
      ...makeConfig().provider,
      createSession: async () => {
        createdSessions++;
        return replacementSession;
      },
      stopSession: async (sessionId) => {
        stoppedSessionIds.push(sessionId);
      },
    },
  });

  let callCount = 0;
  const result = await executeTask(
    makeTask(),
    config,
    async () => {
      callCount++;
      return callCount === 1
        ? { kind: "reconfigure", summary: "Swap session", payload: { stealth: true } }
        : { kind: "finish", summary: "Done" };
    },
  );

  assert.equal(createdSessions, 1, "should create one replacement session");
  assert.equal(result.sessionId, replacementSession.id, "should finish on the replacement session");
  assert.deepEqual(
    stoppedSessionIds,
    [existingSession.id, replacementSession.id],
    "should stop both the old injected session during reconfigure and the replacement session during final cleanup",
  );
});

// ---------------------------------------------------------------------------
// Change 5: LLM token usage
// ---------------------------------------------------------------------------

test("executeTask surfaces LLM usage in LoopResult when provider returns it", async () => {
  let callCount = 0;
  const mockLlm: LLMProvider = {
    model: "test-model",
    async chat(): Promise<ChatResponse> {
      callCount++;
      // Return a valid exec action that produces an artifact, then finish
      const action = callCount === 1
        ? JSON.stringify({ kind: "exec", summary: "Extract answer", payload: { code: `document.title` } })
        : JSON.stringify({ kind: "finish", summary: "Done — extracted the answer" });
      return {
        content: action,
        model: "test-model",
        usage: { inputTokens: 100 * callCount, outputTokens: 50 * callCount },
      };
    },
  };

  const config = makeConfig({ llmProvider: mockLlm, maxSteps: 10 });

  const result = await executeTask(makeTask(), config);

  // Should have llm-usage events
  const usageEvents = result.events.filter((e) => e.kind === "llm-usage");
  assert.ok(usageEvents.length > 0, "should have llm-usage trace events");

  // LoopResult should have aggregated usage
  const usage = result.usage!;
  assert.ok(usage, "LoopResult should have usage");
  assert.ok(usage.totalTokens! > 0, "totalTokens should be > 0");
  assert.ok(usage.promptTokens! > 0, "promptTokens should be > 0");
  assert.ok(usage.completionTokens! > 0, "completionTokens should be > 0");

  // Verify aggregation: sum of all calls
  const expectedTotal = usageEvents.reduce((sum, e) => {
    const u = e.payload.usage as { inputTokens?: number; outputTokens?: number } | undefined;
    return sum + (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0);
  }, 0);
  assert.equal(result.usage!.totalTokens, expectedTotal, "aggregated totalTokens should match sum of events");
});
