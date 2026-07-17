// ABOUTME: Regression coverage for grounded navigation recovery after a
// ABOUTME: not-found landing, including prompt and reconfigure behavior.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { ProposedAction } from "../shared/types.js";
import { ActionRegistry } from "./actions.js";
import { createMockPolicyEngine, createMockProvider, makeSessionId, makeTask } from "./fixtures.test.js";
import { createLoopState, executeStep } from "./loop.js";
import { executeTask } from "./runtime.js";
import { computeNoProgressStreak } from "./state-helpers.js";
import { defaultAgentTurn } from "./turn.js";

const emptySummary: {
  headings: string[];
  forms: number;
  buttons: number;
  dialogs: number;
  tables: number;
  links: number;
  inputs: number;
} = {
  headings: [],
  forms: 0,
  buttons: 0,
  dialogs: 0,
  tables: 0,
  links: 0,
  inputs: 0,
};

test("agent turn surfaces not-found recovery and observed link targets", async () => {
  const state = createLoopState(makeTask(), makeSessionId());
  let prompt = "";
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "observation",
    payload: {
      url: "https://docs.example.com/integrations/guessed-slug",
      title: "Page not found | Example Docs",
      pageSummary: {
        ...emptySummary,
        linkSamples: [
          { label: "Integrations", href: "https://docs.example.com/integrations" },
          { label: "Private", href: "https://docs.example.com/private?apiKey=[REDACTED]" },
          { label: "Secret", href: "https://docs.example.com/private?apiKey=top-secret-value" },
          { label: "FTP", href: "ftp://docs.example.com/archive" },
        ],
      },
    },
  });
  const turn = defaultAgentTurn({
    model: "test-model",
    async chat(messages) {
      const content = messages.find((message) => message.role === "user")?.content;
      prompt = typeof content === "string"
        ? content
        : content?.find((part) => part.type === "text")?.text ?? "";
      return {
        content: '{"kind":"exec","summary":"Go back","payload":{"code":"history.back(); return {navigated:true};"}}',
        model: "test-model",
      };
    },
  });

  await turn(state, createMockProvider());

  assert.match(prompt, /current observation is a not-found landing/u);
  assert.match(prompt, /Do not guess or synthesize another URL/u);
  assert.match(prompt, /Integrations: https:\/\/docs\.example\.com\/integrations/u);
  assert.doesNotMatch(prompt, /Private|Secret|FTP|\[REDACTED\]|top-secret-value/u);
});

test("history recovery receives an automatic observation", async () => {
  const state = createLoopState(makeTask(), makeSessionId());
  let observeCount = 0;
  const provider = createMockProvider({
    async exec() {
      return { ok: true, durationMs: 1, returnValue: { navigated: true } };
    },
    async observe(input) {
      observeCount++;
      return {
        sessionId: input.sessionId,
        url: "https://docs.example.com/integrations",
        title: "Integrations",
        tabs: [],
      };
    },
  });

  const result = await executeStep(
    state,
    { kind: "exec", summary: "Return to the last working page", payload: { code: "history.back(); return {navigated:true};" } },
    provider,
    createMockPolicyEngine(),
  );

  assert.equal(observeCount, 1);
  assert.equal(result.state.events.at(-1)?.kind, "observation");
  assert.equal(result.state.events.at(-1)?.payload.url, "https://docs.example.com/integrations");
});

test("leaving a not-found landing clears the soft no-progress streak", () => {
  const state = createLoopState(makeTask(), makeSessionId());
  const addObservation = (url: string, title: string, pageSummary = emptySummary) => {
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "observation",
      payload: { url, title, pageSummary },
    });
  };
  const addNavigationResult = () => {
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "code-result",
      payload: { ok: true, durationMs: 1, returnValue: { navigated: true } },
    });
  };

  addObservation("https://docs.example.com/integrations", "Integrations", {
    ...emptySummary,
    headings: ["Integrations"],
    links: 10,
  });
  addNavigationResult();
  addObservation("https://docs.example.com/missing-one", "Page Not Found | Example", emptySummary);
  addNavigationResult();
  addObservation("https://docs.example.com/missing-two", "404 Not Found | Example", emptySummary);
  addNavigationResult();
  addObservation("https://docs.example.com/missing-one", "Page Not Found | Example", emptySummary);
  addNavigationResult();
  addObservation("https://docs.example.com/integrations", "Integrations", {
    ...emptySummary,
    headings: ["Integrations"],
    links: 10,
  });

  assert.equal(computeNoProgressStreak(state.events), 0);

  addNavigationResult();
  addObservation("https://docs.example.com/integrations/stripe", "Stripe", {
    ...emptySummary,
    headings: ["Stripe"],
    links: 5,
  });
  assert.equal(computeNoProgressStreak(state.events), 1, "new navigation after recovery starts a fresh streak");
});

