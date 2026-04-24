import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  assembleSystemPrompt,
  assembleUserPrompt,
} from "./context.js";
import type {
  ContextBundle,
  TaskObjective,
  SkillSummary,
  ObservationSummary,
  TraceSummary,
  BudgetSummary,
} from "./context.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<TaskObjective> = {}): TaskObjective {
  return {
    mode: "task",
    objective: "Download invoices from dashboard.",
    constraints: ["Do not modify any data."],
    successCriteria: ["All invoices downloaded."],
    ...overrides,
  };
}

function makeContext(overrides: Partial<ContextBundle> = {}): ContextBundle {
  return {
    task: makeTask(),
    skills: [],
    observations: [],
    recentTraces: [],
    policyNotes: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// assembleSystemPrompt
// ---------------------------------------------------------------------------

test("assembleSystemPrompt includes mode and objective", () => {
  const context = makeContext();
  const prompt = assembleSystemPrompt(context);

  assert.ok(prompt.includes("task mode"));
  assert.ok(prompt.includes("Download invoices from dashboard."));
});

test("assembleSystemPrompt includes constraints", () => {
  const context = makeContext();
  const prompt = assembleSystemPrompt(context);

  assert.ok(prompt.includes("Constraints:"));
  assert.ok(prompt.includes("Do not modify any data."));
});

test("assembleSystemPrompt includes success criteria", () => {
  const context = makeContext();
  const prompt = assembleSystemPrompt(context);

  assert.ok(prompt.includes("Success criteria:"));
  assert.ok(prompt.includes("All invoices downloaded."));
});

test("assembleSystemPrompt includes policy notes", () => {
  const context = makeContext({
    policyNotes: ["No outbound messages allowed.", "Stop at auth walls."],
  });
  const prompt = assembleSystemPrompt(context);

  assert.ok(prompt.includes("Policy notes:"));
  assert.ok(prompt.includes("No outbound messages allowed."));
  assert.ok(prompt.includes("Stop at auth walls."));
});

test("assembleSystemPrompt includes budget when present", () => {
  const budget: BudgetSummary = { remaining: 5, max: 10, unit: "runs" };
  const context = makeContext({ budget });
  const prompt = assembleSystemPrompt(context);

  assert.ok(prompt.includes("5/10 runs remaining"));
});

test("assembleSystemPrompt omits budget section when absent", () => {
  const context = makeContext();
  const prompt = assembleSystemPrompt(context);

  assert.ok(!prompt.includes("Budget:"));
});

test("assembleSystemPrompt omits empty constraints", () => {
  const context = makeContext({
    task: makeTask({ constraints: [] }),
  });
  const prompt = assembleSystemPrompt(context);

  assert.ok(!prompt.includes("Constraints:"));
});

test("assembleSystemPrompt omits empty success criteria", () => {
  const context = makeContext({
    task: makeTask({ successCriteria: [] }),
  });
  const prompt = assembleSystemPrompt(context);

  assert.ok(!prompt.includes("Success criteria:"));
});

test("assembleSystemPrompt redacts API keys", () => {
  const context = makeContext({
    task: makeTask({ objective: "Use key sk-1234567890abcdef1234567890 to access the API." }),
  });
  const prompt = assembleSystemPrompt(context);

  assert.ok(!prompt.includes("sk-1234567890"));
  assert.ok(prompt.includes("[REDACTED]"));
});

test("assembleSystemPrompt redacts secrets in constraints", () => {
  const context = makeContext({
    task: makeTask({
      constraints: ["password=mysecretvalue12345678 should not be logged."],
    }),
  });
  const prompt = assembleSystemPrompt(context);

  assert.ok(!prompt.includes("mysecretvalue"));
  assert.ok(prompt.includes("[REDACTED]"));
});

// ---------------------------------------------------------------------------
// assembleUserPrompt
// ---------------------------------------------------------------------------

test("assembleUserPrompt returns fallback when no context", () => {
  const context = makeContext();
  const prompt = assembleUserPrompt(context);

  assert.ok(prompt.includes("No context available yet"));
});

test("assembleUserPrompt includes loaded skills", () => {
  const skills: SkillSummary[] = [
    { id: "stripe-dashboard", scope: "domain", matchReason: "Hostname match" },
    { id: "form-helper", scope: "interaction", matchReason: "Tag match" },
  ];
  const context = makeContext({ skills });
  const prompt = assembleUserPrompt(context);

  assert.ok(prompt.includes("Loaded skills:"));
  assert.ok(prompt.includes("stripe-dashboard"));
  assert.ok(prompt.includes("Hostname match"));
});

test("assembleUserPrompt includes current observation", () => {
  const observations: ObservationSummary[] = [
    { url: "https://dashboard.example.com/invoices", title: "Invoices", forms: 1, buttons: 3, dialogs: 0 },
  ];
  const context = makeContext({ observations });
  const prompt = assembleUserPrompt(context);

  assert.ok(prompt.includes("https://dashboard.example.com/invoices"));
  assert.ok(prompt.includes("Invoices"));
  assert.ok(prompt.includes("1 forms, 3 buttons, 0 dialogs"));
});

test("assembleUserPrompt uses the latest observation as the current page", () => {
  const observations: ObservationSummary[] = [
    { url: "https://example.com/old", title: "Old", forms: 0, buttons: 1, dialogs: 0 },
    { url: "https://example.com/current", title: "Current", forms: 1, buttons: 2, dialogs: 0 },
  ];
  const context = makeContext({ observations });
  const prompt = assembleUserPrompt(context);

  assert.ok(prompt.includes("Current page: https://example.com/current"));
  assert.ok(prompt.includes("Title: Current"));
  assert.ok(!prompt.includes("https://example.com/old"));
});

test("assembleUserPrompt shows observation without title", () => {
  const observations: ObservationSummary[] = [
    { url: "https://example.com", title: "", forms: 0, buttons: 0, dialogs: 0 },
  ];
  const context = makeContext({ observations });
  const prompt = assembleUserPrompt(context);

  assert.ok(prompt.includes("Current page: https://example.com"));
  assert.ok(!prompt.includes("Title:"));
});

test("assembleUserPrompt includes recent traces capped at 5", () => {
  const traces: TraceSummary[] = Array.from({ length: 8 }, (_, i) => ({
    kind: "code-exec",
    summary: `Executed step ${i}.`,
  }));
  const context = makeContext({ recentTraces: traces });
  const prompt = assembleUserPrompt(context);

  assert.ok(prompt.includes("Recent activity:"));
  // Should include only the last 5 traces (steps 3-7)
  assert.ok(!prompt.includes("step 0."));
  assert.ok(!prompt.includes("step 2."));
  assert.ok(prompt.includes("step 3."));
  assert.ok(prompt.includes("step 7."));
});

test("assembleUserPrompt redacts secrets in skill match reasons", () => {
  const skills: SkillSummary[] = [
    { id: "test", scope: "domain", matchReason: "Using bearer sk-1234567890abcdef1234567890" },
  ];
  const context = makeContext({ skills });
  const prompt = assembleUserPrompt(context);

  assert.ok(!prompt.includes("sk-1234567890"));
  assert.ok(prompt.includes("[REDACTED]"));
});

test("assembleUserPrompt redacts secrets in trace summaries", () => {
  const traces: TraceSummary[] = [
    { kind: "observation", summary: "Found token_abcdefghijklmnop in page." },
  ];
  const context = makeContext({ recentTraces: traces });
  const prompt = assembleUserPrompt(context);

  assert.ok(!prompt.includes("token_abcdefghijklmnop"));
  assert.ok(prompt.includes("[REDACTED]"));
});

// ---------------------------------------------------------------------------
// Cross-cutting: mode variants
// ---------------------------------------------------------------------------

test("assembleSystemPrompt handles investigate mode", () => {
  const context = makeContext({
    task: makeTask({ mode: "investigate", objective: "Find why login fails." }),
  });
  const prompt = assembleSystemPrompt(context);

  assert.ok(prompt.includes("investigate mode"));
  assert.ok(prompt.includes("Find why login fails."));
});

test("assembleSystemPrompt handles experiment mode", () => {
  const context = makeContext({
    task: makeTask({ mode: "experiment", objective: "Test billing hypothesis." }),
  });
  const prompt = assembleSystemPrompt(context);

  assert.ok(prompt.includes("experiment mode"));
});

// ---------------------------------------------------------------------------
// Cross-cutting: combined prompts produce no secrets
// ---------------------------------------------------------------------------

test("combined system+user prompts contain no secret patterns", () => {
  const skills: SkillSummary[] = [
    { id: "test", scope: "domain", matchReason: "Match with key_keyvalue123456789abcde" },
  ];
  const observations: ObservationSummary[] = [
    { url: "https://app.example.com/dashboard", title: "Dashboard", forms: 2, buttons: 5, dialogs: 1 },
  ];
  const traces: TraceSummary[] = [
    { kind: "code-exec", summary: "Executed with bearer abc123token456def" },
  ];
  const context = makeContext({
    task: makeTask({
      objective: "Use sk-aaaaaaaaaaaaaaaaaaaaaaaaaa to download data.",
      constraints: ["Never expose password=supersecretpassword"],
    }),
    skills,
    observations,
    recentTraces: traces,
    policyNotes: ["Token tokensecret1234567890 must not leak."],
    budget: { remaining: 3, max: 10, unit: "runs" },
  });

  const system = assembleSystemPrompt(context);
  const user = assembleUserPrompt(context);
  const combined = system + user;

  // Verify no raw secrets leaked
  assert.ok(!combined.includes("sk-aaaaaaaaaaaaaaaa"));
  assert.ok(!combined.includes("supersecretpassword"));
  assert.ok(!combined.includes("abc123token456def"));
  assert.ok(!combined.includes("tokensecret1234567890"));
  assert.ok(!combined.includes("keyvalue123456789"));

  // Verify meaningful content is preserved
  assert.ok(combined.includes("download data"));
  assert.ok(combined.includes("Dashboard"));
  assert.ok(combined.includes("3/10 runs"));
});
