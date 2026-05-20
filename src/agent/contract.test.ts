import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type { Task, TraceEvent } from "../shared/types.js";
import {
  contractToPrompt,
  createTaskContract,
  validateTaskContract,
} from "./contract.js";
import { classifyRun } from "./classify.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Contract test",
    mode: "task",
    objective: "Complete task",
    constraints: [],
    successCriteria: ["Task complete"],
    createdAt: nowIsoUtc(),
    ...overrides,
  };
}

function event(kind: TraceEvent["kind"], payload: TraceEvent["payload"]): TraceEvent {
  return {
    id: createId("event"),
    runId: createId("run"),
    ts: nowIsoUtc(),
    kind,
    payload,
  };
}

test("createTaskContract infers domains and markdown table output", () => {
  const contract = createTaskContract(makeTask({
    objective: "Open the pricing pages of vercel.com, netlify.com, and railway.app. Extract everything and save as comparison table in md format.",
  }));

  assert.deepEqual(contract.mustVisit, ["vercel.com", "netlify.com", "railway.app"]);
  assert.deepEqual(contract.mustMention, ["Vercel", "Netlify", "Railway"]);
  assert.equal(contract.mustProduce?.artifact, true);
  assert.equal(contract.mustProduce?.format, "markdown");
  assert.equal(contract.mustProduce?.table, true);
  assert.ok(contract.mustNotContain.includes("see open"));
  assert.match(contractToPrompt(contract), /Must visit: vercel\.com, netlify\.com, railway\.app/u);
});

test("createTaskContract does not treat filenames as domains", () => {
  const contract = createTaskContract(makeTask({
    objective: "Save data to output.json from package.json and summarize vue.js notes in markdown.",
  }));

  assert.deepEqual(contract.mustVisit, []);
  assert.deepEqual(contract.mustMention, []);
  assert.equal(contract.mustProduce?.format, "markdown");
});

test("validateTaskContract rejects placeholder multi-site extraction artifacts", () => {
  const contract = createTaskContract(makeTask({
    objective: "Open the pricing pages of vercel.com, netlify.com, and railway.app. Extract everything and save as comparison table in md format.",
  }));
  const events = [
    event("observation", { url: "https://vercel.com/pricing", title: "Vercel Pricing" }),
    event("observation", { url: "https://www.netlify.com/pricing/", title: "Pricing and Plans" }),
    event("observation", { url: "https://railway.com/pricing", title: "Pricing - Railway" }),
    event("artifact", {
      filename: "pricing-comparison.md",
      kind: "markdown",
      mimeType: "text/markdown",
      content: [
        "# Pricing Comparison",
        "| Field | Vercel | Netlify | Railway |",
        "| --- | --- | --- | --- |",
        "| Title | Vercel Pricing | Pricing and Plans | Pricing - Railway |",
        "## Netlify",
        "See open Netlify pricing tab in this browser session.",
        "## Railway",
        "Content was included in prior extraction artifact context.",
      ].join("\n"),
    }),
  ];

  const validation = validateTaskContract(contract, events);
  assert.equal(validation.passed, false);
  assert.ok(validation.totalChecks > validation.missing.length);
  assert.ok(validation.satisfied.some((item) => item.includes("Visited vercel.com")));
  assert.ok(validation.missing.some((item) => item.includes("see open")));
  assert.ok(validation.missing.some((item) => item.includes("included in prior")));
});

test("validateTaskContract accepts a substantive markdown comparison artifact", () => {
  const contract = createTaskContract(makeTask({
    objective: "Open vercel.com, netlify.com, and railway.app. Extract pricing and save as comparison table in markdown.",
  }));
  const events = [
    event("observation", { url: "https://vercel.com/pricing", title: "Vercel Pricing" }),
    event("observation", { url: "https://www.netlify.com/pricing/", title: "Pricing and Plans" }),
    event("observation", { url: "https://railway.app/pricing", title: "Pricing - Railway" }),
    event("artifact", {
      filename: "comparison.md",
      kind: "markdown",
      mimeType: "text/markdown",
      content: [
        "| Plan | Vercel | Netlify | Railway |",
        "| --- | --- | --- | --- |",
        "| Free | Hobby free forever | Starter free | Trial/free tier available |",
        "| Paid | Pro $20/month plus usage | Pro paid tier | Usage-based paid plans |",
        "| Enterprise | Custom | Enterprise custom | Enterprise/custom |",
      ].join("\n"),
    }),
  ];

  assert.equal(validateTaskContract(contract, events).passed, true);
});

test("createTaskContract requires 2048 evidence for win objective", () => {
  const contract = createTaskContract(makeTask({ objective: "Play 2048 game and win" }));

  assert.deepEqual(contract.mustReach, [{ kind: "contains-number", value: 2048 }]);
  assert.equal(validateTaskContract(contract, [], "max tile is 1024").passed, false);
  assert.equal(validateTaskContract(contract, [], "board: [2,4,1024,2048]").passed, true);
});

test("createTaskContract does not require unrelated numbers for generic win objectives", () => {
  const contract = createTaskContract(makeTask({
    objective: "Win the 100m sprint by 2024 under 5000 budget",
  }));

  assert.deepEqual(contract.mustReach, []);
});

test("classifyRun downgrades completion when contract check failed", () => {
  const events = [
    event("code-result", {
      ok: true,
      durationMs: 1,
      returnValue: {
        artifacts: [{
          filename: "pricing-comparison.md",
          kind: "markdown",
          mimeType: "text/markdown",
          content: "Vercel Netlify Railway comparison table",
        }],
      },
    }),
    event("artifact", {
      filename: "pricing-comparison.md",
      kind: "markdown",
      mimeType: "text/markdown",
      content: "Vercel Netlify Railway comparison table",
    }),
    event("contract-check", {
      passed: false,
      missing: ["Final result contains placeholder text: see open"],
    }),
  ];

  const classification = classifyRun({
    mode: "task",
    events,
    successCriteria: ["Saved comparison"],
    objective: "Open vercel.com, netlify.com, and railway.app and save comparison table",
    errorCount: 0,
    authWallHit: false,
    policyDenied: false,
    budgetExhausted: false,
  });

  assert.equal(classification.kind, "partial-success");
  assert.ok(classification.notes?.some((note) => note.includes("Completion contract failed")));
});
