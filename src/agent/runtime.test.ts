// ABOUTME: Tests for the agent runtime — executeTask, cancelSignal, pauseToken,
// ABOUTME: existingSession, and LLM usage aggregation.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { executeTask, skillGuidance, classifyUserIntent } from "./runtime.js";
import type { RuntimeConfig, UserMessageInbox } from "./runtime.js";
import type { BrowserProvider, BrowserObserveInput } from "../browser/bridge.js";
import type { ActionHandler } from "./actions.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { LLMProvider, ChatMessage, ChatResponse } from "../providers/llm/openai.js";
import { createId } from "../shared/ids.js";
import type { Task, BrowserSession, BrowserObservation, LoadedSkill, JsonObject } from "../shared/types.js";

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
    // Default tests off the host filesystem: the runtime now defaults skillDir
    // to ~/.wire/skills, which would make every test do real I/O against the
    // developer's skill library and races sensitive to load time (the pause
    // test, for example) become flaky. Tests that exercise skill loading
    // override this explicitly.
    skillDir: "",
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
// userMessageInbox
// ---------------------------------------------------------------------------

test("executeTask drains userMessageInbox into 'user-message' trace events", async () => {
  const queued = ["Use my work email", "skip the second result"];
  const inbox: UserMessageInbox = { pop: () => queued.shift() ?? null };
  const config = makeConfig({ userMessageInbox: inbox });

  const result = await executeTask(makeTask(), config);

  const userMsgEvents = result.events.filter((e) => e.kind === "user-message");
  assert.equal(userMsgEvents.length, 2);
  assert.equal(userMsgEvents[0]!.payload.message, "Use my work email");
  assert.equal(userMsgEvents[1]!.payload.message, "skip the second result");
});

test("user-message events appear in recentTraces summary with 'user said:' prefix", async () => {
  const queued = ["Use my work email"];
  const inbox: UserMessageInbox = { pop: () => queued.shift() ?? null };
  const promptsReceived: string[] = [];
  let callCount = 0;

  const mockLlm: LLMProvider = {
    model: "test-model",
    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
      callCount++;
      const userMsg = messages.find((m) => m.role === "user")!;
      const text = typeof userMsg.content === "string"
        ? userMsg.content
        : userMsg.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      promptsReceived.push(text);
      const action = callCount === 1
        ? { kind: "exec", summary: "Extract", payload: { code: "document.title" } }
        : { kind: "finish", summary: "Done — extracted the answer" };
      return { content: JSON.stringify(action), model: "test-model" };
    },
  };

  const config = makeConfig({ llmProvider: mockLlm, userMessageInbox: inbox, maxSteps: 5 });
  await executeTask(makeTask(), config);

  assert.ok(
    promptsReceived.some((p) => p.includes("user said: Use my work email")),
    "LLM-facing prompt should include 'user said: <text>' summary line",
  );
});

test("executeTask emits skill-empty warning when skillDir resolves to a directory with no .md files", async () => {
  // Regression: a supervisor that spawned wire from a tmpdir got `./skills`
  // silently auto-created empty, and zero skills loaded for an entire run
  // group despite a perfect-match skill living in the dev repo. Emit a
  // visible event so this never fails silently again.
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const emptyDir = await mkdtemp(join(tmpdir(), "wire-skills-empty-"));

  let callCount = 0;
  const mockLlm: LLMProvider = {
    model: "test-model",
    async chat(): Promise<ChatResponse> {
      callCount++;
      const action = callCount === 1
        ? { kind: "exec", summary: "Probe", payload: { code: "1" } }
        : { kind: "finish", summary: "Done — verified the empty path" };
      return { content: JSON.stringify(action), model: "test-model" };
    },
  };

  const config = makeConfig({ llmProvider: mockLlm, skillDir: emptyDir, maxSteps: 3 });
  const result = await executeTask(makeTask(), config);
  const hasWarning = result.events.some((e) => e.kind === "skill-empty");
  assert.ok(hasWarning, "expected a skill-empty event when skillDir is empty");
});

