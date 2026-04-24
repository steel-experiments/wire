import { strict as assert } from "node:assert";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  BrowserRawRequest,
} from "../shared/types.js";
import type { JsonObject } from "../shared/types.js";
import type { BrowserObserveInput, BrowserProvider } from "./bridge.js";
import { execCode } from "./exec.js";
import { observeBrowser } from "./observe.js";
import { execRaw } from "./raw.js";
import { describeTarget, resolveTarget } from "./targets.js";

// ---------------------------------------------------------------------------
// Mock provider
// ---------------------------------------------------------------------------

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
    async observe(_input: BrowserObserveInput): Promise<BrowserObservation> {
      return {
        sessionId: _input.sessionId,
        url: "https://example.com",
        title: "Example",
        tabs: [
          { id: "tab-1", title: "Example", url: "https://example.com", active: true },
        ],
      };
    },
    async exec(_input: BrowserExecRequest): Promise<BrowserExecResult> {
      return {
        ok: true,
        durationMs: 10,
      };
    },
    async raw(_input: BrowserRawRequest): Promise<unknown> {
      return { result: "ok" };
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// observeBrowser tests
// ---------------------------------------------------------------------------

test("observeBrowser delegates to provider.observe with correct sessionId", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserObserveInput | undefined;

  const provider = createMockProvider({
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      capturedInput = input;
      return {
        sessionId: input.sessionId,
        url: "https://example.com/page",
        title: "Test Page",
        tabs: [
          { id: "tab-1", title: "Test Page", url: "https://example.com/page", active: true },
        ],
      };
    },
  });

  const result = await observeBrowser({ provider, sessionId });

  assert.ok(capturedInput);
  assert.equal(capturedInput.sessionId, sessionId);
  assert.equal(capturedInput.targetId, undefined);
  assert.equal(result.sessionId, sessionId);
  assert.equal(result.url, "https://example.com/page");
  assert.equal(result.title, "Test Page");
  assert.equal(result.tabs.length, 1);
});

test("observeBrowser passes targetId when provided", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserObserveInput | undefined;

  const provider = createMockProvider({
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      capturedInput = input;
      const obs: BrowserObservation = {
        sessionId: input.sessionId,
        url: "https://example.com",
        title: "Example",
        tabs: [],
      };
      if (input.targetId) {
        obs.targetId = input.targetId;
      }
      return obs;
    },
  });

  const result = await observeBrowser({ provider, sessionId, targetId: "tab-42" });

  assert.ok(capturedInput);
  assert.equal(capturedInput.targetId, "tab-42");
  assert.equal(result.targetId, "tab-42");
});

test("observeBrowser does not set targetId when omitted", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserObserveInput | undefined;

  const provider = createMockProvider({
    async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
      capturedInput = input;
      return {
        sessionId: input.sessionId,
        url: "https://example.com",
        title: "Example",
        tabs: [],
      };
    },
  });

  await observeBrowser({ provider, sessionId });

  assert.ok(capturedInput);
  assert.ok(!("targetId" in capturedInput));
});

test("observeBrowser returns observation with artifacts", async () => {
  const sessionId = createId("session");
  const screenshotId = createId("artifact");

  const provider = createMockProvider({
    async observe(_input: BrowserObserveInput): Promise<BrowserObservation> {
      return {
        sessionId: _input.sessionId,
        url: "https://example.com",
        title: "Example",
        tabs: [],
        screenshotArtifactId: screenshotId,
        pageSummary: {
          visibleTexts: ["Hello", "World"],
          forms: 1,
          buttons: 3,
        },
      };
    },
  });

  const result = await observeBrowser({ provider, sessionId });

  assert.equal(result.screenshotArtifactId, screenshotId);
  assert.ok(result.pageSummary);
  assert.equal(result.pageSummary.forms, 1);
  assert.equal(result.pageSummary.buttons, 3);
  assert.deepEqual(result.pageSummary.visibleTexts, ["Hello", "World"]);
});

test("observeBrowser propagates provider errors", async () => {
  const provider = createMockProvider({
    async observe(): Promise<BrowserObservation> {
      throw new Error("Session not found");
    },
  });

  await assert.rejects(
    () => observeBrowser({ provider, sessionId: createId("session") }),
    { message: "Session not found" },
  );
});

// ---------------------------------------------------------------------------
// execCode tests
// ---------------------------------------------------------------------------

test("execCode delegates to provider.exec with code", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserExecRequest | undefined;

  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      capturedInput = input;
      return { ok: true, durationMs: 42 };
    },
  });

  const result = await execCode({ provider, sessionId, code: "document.title" });

  assert.ok(capturedInput);
  assert.equal(capturedInput.code, "document.title");
  assert.equal(capturedInput.sessionId, sessionId);
  assert.equal(capturedInput.target, "active-tab");
  assert.equal(result.ok, true);
  assert.equal(result.durationMs, 42);
});

test("execCode passes timeout when provided", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserExecRequest | undefined;

  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      capturedInput = input;
      return { ok: true, durationMs: 5 };
    },
  });

  await execCode({ provider, sessionId, code: "1+1", timeoutMs: 5000 });

  assert.ok(capturedInput);
  assert.equal(capturedInput.timeoutMs, 5000);
});

test("execCode does not set timeout when omitted", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserExecRequest | undefined;

  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      capturedInput = input;
      return { ok: true, durationMs: 5 };
    },
  });

  await execCode({ provider, sessionId, code: "1+1" });

  assert.ok(capturedInput);
  assert.ok(!("timeoutMs" in capturedInput));
});

