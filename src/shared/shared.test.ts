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
import {
  redactJsonObject,
  redactSecrets,
} from "./redact.js";
import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  CreateSessionInput,
  JsonObject,
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

// ---------------------------------------------------------------------------
// redactSecrets
// ---------------------------------------------------------------------------

test("redactSecrets replaces API key patterns with [REDACTED]", () => {
  const result = redactSecrets("Use key sk-1234567890abcdef1234567890 to connect.");

  assert.ok(!result.includes("sk-1234567890"));
  assert.ok(result.includes("[REDACTED]"));
  assert.ok(result.includes("Use key"));
  assert.ok(result.includes("to connect."));
});

test("redactSecrets replaces password patterns", () => {
  const result = redactSecrets("Use password=mysecretvalue123456 to authenticate.");

  assert.ok(!result.includes("mysecretvalue"));
  assert.ok(result.includes("[REDACTED]"));
});

// ---------------------------------------------------------------------------
// redactJsonObject
// ---------------------------------------------------------------------------

test("redactJsonObject recursively redacts string values in nested objects", () => {
  const input = {
    level1: "key_abcdefghijklmnop123456789",
    nested: {
      level2: "sk-1234567890abcdef1234567890",
      deep: {
        level3: "password=supersecretpassword123",
      },
    },
    safe: "this is fine",
  };

  const result = redactJsonObject(input);

  assert.ok(!result.level1?.toString().includes("abcdefghijklmnop"));
  const nested = result.nested as JsonObject;
  assert.ok(!String(nested?.level2 ?? "").includes("sk-123456"));
  const deep = nested?.deep as JsonObject;
  assert.ok(!String(deep?.level3 ?? "").includes("supersecret"));
  assert.equal(result.safe, "this is fine");
});

test("redactJsonObject handles arrays containing secrets", () => {
  const input = {
    keys: ["sk-1234567890abcdef1234567890", "normal value"],
    items: [
      { token: "token_abcdefghijklmnop12345678" },
      { token: "clean" },
    ],
  };

  const result = redactJsonObject(input);

  const keys = result.keys as string[];
  assert.ok(keys[0]!.includes("[REDACTED]"));
  assert.equal(keys[1], "normal value");

  const items = result.items as Array<{ token: string }>;
  assert.ok(items[0]!.token.includes("[REDACTED]"));
  assert.equal(items[1]!.token, "clean");
});

test("redactJsonObject preserves non-string values", () => {
  const input = {
    count: 42,
    active: true,
    empty: null,
    data: { nested: 99 },
  };

  const result = redactJsonObject(input);

  assert.equal(result.count, 42);
  assert.equal(result.active, true);
  assert.equal(result.empty, null);
  assert.deepEqual(result.data, { nested: 99 });
});