test("multi-step not-found recovery does not trip the hard no-progress guard", async () => {
  const sessionId = makeSessionId();
  const workingPage = {
    url: "https://docs.example.com/integrations",
    title: "Integrations",
    pageSummary: { ...emptySummary, headings: ["Integrations"], links: 10 },
  };
  const missingOne = {
    url: "https://docs.example.com/integrations/guessed-one",
    title: "Page Not Found | Example Docs",
    pageSummary: emptySummary,
  };
  const missingTwo = {
    url: "https://docs.example.com/integrations/guessed-two",
    title: "404 Not Found | Example Docs",
    pageSummary: emptySummary,
  };
  const targetPage = {
    url: "https://docs.example.com/integrations/stripe",
    title: "Stripe",
    pageSummary: { ...emptySummary, headings: ["Stripe"], links: 5 },
  };
  const history = [workingPage];
  let historyIndex = 0;
  let execCount = 0;
  let extracted = false;

  const navigate = (page: typeof workingPage) => {
    history.splice(historyIndex + 1);
    history.push(page);
    historyIndex = history.length - 1;
  };
  const provider = createMockProvider({
    async createSession() {
      return {
        id: sessionId,
        provider: "custom",
        createdAt: nowIsoUtc(),
        status: "ready",
      };
    },
    async stopSession() {},
    async exec(input) {
      execCount++;
      if (input.code.includes("guessed-one")) navigate(missingOne);
      else if (input.code.includes("guessed-two")) navigate(missingTwo);
      else if (input.code.includes("history.back")) historyIndex = Math.max(0, historyIndex - 1);
      else if (input.code.includes("/integrations/stripe")) navigate(targetPage);
      else if (input.code.includes("extract-answer")) {
        extracted = true;
        return { ok: true, durationMs: 1, returnValue: { answer: "Stripe integration docs" } };
      }
      return { ok: true, durationMs: 1, returnValue: { navigated: true } };
    },
    async observe(input) {
      const page = history[historyIndex]!;
      return {
        sessionId: input.sessionId,
        url: page.url,
        title: page.title,
        tabs: [],
        pageSummary: page.pageSummary,
      };
    },
  });
  const actions: ProposedAction[] = [
    { kind: "exec", summary: "Guess one", payload: { code: "window.location.href='/integrations/guessed-one'; return {navigated:true};" } },
    { kind: "exec", summary: "Guess two", payload: { code: "window.location.href='/integrations/guessed-two'; return {navigated:true};" } },
    { kind: "exec", summary: "Back to first missing page", payload: { code: "history.back(); return {navigated:true};" } },
    { kind: "exec", summary: "Back to working page", payload: { code: "history.back(); return {navigated:true};" } },
    { kind: "exec", summary: "Follow observed Stripe link", payload: { code: "window.location.href='/integrations/stripe'; return {navigated:true};" } },
    { kind: "exec", summary: "Extract answer", payload: { code: "return {answer: 'extract-answer'};" } },
  ];
  let turnIndex = 0;

  const result = await executeTask(
    makeTask({ objective: "Find the Stripe integration docs" }),
    { provider, policyEngine: createMockPolicyEngine(), maxSteps: actions.length },
    async () => actions[turnIndex++]!,
  );

  assert.equal(execCount, actions.length);
  assert.equal(extracted, true, "the extraction after recovery must run");
  assert.ok(!result.events.some(
    (event) => event.kind === "thought-summary" && /consecutive no-progress results/u.test(String(event.payload.reason ?? "")),
  ));
});

test("executeStep refuses reconfigure on a sparse not-found landing", async () => {
  const state = createLoopState(makeTask(), makeSessionId());
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "observation",
    payload: {
      url: "https://docs.steel.dev/integrations/guessed-slug",
      title: "Page not found | Steel Docs",
      pageSummary: emptySummary,
    },
  });

  let handlerCalled = false;
  const registry = new ActionRegistry();
  registry.register({
    kind: "reconfigure",
    description: "test reconfigure",
    async execute() {
      handlerCalled = true;
      return {};
    },
  });

  const result = await executeStep(
    state,
    { kind: "reconfigure", summary: "Try a proxy", payload: { useProxy: true, solveCaptcha: true } },
    createMockProvider(),
    createMockPolicyEngine(),
    { actionRegistry: registry },
  );

  assert.equal(handlerCalled, false, "not-found pages must not trigger a session swap");
  assert.equal(result.policyDenied, false, "refusal should let the agent recover by navigation");
  assert.ok(result.state.events.some(
    (event) => event.kind === "thought-summary" && event.payload.kind === "reconfigure-refused",
  ));
});
