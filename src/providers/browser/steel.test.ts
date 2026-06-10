import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  createSteelActionHandlers,
  SteelProvider,
  createSteelProvider,
  validateBrowserCode,
  type SteelLogger,
} from "../../providers/browser/steel.js";
import { CdpConnection } from "./steel/cdp.js";
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

test("SteelProvider.getSession retries on 404 then succeeds (post-create propagation race)", async () => {
  const provider = new SteelProvider({
    apiKey: "ste-test-key",
    baseUrl: "http://localhost:0/v1",
    getSessionRetryDelayMs: 0,
  });

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls < 3) {
      return new Response(
        JSON.stringify({ message: "Session not found" }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify(fakeSteelSession()),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const session = await provider.getSession("session_aaa-bbb-ccc" as never);
    assert.equal(session.provider, "steel");
    assert.equal(calls, 3, "should have retried twice before succeeding");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SteelProvider.getSession throws 404 after exhausting retries", async () => {
  const provider = new SteelProvider({
    apiKey: "ste-test-key",
    baseUrl: "http://localhost:0/v1",
    getSessionRetryDelayMs: 0,
  });

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ message: "Session not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => provider.getSession("session_aaa-bbb-ccc" as never),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /404/);
        return true;
      },
    );
    assert.ok(calls >= 3, `expected ≥3 attempts, got ${calls}`);
    assert.ok(calls <= 5, `retry budget should be bounded, got ${calls}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SteelProvider.getSession does not retry on non-404 errors", async () => {
  const provider = new SteelProvider({
    apiKey: "ste-test-key",
    baseUrl: "http://localhost:0/v1",
    getSessionRetryDelayMs: 0,
  });

  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(
      JSON.stringify({ message: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => provider.getSession("session_aaa-bbb-ccc" as never),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /401/);
        return true;
      },
    );
    assert.equal(calls, 1, "401 should fail fast without retry");
  } finally {
    globalThis.fetch = originalFetch;
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

test("SteelProvider.exec surfaces exception class+message+location, not bare 'Uncaught'", async () => {
  // Regression: runs were getting bare `stderr: "Uncaught (in promise)"` with
  // no class, message, or stack frame. The model can't debug from that — it
  // retried near-identical code three times before being aborted. Surface the
  // actual exception details so the next exec can be informed.
  const { provider, setNextResponse, setCdpResponse, restore } = createMockedProvider();
  setNextResponse("/sessions/aaa-bbb-ccc", fakeSteelSession({ id: "aaa-bbb-ccc" }));
  setCdpResponse("Target.getTargets", {
    targetInfos: [{ targetId: "tab-1", type: "page", title: "Example", url: "https://example.com" }],
  });
  setCdpResponse("Target.attachToTarget", { sessionId: "cdp-session-1" });
  setCdpResponse("Runtime.evaluate", {
    exceptionDetails: {
      text: "Uncaught (in promise)",
      lineNumber: 2,
      columnNumber: 14,
      exception: {
        type: "object",
        subtype: "error",
        className: "TypeError",
        description: "TypeError: foo is not a function\n    at <anonymous>:3:5",
      },
    },
  });

  try {
    const result = await provider.exec({
      sessionId: "session_aaa-bbb-ccc" as never,
      code: "return foo();",
    });
    assert.equal(result.ok, false);
    const stderr = result.stderr ?? "";
    assert.match(stderr, /TypeError/, "stderr should include the error class");
    assert.match(stderr, /foo is not a function/, "stderr should include the error message");
    assert.match(stderr, /<anonymous>:3:5|line 2|col(?:umn)? 14/i, "stderr should include a location");
  } finally {
    restore();
  }
});

test("SteelProvider.exec exposes wire.click as trusted CDP mouse input", async () => {
  const sent: Array<Record<string, unknown>> = [];
  class WireClickSocket {
    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    private runtimeEvaluateCount = 0;
    private userEvalId: number | undefined;

    constructor() {
      queueMicrotask(() => this.onopen?.({}));
    }

    send(data: string): void {
      const message = JSON.parse(data) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      sent.push(message as unknown as Record<string, unknown>);

      if (message.method === "Target.getTargets") {
        this.respond(message.id, {
          targetInfos: [{ targetId: "tab-1", type: "page", title: "Example", url: "https://example.com" }],
        });
        return;
      }
      if (message.method === "Target.attachToTarget") {
        this.respond(message.id, { sessionId: "cdp-session-1" });
        return;
      }
      if (message.method === "Runtime.addBinding") {
        this.respond(message.id, {});
        return;
      }
      if (message.method === "Runtime.evaluate") {
        this.runtimeEvaluateCount++;
        if (this.runtimeEvaluateCount === 1) {
          this.respond(message.id, { result: { value: undefined } });
          return;
        }
        if (this.runtimeEvaluateCount === 2) {
          this.userEvalId = message.id;
          queueMicrotask(() => this.onmessage?.({
            data: JSON.stringify({
              method: "Runtime.bindingCalled",
              sessionId: "cdp-session-1",
              params: {
                name: "__wire_action",
                payload: JSON.stringify({
                  id: "1",
                  kind: "click",
                  x: 100,
                  y: 200,
                  target: { tag: "button", text: "Continue", selectorHint: "button" },
                }),
              },
            }),
          }));
          return;
        }
        this.respond(message.id, { result: { value: undefined } });
        queueMicrotask(() => {
          if (this.userEvalId !== undefined) {
            this.respond(this.userEvalId, { result: { value: "clicked" } });
          }
        });
        return;
      }
      if (message.method === "Input.dispatchMouseEvent") {
        this.respond(message.id, {});
        return;
      }
      this.respond(message.id, {});
    }

    close(): void {
      this.onclose?.({});
    }

    private respond(id: number, result: unknown): void {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result }) }));
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
      webSocketFactory: () => new WireClickSocket(),
    });
    const result = await provider.exec({
      sessionId: "session_aaa-bbb-ccc" as never,
      code: "await wire.click('button'); return 'clicked';",
    });

    assert.equal(result.ok, true);
    assert.equal(result.returnValue, "clicked");
    assert.deepEqual(
      sent.filter((message) => message["method"] === "Input.dispatchMouseEvent").map((message) => (message["params"] as Record<string, unknown>)["type"]),
      ["mouseMoved", "mousePressed", "mouseReleased"],
    );
    assert.equal(result.wireEvents?.[0]?.["source"], "wireBinding");
    assert.equal(result.wireEvents?.[0]?.["action"], "click");
    assert.equal((result.wireEvents?.[0]?.["target"] as Record<string, unknown>)["text"], "Continue");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("SteelProvider.exec blocks sensitive wire.click target before CDP input", async () => {
  const sent: Array<Record<string, unknown>> = [];
  class BlockedWireClickSocket {
    onopen: ((event: any) => void) | null = null;
    onmessage: ((event: any) => void) | null = null;
    onerror: ((event: any) => void) | null = null;
    onclose: ((event: any) => void) | null = null;
    private runtimeEvaluateCount = 0;
    private userEvalId: number | undefined;

    constructor() {
      queueMicrotask(() => this.onopen?.({}));
    }

    send(data: string): void {
      const message = JSON.parse(data) as {
        id: number;
        method: string;
        params?: Record<string, unknown>;
        sessionId?: string;
      };
      sent.push(message as unknown as Record<string, unknown>);

      if (message.method === "Target.getTargets") {
        this.respond(message.id, {
          targetInfos: [{ targetId: "tab-1", type: "page", title: "Example", url: "https://example.com" }],
        });
        return;
      }
      if (message.method === "Target.attachToTarget") {
        this.respond(message.id, { sessionId: "cdp-session-1" });
        return;
      }
      if (message.method === "Runtime.addBinding" || message.method === "Runtime.removeBinding") {
        this.respond(message.id, {});
        return;
      }
      if (message.method === "Runtime.evaluate") {
        this.runtimeEvaluateCount++;
        if (this.runtimeEvaluateCount === 1) {
          this.respond(message.id, { result: { value: undefined } });
          return;
        }
        if (this.runtimeEvaluateCount === 2) {
          this.userEvalId = message.id;
          queueMicrotask(() => this.onmessage?.({
            data: JSON.stringify({
              method: "Runtime.bindingCalled",
              sessionId: "cdp-session-1",
              params: {
                name: "__wire_action",
                payload: JSON.stringify({
                  id: "1",
                  kind: "click",
                  x: 100,
                  y: 200,
                  target: { tag: "button", text: "Delete account", selectorHint: "#delete" },
                }),
              },
            }),
          }));
          return;
        }
        this.respond(message.id, { result: { value: undefined } });
        queueMicrotask(() => {
          if (this.userEvalId !== undefined) {
            this.onmessage?.({
              data: JSON.stringify({
                id: this.userEvalId,
                result: {
                  exceptionDetails: {
                    text: "Uncaught (in promise)",
                    exception: { description: "Error: wire.click deny: destructive click target" },
                  },
                },
              }),
            });
          }
        });
        return;
      }
      this.respond(message.id, {});
    }

    close(): void {
      this.onclose?.({});
    }

    private respond(id: number, result: unknown): void {
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id, result }) }));
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
      webSocketFactory: () => new BlockedWireClickSocket(),
    });
    const result = await provider.exec({
      sessionId: "session_aaa-bbb-ccc" as never,
      code: "await wire.click('#delete'); return 'clicked';",
    });

    assert.equal(result.ok, false);
    assert.match(result.stderr ?? "", /wire\.click deny/u);
    assert.equal(sent.some((message) => message["method"] === "Input.dispatchMouseEvent"), false);
    assert.equal(result.wireEvents?.[0]?.["ok"], false);
    assert.equal(result.wireEvents?.[0]?.["error"], "wire.click deny: destructive click target");
  } finally {
    globalThis.fetch = originalFetch;
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

test("createSteelProvider uses STEEL_BASE_URL env var when set", async () => {
  const originalKey = process.env.STEEL_API_KEY;
  const originalBase = process.env.STEEL_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.STEEL_API_KEY = "ste-from-env";
  process.env.STEEL_BASE_URL = "https://steel-api-preview.example.dev/v1";

  let observedUrl = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    observedUrl = String(url);
    return new Response(JSON.stringify(fakeSteelSession()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const provider = createSteelProvider();
    await provider.createSession({});
    assert.equal(
      observedUrl,
      "https://steel-api-preview.example.dev/v1/sessions",
      "createSession should hit the URL derived from STEEL_BASE_URL",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey) process.env.STEEL_API_KEY = originalKey;
    else delete process.env.STEEL_API_KEY;
    if (originalBase) process.env.STEEL_BASE_URL = originalBase;
    else delete process.env.STEEL_BASE_URL;
  }
});

test("createSteelProvider prefers explicit baseUrl over STEEL_BASE_URL env var", async () => {
  const originalKey = process.env.STEEL_API_KEY;
  const originalBase = process.env.STEEL_BASE_URL;
  const originalFetch = globalThis.fetch;
  process.env.STEEL_API_KEY = "ste-from-env";
  process.env.STEEL_BASE_URL = "https://from-env.example.dev/v1";

  let observedUrl = "";
  globalThis.fetch = (async (url: string | URL | Request) => {
    observedUrl = String(url);
    return new Response(JSON.stringify(fakeSteelSession()), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  try {
    const provider = createSteelProvider({ baseUrl: "https://from-config.example.dev/v1" });
    await provider.createSession({});
    assert.equal(
      observedUrl,
      "https://from-config.example.dev/v1/sessions",
      "explicit config baseUrl should win over STEEL_BASE_URL env var",
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (originalKey) process.env.STEEL_API_KEY = originalKey;
    else delete process.env.STEEL_API_KEY;
    if (originalBase) process.env.STEEL_BASE_URL = originalBase;
    else delete process.env.STEEL_BASE_URL;
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

test("CDP send rejects when the websocket handshake never completes", async () => {
  // A socket stuck in CONNECTING must not hang observe/exec forever.
  const stuckSocket = {
    onopen: null,
    onmessage: null,
    onerror: null,
    onclose: null,
    send() {},
    close() {},
  };
  const cdp = new CdpConnection(stuckSocket as never, 50);

  await assert.rejects(
    () => cdp.send("Target.getTargets"),
    /connect timed out/iu,
  );
});

test("Steel reconfigure redacts proxy credentials in the thought-summary event", async () => {
  const oldSessionId = createId("session");
  const newSession: BrowserSession = {
    id: createId("session"),
    provider: "steel",
    createdAt: new Date().toISOString(),
    status: "ready",
  };
  const state = createLoopState(makeTask(), oldSessionId);

  const provider: BrowserProvider = {
    async createSession() {
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
      summary: "Route through authenticated proxy",
      payload: {
        useProxy: { server: "http://alice:hunter2pass@proxy.example.com:8080" },
      },
    },
    provider,
    {},
  );

  const thought = state.events.find((e) => e.kind === "thought-summary");
  assert.ok(thought);
  const serialized = JSON.stringify(thought!.payload);
  assert.ok(!serialized.includes("hunter2pass"), "proxy password must not reach the trace");
  assert.ok(serialized.includes("[REDACTED]"));
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
