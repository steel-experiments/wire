import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  cloneJson,
  createId,
  isEntityId,
  isIsoUtcTimestamp,
  nowIsoUtc,
  stableJsonStringify,
} from "./ids.js";
import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  CreateSessionInput,
  SkillFrontmatter,
  Task,
} from "./types.js";
import {
  browserExecRequestSchema,
  browserExecResultSchema,
  browserObservationSchema,
  createSessionInputSchema,
  parseBoundary,
  safeParseBoundary,
  skillFrontmatterSchema,
  taskSchema,
} from "./schemas.js";

test("createId generates prefixed entity ids", () => {
  const id = createId("task");

  assert.equal(isEntityId(id, "task"), true);
});

test("timestamps use strict UTC ISO format", () => {
  const value = nowIsoUtc(new Date("2026-04-24T12:00:00.123Z"));

  assert.equal(value, "2026-04-24T12:00:00.123Z");
  assert.equal(isIsoUtcTimestamp(value), true);
  assert.equal(isIsoUtcTimestamp("2026-04-24"), false);
});

test("stableJsonStringify sorts object keys recursively", () => {
  const result = stableJsonStringify({
    zebra: 1,
    alpha: {
      beta: true,
      aardvark: [3, { y: 2, x: 1 }],
    },
  });

  assert.equal(
    result,
    '{"alpha":{"aardvark":[3,{"x":1,"y":2}],"beta":true},"zebra":1}',
  );
});

test("cloneJson returns a deep clone", () => {
  const source = { nested: { values: [1, 2, 3] } };
  const cloned = cloneJson(source);

  cloned.nested.values.push(4);

  assert.deepEqual(source, { nested: { values: [1, 2, 3] } });
});

test("taskSchema accepts persisted task boundaries", () => {
  const task = parseBoundary<Task>(
    taskSchema,
    {
      id: createId("task"),
      title: "Download invoices",
      mode: "task",
      objective: "Collect all invoices from the billing portal.",
      constraints: ["Do not submit forms without approval."],
      successCriteria: ["Every invoice is downloaded."],
      createdAt: nowIsoUtc(new Date("2026-04-24T09:00:00.000Z")),
      budget: {
        maxRuns: 3,
        maxUsd: 2,
      },
    },
    "task",
  );

  assert.equal(task.mode, "task");
});

test("skillFrontmatterSchema validates boundary-only skill metadata", () => {
  const skill = parseBoundary<SkillFrontmatter>(
    skillFrontmatterSchema,
    {
      id: createId("skill"),
      title: "Stripe dashboard",
      scope: "domain",
      hostnamePatterns: ["dashboard.stripe.com"],
      tags: ["billing", "invoices"],
      updatedAt: "2026-04-24",
      source: "team",
    },
    "skill-frontmatter",
  );

  assert.equal(skill.scope, "domain");
});

test("provider input and output schemas validate browser boundaries", () => {
  const sessionInput = parseBoundary<CreateSessionInput>(
    createSessionInputSchema,
    {
      profileId: createId("profile"),
      region: "us-west-2",
      proxyCountryCode: "US",
      timeoutMinutes: 30,
      metadata: { experiment: "warm-profile" },
    },
    "create-session-input",
  );

  const execRequest = parseBoundary<BrowserExecRequest>(
    browserExecRequestSchema,
    {
      sessionId: createId("session"),
      code: "return document.title;",
      target: { tabId: "tab-1" },
      attachments: ["helpers/forms.ts"],
      timeoutMs: 10_000,
    },
    "browser-exec-request",
  );

  const execResult = parseBoundary<BrowserExecResult>(
    browserExecResultSchema,
    {
      ok: true,
      stdout: "Invoice page ready",
      returnValue: { title: "Invoices" },
      artifactIds: [createId("artifact")],
      durationMs: 250,
    },
    "browser-exec-result",
  );

  const observation = parseBoundary<BrowserObservation>(
    browserObservationSchema,
    {
      sessionId: createId("session"),
      url: "https://example.com/invoices",
      title: "Invoices",
      tabs: [
        {
          id: "tab-1",
          title: "Invoices",
          url: "https://example.com/invoices",
          active: true,
        },
      ],
      pageSummary: {
        buttons: 4,
        forms: 1,
      },
    },
    "browser-observation",
  );

  assert.equal(sessionInput.proxyCountryCode, "US");
  assert.deepEqual(execRequest.target, { tabId: "tab-1" });
  assert.equal(execResult.ok, true);
  assert.equal(observation.tabs.length, 1);
});

test("safeParseBoundary reports invalid payloads without throwing", () => {
  const result = safeParseBoundary(
    browserExecRequestSchema,
    {
      sessionId: "not-a-session-id",
      code: "",
    },
    "browser-exec-request",
  );

  assert.equal(result.success, false);
  assert.match(result.error.message, /browser-exec-request/u);
  assert.match(result.issues[0]?.message ?? "", /session/u);
});