test("executeTask falls back to default skill dir when config.skillDir is undefined", async () => {
  // Programmatic callers (e.g. supervisor's WireRuntimeAdapter) build a
  // RuntimeConfig without setting skillDir. Previously this meant zero skill
  // loading even though `~/.wire/skills` existed and was populated. The runtime
  // now applies the default skill-dir resolver itself, so any caller gets
  // domain knowledge out of the box. WIRE_SKILLS overrides the home default
  // and is the cleanest hook for this test.
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const skillDir = await mkdtemp(join(tmpdir(), "wire-default-skills-"));
  await writeFile(join(skillDir, "example.md"), [
    "---",
    "id: skill_example-default",
    "scope: domain",
    "hostnamePatterns:",
    '  - "example.com"',
    "tags:",
    "  - example.com",
    "updatedAt: 2026-05-20",
    "source: generated",
    "---",
    "",
    "# Example",
    "",
    "## Facts",
    "",
    "- Example domain reserved for documentation.",
  ].join("\n"), "utf-8");

  const previousSkills = process.env["WIRE_SKILLS"];
  process.env["WIRE_SKILLS"] = skillDir;
  try {
    let callCount = 0;
    const mockLlm: LLMProvider = {
      model: "test-model",
      async chat(): Promise<ChatResponse> {
        callCount++;
        const action = callCount === 1
          ? { kind: "exec", summary: "Probe", payload: { code: "1" } }
          : { kind: "finish", summary: "Done" };
        return { content: JSON.stringify(action), model: "test-model" };
      },
    };

    // No skillDir in the config — the runtime should default to WIRE_SKILLS.
    // We override makeConfig's empty-string default by deleting the key so the
    // runtime sees genuinely undefined and applies its fallback.
    const config = makeConfig({ llmProvider: mockLlm, maxSteps: 3 });
    delete (config as { skillDir?: string }).skillDir;
    const result = await executeTask(makeTask(), config);

    const skillLoad = result.events.find((e) => e.kind === "skill-load");
    assert.ok(skillLoad, "expected a skill-load event from the default skills directory");
    const skills = skillLoad!.payload["skills"];
    assert.ok(
      Array.isArray(skills) && skills.includes("skill_example-default"),
      "expected the default skill dir's skill to load",
    );
  } finally {
    if (previousSkills === undefined) {
      delete process.env["WIRE_SKILLS"];
    } else {
      process.env["WIRE_SKILLS"] = previousSkills;
    }
  }
});

