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
  // mustMention is no longer inferred from domains — mustVisit covers
  // navigation, and a brand-word content requirement falsely fails runs.
  assert.deepEqual(contract.mustMention, []);
  assert.equal(contract.mustProduce?.artifact, true);
  assert.equal(contract.mustProduce?.format, "markdown");
  assert.equal(contract.mustProduce?.table, true);
  assert.ok(contract.mustNotContain.includes("see open"));
  assert.match(contractToPrompt(contract), /Must visit: vercel\.com, netlify\.com, railway\.app/u);
});

test("createTaskContract infers no mention requirement from a navigation-target domain", () => {
  // Regression: "news.ycombinator.com" derived mustMention ["News"] from the
  // leftmost domain segment, so a correct top-5 extraction (whose result need
  // not contain the word "News") failed the contract and looped to max steps.
  const contract = createTaskContract(makeTask({
    objective: "Go to news.ycombinator.com and return the titles and point counts of the top 5 stories",
  }));

  assert.deepEqual(contract.mustVisit, ["news.ycombinator.com"]);
  assert.deepEqual(contract.mustMention, []);
  assert.equal(contract.mustProduce?.minItems, 5);
});

test("createTaskContract does not infer text format from incidental 'text' in objective", () => {
  // Regression: "Go to example.com and return the heading text" inferred
  // mustProduce.format="text" because of the bare \btext\b match. The agent
  // produced a markdown answer (correct) and contract validation marked the
  // run as missing-text-artifact. Format inference now requires a context
  // that actually implies the desired output shape.
  const incidental = [
    "Go to example.com and return the heading text",
    "Extract the page text content",
    "Read the text of the article",
    "Summarize the body text",
  ];
  for (const objective of incidental) {
    const contract = createTaskContract(makeTask({ objective }));
    assert.notEqual(contract.mustProduce?.format, "text", `expected no text format from: ${objective}`);
  }
});

test("createTaskContract infers text format from explicit output-format phrases", () => {
  const explicit = [
    "Extract the headlines and return as text",
    "Save the response as plain text",
    "Output as text format",
    "Write the result to output.txt",
    "Return the summary in text format",
  ];
  for (const objective of explicit) {
    const contract = createTaskContract(makeTask({ objective }));
    assert.equal(contract.mustProduce?.format, "text", `expected text format from: ${objective}`);
  }
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
        "Previously extracted in this run, but the raw text was not preserved.",
        "## Railway",
        "Content was included in prior extraction artifact context.",
      ].join("\n"),
    }),
  ];

  const validation = validateTaskContract(contract, events);
  assert.equal(validation.passed, false);
  assert.ok(validation.totalChecks > validation.missing.length);
  assert.ok(validation.satisfied.some((item) => item.includes("Visited vercel.com")));
  assert.ok(validation.missing.some((item) => item.includes("previously extracted")));
  assert.ok(validation.missing.some((item) => item.includes("raw text was not preserved")));
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

test("createTaskContract no longer fabricates a 'win the number' completion contract", () => {
  // Regression: a game/win heuristic injected a `contains-number` requirement
  // (e.g. "Play 2048 game and win" forced the answer to contain 2048). That was
  // single-pattern lore living in the universal contract builder; game success
  // is judged by benchmark rubrics, not by the completion contract.
  const contract = createTaskContract(makeTask({ objective: "Play 2048 game and win" }));

  assert.equal(contract.mustProduce, undefined);
  assert.equal(validateTaskContract(contract, [], "max tile is 1024").passed, true);
});

test("createTaskContract does not invent requirements from incidental numbers", () => {
  const contract = createTaskContract(makeTask({
    objective: "Win the 100m sprint by 2024 under 5000 budget",
  }));

  assert.equal(contract.mustProduce, undefined);
  assert.equal(validateTaskContract(contract, [], "no numbers here").passed, true);
});

test("createTaskContract does not invent repeated-work completion semantics", () => {
  const gameContract = createTaskContract(makeTask({
    objective: "Play 2048 and achieve high score for 5 games",
  }));
  assert.equal(gameContract.mustProduce, undefined);
  assert.equal(validateTaskContract(gameContract, [], "one page snapshot").passed, true);

  const jobContract = createTaskContract(makeTask({
    objective: "Apply to 5 jobs and keep a record of each submission",
  }));
  assert.equal(jobContract.mustProduce?.minItems, undefined);

  const listContract = createTaskContract(makeTask({
    objective: "Return the top 5 stories from news.ycombinator.com",
  }));
  assert.equal(listContract.mustProduce?.minItems, 5);
});

test("createTaskContract validates a minItems requirement exactly once", () => {
  // "find/list/top N" sets mustProduce.minItems. It must be checked a single
  // time — previously it was also mirrored into a redundant mustReach entry and
  // validated twice, inflating totalChecks for every list task.
  const contract = createTaskContract(makeTask({
    objective: "Find the top 10 trending repos and list them",
  }));

  assert.equal(contract.mustProduce?.minItems, 10);

  const validation = validateTaskContract(contract, [], "1. one\n2. two\n3. three");
  assert.equal(validation.passed, false);
  const minItemsMisses = validation.missing.filter((item) => item.includes("at least 10 items"));
  assert.equal(minItemsMisses.length, 1, "minItems must be validated exactly once");
});

test("validateTaskContract counts JSON items when the answer blends result, artifact, and code-result", () => {
  // Regression: a correct "top 5" run produced a 5-item JSON object, but the
  // minItems check concatenates result + artifact content + the latest
  // code-result into one blob, so JSON.parse on the whole string threw and the
  // count fell back to 0 — failing a complete run and burning every remaining
  // step. The count must find the embedded JSON and see all 5 items.
  const contract = createTaskContract(makeTask({
    objective: "Go to news.ycombinator.com and return the titles and point counts of the top 5 stories on the front page as a numbered list",
  }));
  assert.equal(contract.mustProduce?.minItems, 5);

  const result = JSON.stringify({
    site: "Hacker News",
    items: [
      { rank: 1, title: "Why Janet?", points: "194 points" },
      { rank: 2, title: "Apple rejected my dictation app", points: "44 points" },
      { rank: 3, title: "Adafruit demand letter", points: "173 points" },
      { rank: 4, title: "CSS-Native Parallax Effect", points: "48 points" },
      { rank: 5, title: "The newest Instagram exploit", points: "1925 points" },
    ],
  });
  const events = [
    event("observation", { url: "https://news.ycombinator.com/", title: "Hacker News" }),
    event("artifact", { filename: "output.json", kind: "json-output", mimeType: "application/json", content: result }),
    event("code-result", { ok: true, source: "inspect", stdout: result }),
  ];

  const validation = validateTaskContract(contract, events, result);
  assert.ok(
    !validation.missing.some((item) => item.includes("at least 5 items")),
    "a 5-item JSON result must satisfy the minItems check",
  );
  assert.ok(validation.satisfied.some((item) => item.includes("at least 5 items")));
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
