import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createSteelActionHandlers,
  SteelProvider,
  createSteelProvider,
  validateBrowserCode,
  type SteelLogger,
} from "../../providers/browser/steel.js";
import { createLoopState } from "../../agent/loop.js";
import type { BrowserProvider } from "../../browser/bridge.js";
import { createId } from "../../shared/ids.js";
import type { BrowserObservation, BrowserSession, SessionId, Task } from "../../shared/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a fake Steel session response. */
function fakeSteelSession(overrides: Record<string, unknown> = {}) {
  return {
    id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    status: "active",
    websocketUrl: "wss://connect.steel.dev?sessionId=aaa-bbb-ccc",
    sessionViewerUrl: "https://api.steel.dev/v1/sessions/aaa-bbb-ccc/player",
    createdAt: "2026-04-24T10:00:00.000Z",
    ...overrides,
  };
}

function makeTask(): Task {
  return {
    id: createId("task"),
    title: "test",
    mode: "task",
    objective: "test",
    constraints: [],
    successCriteria: ["done"],
    createdAt: new Date().toISOString(),
  };
}

/** Create a provider with mocked fetch. Returns the provider and a function
 *  to set the mock response for the next request. */
function createMockedProvider() {
  const responses = new Map<string, { ok: boolean; status: number; body: unknown }>();
  const cdpResponses = new Map<string, unknown>();

  class MockSocket {
    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;

    constructor() {
      queueMicrotask(() => this.onopen?.({}));
    }

    send(data: string): void {
      const message = JSON.parse(data) as { id: number; method: string };
      const result = cdpResponses.get(message.method);
      queueMicrotask(() => {
        this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) });
      });
    }

    close(): void {
      this.onclose?.({});
    }
  }

  const provider = new SteelProvider({
    apiKey: "ste-test-key",
    baseUrl: "http://localhost:0/v1",
    webSocketFactory: () => new MockSocket(),
  });

  // Monkey-patch global fetch for test isolation
  const originalFetch = globalThis.fetch;

  const mockFetch = async (url: string | URL | Request, _init?: RequestInit) => {
    const key = String(url).replace("http://localhost:0/v1", "");
    const nextResponse = responses.get(key) ?? { ok: true, status: 200, body: {} };
    if (!nextResponse.ok) {
      return new Response(
        JSON.stringify({ message: String(nextResponse.body) }),
        { status: nextResponse.status, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify(nextResponse.body),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  globalThis.fetch = mockFetch as typeof fetch;

  const setNextResponse = (path: string, body: unknown, ok = true, status = 200) => {
    responses.set(path, { ok, status, body });
  };

  const setCdpResponse = (method: string, body: unknown) => {
    cdpResponses.set(method, body);
  };

  const restore = () => {
    globalThis.fetch = originalFetch;
  };

  return { provider, setNextResponse, setCdpResponse, restore };
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

test("SteelProvider.createSession returns mapped BrowserSession", async () => {
  const { provider, setNextResponse, restore } = createMockedProvider();
  setNextResponse("/sessions", fakeSteelSession());

  try {
    const session = await provider.createSession({});

    assert.ok(session.id.startsWith("session_"));
    assert.equal(session.provider, "steel");
    assert.equal(session.status, "ready");
    assert.ok(session.wsUrl);
    assert.ok(session.liveUrl);
  } finally {
    restore();
  }
});

test("SteelProvider.createSession maps profile and region", async () => {
  const { provider, setNextResponse, restore } = createMockedProvider();
  setNextResponse(
    "/sessions",
    fakeSteelSession({ profileId: "saved-profile-1", region: "lax" }),
  );

  try {
    const session = await provider.createSession({
      profileId: "profile_saved-profile-1" as never,
      region: "LAX",
    });

    assert.equal(session.profileId, "profile_saved-profile-1");
    assert.equal(session.region, "lax");
  } finally {
    restore();
  }
});

test("SteelProvider.createSession drops invalid region before calling Steel", async () => {
  const { provider, restore } = createMockedProvider();
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      capturedBody = JSON.parse(init.body);
    }
    return new Response(
      JSON.stringify(fakeSteelSession()),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const session = await provider.createSession({ sessionConfig: { region: "eu-west-1" } });
    assert.equal(capturedBody.region, undefined);
    assert.equal(session.region, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("SteelProvider.createSession maps Steel status correctly", async () => {
  const { provider, setNextResponse, restore } = createMockedProvider();

  const cases: Array<[string, string]> = [
    ["active", "ready"],
    ["live", "ready"],
    ["created", "starting"],
    ["queued", "starting"],
    ["released", "stopped"],
    ["closed", "stopped"],
    ["timeout", "failed"],
    ["error", "failed"],
  ];

  for (const [steelStatus, expected] of cases) {
    setNextResponse("/sessions", fakeSteelSession({ status: steelStatus }));

    const session = await provider.createSession({});
    assert.equal(session.status, expected, `Expected ${steelStatus} → ${expected}`);
  }

  restore();
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

test("SteelProvider.getSession retrieves existing session", async () => {
  const { provider, setNextResponse, restore } = createMockedProvider();
  setNextResponse("/sessions/aaa-bbb-ccc", fakeSteelSession());

  try {
    const session = await provider.getSession("session_aaa-bbb-ccc" as never);
    assert.equal(session.provider, "steel");
    assert.equal(session.status, "ready");
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// stopSession
// ---------------------------------------------------------------------------

test("SteelProvider.stopSession succeeds on 200", async () => {
  const { provider, setNextResponse, restore } = createMockedProvider();
  setNextResponse("/sessions/aaa-bbb-ccc/release", {});

  try {
    await provider.stopSession("session_aaa-bbb-ccc" as never);
    // No error means success
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test("SteelProvider throws on auth failure (401)", async () => {
  const { provider, setNextResponse, restore } = createMockedProvider();
  setNextResponse("/sessions", "Invalid Steel API Key", false, 401);

  try {
    await assert.rejects(
      () => provider.createSession({}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /401/);
        assert.match(err.message, /Invalid Steel API Key/);
        // Secret must not leak into error messages
        assert.doesNotMatch(err.message, /ste-test-key/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("SteelProvider throws on network error", async () => {
  const { provider, restore } = createMockedProvider();

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("ECONNREFUSED"); };

  try {
    await assert.rejects(
      () => provider.createSession({}),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /Network error/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

// ---------------------------------------------------------------------------
// observe/exec/raw
// ---------------------------------------------------------------------------

test("SteelProvider.observe returns page snapshot", async () => {
  const { provider, setNextResponse, setCdpResponse, restore } = createMockedProvider();
  setNextResponse("/sessions/aaa-bbb-ccc", fakeSteelSession({ id: "aaa-bbb-ccc" }));
  setCdpResponse("Target.getTargets", {
    targetInfos: [{ targetId: "tab-1", type: "page", title: "Example", url: "https://example.com" }],
  });
  setCdpResponse("Target.attachToTarget", { sessionId: "cdp-session-1" });
  setCdpResponse("Runtime.evaluate", {
    result: {
      value: {
        url: "https://example.com/dashboard",
        title: "Dashboard",
        pageSummary: { forms: 1, buttons: 2, dialogs: 0, tables: 0, headings: ["Dashboard"] },
      },
    },
  });

  try {
    const observation = await provider.observe({ sessionId: "session_aaa-bbb-ccc" as never });
    assert.equal(observation.url, "https://example.com/dashboard");
    assert.equal(observation.title, "Dashboard");
    assert.equal(observation.tabs.length, 1);
  } finally {
    restore();
  }
});

test("SteelProvider.exec evaluates code in the page target", async () => {
  const { provider, setNextResponse, setCdpResponse, restore } = createMockedProvider();
  setNextResponse("/sessions/aaa-bbb-ccc", fakeSteelSession({ id: "aaa-bbb-ccc" }));
  setCdpResponse("Target.getTargets", {
    targetInfos: [{ targetId: "tab-1", type: "page", title: "Example", url: "https://example.com" }],
  });
  setCdpResponse("Target.attachToTarget", { sessionId: "cdp-session-1" });
  setCdpResponse("Runtime.evaluate", {
    result: { value: { title: "Example" } },
  });

  try {
    const result = await provider.exec({ sessionId: "session_aaa-bbb-ccc" as never, code: "return { title: document.title };" });
    assert.equal(result.ok, true);
    assert.match(result.stdout ?? "", /Example/);
  } finally {
    restore();
  }
});

test("SteelProvider.raw sends a CDP command over websocket", async () => {
  const { provider, setNextResponse, setCdpResponse, restore } = createMockedProvider();
  setNextResponse("/sessions/aaa-bbb-ccc", fakeSteelSession({ id: "aaa-bbb-ccc" }));
  setCdpResponse("Browser.getVersion", { product: "Chrome/123" });

  try {
    const result = await provider.raw({
      sessionId: "session_aaa-bbb-ccc" as never,
      method: "Browser.getVersion",
    });
    assert.deepEqual(result, { product: "Chrome/123" });
  } finally {
    restore();
  }
});

test("SteelProvider.raw attaches page-scoped CDP commands to a target session", async () => {
  const sent: Array<Record<string, unknown>> = [];
  class CapturingSocket {
    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.({}));
    }
    send(data: string): void {
      const message = JSON.parse(data) as { id: number; method: string };
      sent.push(message as unknown as Record<string, unknown>);
      const result = message.method === "Target.getTargets"
        ? { targetInfos: [{ targetId: "tab-1", type: "page", title: "Example", url: "https://example.com" }] }
        : message.method === "Target.attachToTarget"
          ? { sessionId: "cdp-session-1" }
          : { result: { value: 2 } };
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result }) }));
    }
    close(): void {
      this.onclose?.({});
    }
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify(fakeSteelSession({ id: "aaa-bbb-ccc" })),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  try {
    const provider = new SteelProvider({
      apiKey: "ste-test-key",
      webSocketFactory: () => new CapturingSocket(),
    });
    await provider.raw({
      sessionId: "session_aaa-bbb-ccc" as never,
      method: "Runtime.evaluate",
      params: { expression: "1+1" },
    });
    const evaluate = sent.find((message) => message["method"] === "Runtime.evaluate");
    assert.equal(evaluate?.["sessionId"], "cdp-session-1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SteelProvider.raw surfaces close-event detail in error message", async () => {
  // E: WS error path. Bare "CDP socket closed" gave the agent nothing to
  // act on. Close-event code/reason should be in the rejection message.
  class CloseMidFlightSocket {
    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    constructor() {
      queueMicrotask(() => this.onopen?.({}));
    }
    send(_data: string): void {
      // Drop the message and close the socket mid-flight.
      queueMicrotask(() => this.onclose?.({ code: 1006, reason: "abnormal closure", wasClean: false }));
    }
    close(): void { this.onclose?.({ code: 1000, reason: "" }); }
  }

  const logEntries: Array<string> = [];
  const logger: SteelLogger = {
    error(message: string) { logEntries.push(message); },
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify(fakeSteelSession({ id: "aaa-bbb-ccc" })),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const provider = new SteelProvider({
    apiKey: "ste-test-key",
    webSocketFactory: () => new CloseMidFlightSocket(),
    logger,
  });

  try {
    await assert.rejects(
      () => provider.raw({ sessionId: "session_aaa-bbb-ccc" as SessionId, method: "Browser.getVersion" }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /code=1006/);
        assert.match(err.message, /abnormal closure/);
        return true;
      },
    );
    assert.ok(logEntries.some((line) => /steel:ws/.test(line)), "close should be logged via logger");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SteelProvider.raw rejects malformed CDP frames", async () => {
  class BadFrameSocket {
    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;

    constructor() {
      queueMicrotask(() => {
        this.onopen?.({});
        queueMicrotask(() => this.onmessage?.({ data: "not-json" }));
      });
    }

    send(_data: string): void {}

    close(): void {
      this.onclose?.({});
    }
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify(fakeSteelSession({ id: "aaa-bbb-ccc" })),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const provider = new SteelProvider({
    apiKey: "ste-test-key",
    webSocketFactory: () => new BadFrameSocket(),
  });

  try {
    await assert.rejects(
      () => provider.raw({
        sessionId: "session_aaa-bbb-ccc" as never,
        method: "Browser.getVersion",
      }),
      /Invalid CDP message/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SteelProvider.raw times out when CDP does not answer", async () => {
  class NoResponseSocket {
    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;

    constructor() {
      queueMicrotask(() => this.onopen?.({}));
    }

    send(_data: string): void {}

    close(): void {
      this.onclose?.({});
    }
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify(fakeSteelSession({ id: "aaa-bbb-ccc" })),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );

  const provider = new SteelProvider({
    apiKey: "ste-test-key",
    cdpCommandTimeoutMs: 10,
    webSocketFactory: () => new NoResponseSocket(),
  });

  try {
    await assert.rejects(
      () => provider.raw({
        sessionId: "session_aaa-bbb-ccc" as never,
        method: "Browser.getVersion",
      }),
      /CDP command timed out after 10ms: Browser\.getVersion/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("validateBrowserCode rejects unsafe calls without scanning string literals", () => {
  assert.doesNotThrow(
    () => validateBrowserCode("window[\"fetch\"](\"https://example.com\")"),
  );
  assert.throws(
    () => validateBrowserCode("globalThis[\"ev\" + \"al\"](\"1\")"),
    /globalThis\[eval\]/,
  );
  assert.throws(
    () => validateBrowserCode("return document.cookie"),
    /document\.cookie/,
  );
  assert.throws(
    () => validateBrowserCode("return document?.cookie"),
    /document\.cookie/,
  );
  assert.throws(
    () => validateBrowserCode("return window?.eval('1')"),
    /window\.eval/,
  );
  assert.throws(
    () => validateBrowserCode("return document?.[\"co\" + \"okie\"]"),
    /document\[cookie\]/,
  );
  assert.doesNotThrow(
    () => validateBrowserCode("const message = \"fetch( is text only\"; return message;"),
  );
  assert.doesNotThrow(
    () => validateBrowserCode("const data = { fetch: \"metadata\" }; return data.fetch;"),
  );
});

// ---------------------------------------------------------------------------
// createSteelProvider factory
// ---------------------------------------------------------------------------

test("createSteelProvider throws when no API key is available", () => {
  const original = process.env.STEEL_API_KEY;
  delete process.env.STEEL_API_KEY;

  try {
    assert.throws(
      () => createSteelProvider(),
      { message: /STEEL_API_KEY is required/ },
    );
  } finally {
    if (original) process.env.STEEL_API_KEY = original;
  }
});

test("createSteelProvider uses env var when no config provided", () => {
  const original = process.env.STEEL_API_KEY;
  process.env.STEEL_API_KEY = "ste-from-env";

  try {
    const provider = createSteelProvider();
    assert.ok(provider instanceof SteelProvider);
  } finally {
    if (original) {
      process.env.STEEL_API_KEY = original;
    } else {
      delete process.env.STEEL_API_KEY;
    }
  }
});

test("createSteelProvider uses explicit config over env var", () => {
  process.env.STEEL_API_KEY = "ste-from-env";

  try {
    const provider = createSteelProvider({ apiKey: "ste-explicit" });
    assert.ok(provider instanceof SteelProvider);
  } finally {
    delete process.env.STEEL_API_KEY;
  }
});

// ---------------------------------------------------------------------------
// Secret redaction
// ---------------------------------------------------------------------------

test("displaySafeUrl strips apiKey from query params", async () => {
  const { displaySafeUrl } = await import("../../browser/session.js");

  const url = "wss://connect.steel.dev?apiKey=ste-secret-key&sessionId=abc";
  const safe = displaySafeUrl(url);

  assert.ok(safe);
  assert.doesNotMatch(safe, /ste-secret-key/);
  assert.match(safe, /sessionId=abc/);
});

test("displaySafeUrl returns undefined for undefined input", async () => {
  const { displaySafeUrl } = await import("../../browser/session.js");
  assert.equal(displaySafeUrl(undefined), undefined);
});

// ---------------------------------------------------------------------------
// buildCreateSessionBody — sessionConfig mapping
// ---------------------------------------------------------------------------

test("SteelProvider.createSession maps sessionConfig fields to Steel body", async () => {
  // We test indirectly by creating a session with sessionConfig and checking
  // the request body sent to the Steel API.
  const { provider, setNextResponse, restore } = createMockedProvider();
  let capturedBody: Record<string, unknown> = {};

  // Intercept the fetch call to capture the body
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      capturedBody = JSON.parse(init.body);
    }
    return new Response(
      JSON.stringify(fakeSteelSession()),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    await provider.createSession({
      sessionConfig: {
        useProxy: true,
        solveCaptcha: true,
        stealth: true,
        userAgent: "Mozilla/5.0 (custom)",
        region: "IAD",
        locale: "en-US",
        timezone: "America/New_York",
        viewport: { width: 1280, height: 720 },
      },
    });

    assert.equal(capturedBody.useProxy, true);
    assert.equal(capturedBody.solveCaptcha, true);
    assert.equal(capturedBody.stealth, true);
    assert.equal(capturedBody.userAgent, "Mozilla/5.0 (custom)");
    assert.equal(capturedBody.region, "iad");
    assert.equal(capturedBody.locale, "en-US");
    assert.equal(capturedBody.timezone, "America/New_York");
    assert.deepEqual(capturedBody.viewport, { width: 1280, height: 720 });
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("SteelProvider.createSession preserves structured proxy config", async () => {
  const { provider, restore } = createMockedProvider();
  let capturedBody: Record<string, unknown> = {};

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      capturedBody = JSON.parse(init.body);
    }
    return new Response(
      JSON.stringify(fakeSteelSession()),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const proxy = { server: "http://proxy.example:8080", geolocation: { country: "US" } };
    await provider.createSession({ sessionConfig: { useProxy: proxy } });
    assert.deepEqual(capturedBody.useProxy, proxy);
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("SteelProvider.createSession sessionConfig takes precedence over proxyCountryCode", async () => {
  const { provider, restore } = createMockedProvider();
  let capturedBody: Record<string, unknown> = {};

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (typeof init?.body === "string") {
      capturedBody = JSON.parse(init.body);
    }
    return new Response(
      JSON.stringify(fakeSteelSession()),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    await provider.createSession({
      proxyCountryCode: "US",
      sessionConfig: {
        useProxy: true,
      },
    });

    // sessionConfig.useProxy=true wins, not the geolocation object
    assert.equal(capturedBody.useProxy, true);
    assert.equal(typeof capturedBody.useProxy, "boolean");
  } finally {
    globalThis.fetch = originalFetch;
    restore();
  }
});

test("Steel reconfigure action notifies replacement session callback", async () => {
  const oldSessionId = createId("session");
  const newSession: BrowserSession = {
    id: createId("session"),
    provider: "steel",
    createdAt: new Date().toISOString(),
    status: "ready",
    liveUrl: "https://app.steel.dev/sessions/new",
    debugUrl: "https://api.steel.dev/v1/sessions/new/player",
  };
  const state = createLoopState(makeTask(), oldSessionId);
  let stopped: string | undefined;
  let callback:
    | { oldSessionId: string; newSession: BrowserSession; summary: string }
    | undefined;

  const provider: BrowserProvider = {
    async createSession() {
      return newSession;
    },
    async getSession() {
      return newSession;
    },
    async stopSession(id) {
      stopped = id;
    },
    async observe(input): Promise<BrowserObservation> {
      return {
        sessionId: input.sessionId,
        url: "about:blank",
        title: "about:blank",
        tabs: [],
        pageSummary: {},
      };
    },
    async exec() {
      throw new Error("not implemented");
    },
  };

  const handler = createSteelActionHandlers()[0]!;
  await handler.execute(
    state,
    {
      kind: "reconfigure",
      summary: "Enable stealth session",
      payload: { stealth: true },
    },
    provider,
    {
      onSessionReconfigured(details) {
        callback = details;
      },
    },
  );

  assert.equal(stopped, oldSessionId);
  assert.equal(callback?.oldSessionId, oldSessionId);
  assert.equal(callback?.newSession.id, newSession.id);
  assert.equal(callback?.newSession.debugUrl, newSession.debugUrl);
  assert.equal(callback?.summary, "Enable stealth session");
  assert.equal(state.sessionId, newSession.id);
  assert.equal(state.sessionLiveUrl, newSession.liveUrl);
});

test("Steel reconfigure action strips invalid region from requested config", async () => {
  const oldSessionId = createId("session");
  const newSession: BrowserSession = {
    id: createId("session"),
    provider: "steel",
    createdAt: new Date().toISOString(),
    status: "ready",
  };
  const state = createLoopState(makeTask(), oldSessionId);
  state.sessionConfig = { region: "lax", stealth: false };
  let capturedInput: { sessionConfig?: { region?: string; stealth?: boolean } } | undefined;

  const provider: BrowserProvider = {
    async createSession(input) {
      capturedInput = input as typeof capturedInput;
      return newSession;
    },
    async getSession() {
      return newSession;
    },
    async stopSession() {},
    async observe(input): Promise<BrowserObservation> {
      return {
        sessionId: input.sessionId,
        url: "about:blank",
        title: "about:blank",
        tabs: [],
        pageSummary: {},
      };
    },
    async exec() {
      throw new Error("not implemented");
    },
  };

  const handler = createSteelActionHandlers()[0]!;
  await handler.execute(
    state,
    {
      kind: "reconfigure",
      summary: "Enable stealth with bad region",
      payload: { stealth: true, region: "eu-west-1" },
    },
    provider,
  );

  assert.equal(capturedInput?.sessionConfig?.region, undefined);
  assert.equal(capturedInput?.sessionConfig?.stealth, true);
  assert.equal(state.sessionConfig.region, undefined);
});

// ---------------------------------------------------------------------------
// Logger routing (Change 1)
// ---------------------------------------------------------------------------

test("SteelProvider routes CDP WebSocket errors to configured logger", async () => {
  const logEntries: Array<string> = [];
  const logger: SteelLogger = {
    error(message: string) { logEntries.push(message); },
  };

  let consoleErrorCalled = false;
  const origConsoleError = console.error;
  console.error = (..._args: unknown[]) => { consoleErrorCalled = true; };

  try {
    class ErrorSocket {
      onopen: ((e: any) => void) | null = null;
      onmessage: ((e: any) => void) | null = null;
      onerror: ((e: any) => void) | null = null;
      onclose: ((e: any) => void) | null = null;
      constructor() {
        queueMicrotask(() => this.onerror?.({ message: "connection refused" }));
      }
      send() {}
      close() {}
    }

    const provider = new SteelProvider({
      apiKey: "ste-test-key",
      baseUrl: "http://localhost:0/v1",
      webSocketFactory: () => new ErrorSocket() as any,
      logger,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(JSON.stringify(fakeSteelSession()), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    };

    try {
      await assert.rejects(
        () => provider.observe({ sessionId: `session_${fakeSteelSession().id}` as SessionId }),
        /WebSocket error/i,
      );
      assert.ok(logEntries.length > 0, "logger.error should have been called");
      assert.ok(!consoleErrorCalled, "console.error should not have been called from provider");
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    console.error = origConsoleError;
  }
});

test("SteelProvider without logger defaults to silent error handling", async () => {
  let consoleErrorCalled = false;
  const origConsoleError = console.error;
  console.error = () => { consoleErrorCalled = true; };

  try {
    class ErrorSocket {
      onopen = null as any;
      onmessage = null as any;
      onerror = null as any;
      onclose = null as any;
      constructor() {
        queueMicrotask(() => this.onerror?.({ message: "boom" }));
      }
      send() {}
      close() {}
    }

    const provider = new SteelProvider({
      apiKey: "ste-test-key",
      baseUrl: "http://localhost:0/v1",
      webSocketFactory: () => new ErrorSocket() as any,
    });

    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify(fakeSteelSession()), {
      status: 200, headers: { "Content-Type": "application/json" },
    });

    try {
      await assert.rejects(
        () => provider.observe({ sessionId: `session_${fakeSteelSession().id}` as SessionId }),
        /WebSocket error/i,
      );
      assert.ok(!consoleErrorCalled, "console.error should not be called from provider");
    } finally {
      globalThis.fetch = origFetch;
    }
  } finally {
    console.error = origConsoleError;
  }
});