test("recentTraces summary truncates large exec stdout before reaching the LLM", async () => {
  // Regression: an exec that dumped a 12KB localStorage payload bloated the
  // next LLM input by ~10x without adding value. Cap stdout/stderr in the
  // recentTraces summary so the model gets a usable preview, not a flood.
  const huge = "A".repeat(20_000);
  let callCount = 0;
  const promptsReceived: string[] = [];

  const mockLlm: LLMProvider = {
    model: "test-model",
    async chat(messages: ChatMessage[]): Promise<ChatResponse> {
      callCount++;
      const userMsg = messages.find((m) => m.role === "user")!;
      const text = typeof userMsg.content === "string"
        ? userMsg.content
        : userMsg.content.map((p) => (p.type === "text" ? p.text : "")).join("");
      promptsReceived.push(text);
      const action = callCount === 1
        ? { kind: "exec", summary: "Dump", payload: { code: "return 'huge'" } }
        : { kind: "finish", summary: "Done — captured the dump" };
      return { content: JSON.stringify(action), model: "test-model" };
    },
  };

  // Override exec to return the huge payload as stdout.
  const provider: BrowserProvider = {
    createSession: async () => makeSession(),
    getSession: async () => makeSession(),
    stopSession: async () => {},
    observe: async () => makeObservation(),
    exec: async () => ({ ok: true, durationMs: 1, stdout: huge, returnValue: huge }),
  };

  const config = makeConfig({ provider, llmProvider: mockLlm, maxSteps: 3 });
  await executeTask(makeTask(), config);

  // The second prompt to the LLM contains the recentTraces summary that
  // includes the prior exec result.
  const secondPrompt = promptsReceived[1] ?? "";
  // Hard cap: a 20KB single value must not appear in full inside the prompt.
  assert.ok(
    secondPrompt.length < 10_000,
    `prompt should be capped well under 10KB; got ${secondPrompt.length}`,
  );
  // But there must be SOME signal of the result so the model knows it ran.
  assert.match(
    secondPrompt,
    /AAAA/,
    "prompt should still contain a preview of stdout",
  );
  // And there should be a marker so the model knows it was truncated.
  assert.match(
    secondPrompt,
    /truncat/i,
    "prompt should mark the value as truncated",
  );
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

test("executeTask auto-recovers once from anti-bot captcha observation", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const skillDir = await mkdtemp(join(tmpdir(), "wire-google-skill-"));
  await writeFile(join(skillDir, "google.md"), [
    "---",
    "id: skill_google",
    "scope: domain",
    "hostnamePatterns:",
    '  - "google.com"',
    "tags:",
    "  - google.com",
    "updatedAt: 2026-05-20",
    "source: generated",
    "---",
    "",
    "# Google",
    "",
    "## Known Traps",
    "",
    "- Navigating directly to Google Search may redirect to /sorry/index with a CAPTCHA/auth wall.",
  ].join("\n"), "utf-8");

  const existingSession = makeSession();
  const replacementSession = { ...makeSession(), id: createId("session") };
  let createSessionCalls = 0;
  let turnCalls = 0;
  let capturedPayload: Record<string, unknown> | undefined;

  const reconfigureHandler: ActionHandler = {
    kind: "reconfigure",
    description: "test reconfigure",
    async execute(state, action, provider) {
      capturedPayload = action.payload ?? {};
      const newSession = await provider.createSession({ sessionConfig: action.payload ?? {} });
      state.sessionId = newSession.id;
      state.sessionConfig = action.payload ?? {};
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: new Date().toISOString(),
        kind: "thought-summary",
        payload: { summary: action.summary, kind: "reconfigure" },
      });
      const observation = await provider.observe({ sessionId: state.sessionId });
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: new Date().toISOString(),
        kind: "observation",
        payload: {
          url: observation.url,
          title: observation.title,
          pageSummary: (observation.pageSummary as unknown as JsonObject) ?? {},
        },
      });
      return {};
    },
  };

  const provider: BrowserProvider = {
    ...makeConfig().provider,
    createSession: async () => {
      createSessionCalls++;
      return replacementSession;
    },
    observe: async () => {
      if (createSessionCalls === 0) {
        return {
          sessionId: existingSession.id,
          url: "https://www.google.com/sorry/index?continue=https://www.google.com/search%3Fq%3Dvercel%2Bpricing",
          title: "Unusual traffic",
          tabs: [],
          pageSummary: { forms: 1, buttons: 1, dialogs: 0, tables: 0, links: 2, inputs: 1, headings: ["Verify you are human"] },
        };
      }
      return {
        sessionId: replacementSession.id,
        url: "about:blank",
        title: "",
        tabs: [],
        pageSummary: { forms: 0, buttons: 0, dialogs: 0, tables: 0, links: 0, inputs: 0, headings: [] },
      };
    },
    exec: async () => ({ ok: true, durationMs: 1, returnValue: "Vercel pricing page reachable directly at /pricing" }),
  };

  const result = await executeTask(
    makeTask(),
    makeConfig({
      existingSession,
      actionHandlers: [reconfigureHandler],
      provider,
      skillDir,
      maxSteps: 4,
    }),
    async () => {
      turnCalls++;
      return turnCalls === 1
        ? { kind: "exec", summary: "Extract answer after recovery", payload: { code: "return document.body.innerText" } }
        : { kind: "finish", summary: "Done" };
    },
  );

  assert.equal(createSessionCalls, 1, "should create one replacement session");
  assert.deepEqual(capturedPayload, { useProxy: true, solveCaptcha: true });
  assert.equal(result.sessionId, replacementSession.id);
  assert.notEqual(result.classification.kind, "blocked-auth");
  assert.ok(
    result.events.some((e) => e.kind === "thought-summary" && e.payload.kind === "reconfigure"),
    "should record the recovery reconfigure",
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

test("executeTask records opt-in LLM call blob refs without inline messages", async () => {
  const saved: Array<{ kind: string; value: unknown; contentType?: string }> = [];
  const mockLlm: LLMProvider = {
    model: "test-model",
    async chat(): Promise<ChatResponse> {
      return {
        content: JSON.stringify({ kind: "finish", summary: "Done" }),
        model: "test-model",
      };
    },
  };

  const config = makeConfig({
    llmProvider: mockLlm,
    maxSteps: 1,
    traceLlmMessages: true,
    async saveTraceBlob(_runId, kind, value, contentType) {
      saved.push(contentType === undefined ? { kind, value } : { kind, value, contentType });
      return { hash: `hash-${saved.length}`, size: JSON.stringify(value).length, kind };
    },
  });

  const result = await executeTask(makeTask(), config);
  const call = result.events.find((event) => event.kind === "llm-call");

  assert.ok(call);
  assert.ok(saved.filter((item) => item.kind === "llm-message").length >= 2);
  assert.ok(saved.filter((item) => item.kind === "llm-response").length >= 1);
  assert.deepEqual(
    Object.keys(call.payload).sort(),
    ["callIndex", "messageRefs", "model", "responseRef"].sort(),
  );
  assert.match(JSON.stringify(call.payload), /hash-1/u);
  assert.doesNotMatch(JSON.stringify(call.payload), /Completion contract|Return exactly one next action/u);
});

// ---------------------------------------------------------------------------
// skillGuidance — section-priority truncation
// ---------------------------------------------------------------------------

function makeSkill(overrides: Partial<LoadedSkill> & { sections: Record<string, string> }): LoadedSkill {
  const { sections, ...rest } = overrides;
  return {
    id: "skill_test",
    scope: "domain",
    tags: ["test"],
    updatedAt: new Date().toISOString(),
    source: "generated",
    path: "/fake/skill.md",
    body: "",
    sections,
    ...rest,
  };
}

test("skillGuidance includes Known Traps content", () => {
  const skill = makeSkill({
    sections: {
      "Facts": "The site is at example.com.",
      "Known Traps": "window.dispatchEvent does NOT work. Use CDP Input.dispatchKeyEvent instead.",
    },
  });
  const guidance = skillGuidance(skill);
  assert.match(guidance, /Known Traps/u);
  assert.match(guidance, /window\.dispatchEvent does NOT work/u);
});

test("skillGuidance places Known Traps before Facts", () => {
  const skill = makeSkill({
    sections: {
      "Facts": "The site is at example.com.",
      "Known Traps": "Do not use synthetic events.",
    },
  });
  const guidance = skillGuidance(skill);
  const trapsIdx = guidance.indexOf("Do not use synthetic events");
  const factsIdx = guidance.indexOf("The site is at example.com");
  assert.ok(trapsIdx < factsIdx, "Known Traps should appear before Facts in guidance");
});

test("skillGuidance includes Workflow content", () => {
  const skill = makeSkill({
    sections: {
      "Workflow": "1. Navigate to /classic. 2. Dismiss tutorial. 3. Use wireActions.",
      "Facts": "The game is available at /classic.",
    },
  });
  const guidance = skillGuidance(skill);
  assert.match(guidance, /Workflow/u);
  assert.match(guidance, /Navigate to \/classic/u);
});

test("skillGuidance includes Traps section when skill uses Traps instead of Known Traps", () => {
  const skill = makeSkill({
    sections: {
      "Traps": "Avoid clicking the ads.",
    },
  });
  const guidance = skillGuidance(skill);
  assert.match(guidance, /Traps/u);
  assert.match(guidance, /Avoid clicking the ads/u);
});

test("skillGuidance truncates at 1000 chars but preserves first matched section", () => {
  const skill = makeSkill({
    sections: {
      "Known Traps": "A".repeat(500),
      "Workflow": "B".repeat(500),
      "Facts": "C".repeat(500),
    },
  });
  const guidance = skillGuidance(skill);
  assert.ok(guidance.length <= 1000, `guidance should be capped at 1000 chars, got ${guidance.length}`);
  assert.match(guidance, /Known Traps/u, "should still include Known Traps section header");
  assert.match(guidance, /A{10,}/u, "should include traps content even with long sections");
});

test("skillGuidance falls back to body when no sections match", () => {
  const skill = makeSkill({
    body: "Fallback guidance content from the body.",
    sections: {},
  });
  const guidance = skillGuidance(skill);
  assert.equal(guidance, "Fallback guidance content from the body.");
});

// ---------------------------------------------------------------------------
// classifyUserIntent — heuristic intent classification
// ---------------------------------------------------------------------------

test("classifyUserIntent returns assist for tactical messages", () => {
  assert.equal(classifyUserIntent("Use my work email", "Download invoices"), "assist");
  assert.equal(classifyUserIntent("skip the second result", "Download invoices"), "assist");
  assert.equal(classifyUserIntent("try a different selector", "Download invoices"), "assist");
  assert.equal(classifyUserIntent("scroll down", "Download invoices"), "assist");
});

test("classifyUserIntent returns redirect for task-switching messages", () => {
  assert.equal(classifyUserIntent("go to google", "play 2048 game"), "redirect");
  assert.equal(classifyUserIntent("actually, find me flights to Tokyo", "Download invoices"), "redirect");
  assert.equal(classifyUserIntent("no, search for Amazon instead", "Find Stripe pricing"), "redirect");
  assert.equal(classifyUserIntent("switch to the billing page", "Download invoices"), "redirect");
  assert.equal(classifyUserIntent("now do a search for weather", "Download invoices"), "redirect");
  assert.equal(classifyUserIntent("I want you to find the CEO's email", "Download invoices"), "redirect");
});

test("classifyUserIntent returns cancel for stop signals", () => {
  assert.equal(classifyUserIntent("stop", "Download invoices"), "cancel");
  assert.equal(classifyUserIntent("cancel", "Download invoices"), "cancel");
  assert.equal(classifyUserIntent("abort", "Download invoices"), "cancel");
  assert.equal(classifyUserIntent("quit", "Download invoices"), "cancel");
  assert.equal(classifyUserIntent("never mind", "Download invoices"), "cancel");
});