test("execCode passes explicit target to provider", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserExecRequest | undefined;

  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      capturedInput = input;
      return { ok: true, durationMs: 5 };
    },
  });

  await execCode({ provider, sessionId, code: "1+1", target: "all-tabs" });

  assert.ok(capturedInput);
  assert.equal(capturedInput.target, "all-tabs");
});

test("execCode passes tab-specific target to provider", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserExecRequest | undefined;

  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      capturedInput = input;
      return { ok: true, durationMs: 5 };
    },
  });

  await execCode({ provider, sessionId, code: "1+1", target: { tabId: "tab-99" } });

  assert.ok(capturedInput);
  assert.deepEqual(capturedInput.target, { tabId: "tab-99" });
});

test("execCode passes attachments when provided with items", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserExecRequest | undefined;

  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      capturedInput = input;
      return { ok: true, durationMs: 5 };
    },
  });

  await execCode({ provider, sessionId, code: "upload()", attachments: ["/tmp/file.csv"] });

  assert.ok(capturedInput);
  assert.deepEqual(capturedInput.attachments, ["/tmp/file.csv"]);
});

test("execCode does not set attachments when omitted", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserExecRequest | undefined;

  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      capturedInput = input;
      return { ok: true, durationMs: 5 };
    },
  });

  await execCode({ provider, sessionId, code: "1+1" });

  assert.ok(capturedInput);
  assert.ok(!("attachments" in capturedInput));
});

test("execCode does not set attachments when array is empty", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserExecRequest | undefined;

  const provider = createMockProvider({
    async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
      capturedInput = input;
      return { ok: true, durationMs: 5 };
    },
  });

  await execCode({ provider, sessionId, code: "1+1", attachments: [] });

  assert.ok(capturedInput);
  assert.ok(!("attachments" in capturedInput));
});

test("execCode returns full result with stdout/stderr", async () => {
  const sessionId = createId("session");

  const provider = createMockProvider({
    async exec(_input: BrowserExecRequest): Promise<BrowserExecResult> {
      return {
        ok: true,
        stdout: "hello",
        stderr: "",
        returnValue: 42,
        artifactIds: [createId("artifact")],
        durationMs: 100,
      };
    },
  });

  const result = await execCode({ provider, sessionId, code: "console.log('hello')" });

  assert.equal(result.ok, true);
  assert.equal(result.stdout, "hello");
  assert.equal(result.returnValue, 42);
  assert.ok(result.artifactIds);
  assert.equal(result.artifactIds.length, 1);
});

test("execCode propagates provider errors", async () => {
  const provider = createMockProvider({
    async exec(): Promise<BrowserExecResult> {
      throw new Error("Execution timeout");
    },
  });

  await assert.rejects(
    () => execCode({ provider, sessionId: createId("session"), code: "while(true){}" }),
    { message: "Execution timeout" },
  );
});

// ---------------------------------------------------------------------------
// execRaw tests
// ---------------------------------------------------------------------------

test("execRaw delegates to provider.raw with method and params", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserRawRequest | undefined;

  const provider = createMockProvider({
    async raw(input: BrowserRawRequest): Promise<unknown> {
      capturedInput = input;
      return { value: 42 };
    },
  });

  const result = await execRaw({
    provider,
    sessionId,
    method: "Runtime.evaluate",
    params: { expression: "1+1" } as JsonObject,
  });

  assert.ok(capturedInput);
  assert.equal(capturedInput.method, "Runtime.evaluate");
  assert.deepEqual(capturedInput.params, { expression: "1+1" });
  assert.deepEqual(result, { value: 42 });
});

test("execRaw works without params", async () => {
  const sessionId = createId("session");
  let capturedInput: BrowserRawRequest | undefined;

  const provider = createMockProvider({
    async raw(input: BrowserRawRequest): Promise<unknown> {
      capturedInput = input;
      return { ok: true };
    },
  });

  await execRaw({ provider, sessionId, method: "Browser.getVersion" });

  assert.ok(capturedInput);
  assert.equal(capturedInput.method, "Browser.getVersion");
  assert.ok(!("params" in capturedInput));
});

test("execRaw throws when provider does not support raw access", async () => {
  const provider: { raw?(input: BrowserRawRequest): Promise<unknown> } = {};

  await assert.rejects(
    () => execRaw({ provider, sessionId: createId("session"), method: "test" }),
    { message: "Provider does not support raw CDP access" },
  );
});

test("execRaw propagates provider errors", async () => {
  const provider = createMockProvider({
    async raw(): Promise<unknown> {
      throw new Error("CDP connection lost");
    },
  });

  await assert.rejects(
    () => execRaw({ provider, sessionId: createId("session"), method: "test" }),
    { message: "CDP connection lost" },
  );
});

// ---------------------------------------------------------------------------
// resolveTarget tests
// ---------------------------------------------------------------------------

test("resolveTarget defaults to active-tab", () => {
  assert.equal(resolveTarget(undefined), "active-tab");
});

test("resolveTarget returns the target when specified", () => {
  assert.equal(resolveTarget("active-tab"), "active-tab");
  assert.equal(resolveTarget("all-tabs"), "all-tabs");
  assert.deepEqual(resolveTarget({ tabId: "tab-1" }), { tabId: "tab-1" });
});

// ---------------------------------------------------------------------------
// describeTarget tests
// ---------------------------------------------------------------------------

test("describeTarget describes active-tab", () => {
  assert.equal(describeTarget("active-tab"), "active tab");
});

test("describeTarget describes all-tabs", () => {
  assert.equal(describeTarget("all-tabs"), "all tabs");
});

test("describeTarget describes specific tab", () => {
  assert.equal(describeTarget({ tabId: "tab-42" }), "tab tab-42");
});
