// ABOUTME: Tests for the resilient LLM fetch transport.
// ABOUTME: Covers request timeout, bounded retry on transient failures, and signal wiring.

import { strict as assert } from "node:assert";
import { test } from "node:test";

import { fetchWithRetry, resolveTransportOptions } from "./transport.js";
import { LLMNetworkError } from "./openai.js";

const noSleep = async () => {};

function okResponse(): Response {
  return new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } });
}

test("fetchWithRetry returns the response on first success", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return okResponse();
  };

  const res = await fetchWithRetry("openai", "https://example.test", {}, {
    timeoutMs: 1000,
    maxRetries: 2,
    sleep: noSleep,
    fetchImpl,
  });

  assert.equal(calls, 1);
  assert.equal(res.status, 200);
});

test("fetchWithRetry retries transient network failures then succeeds", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new Error("fetch failed");
    return okResponse();
  };

  const res = await fetchWithRetry("openai", "https://example.test", {}, {
    timeoutMs: 1000,
    maxRetries: 2,
    sleep: noSleep,
    fetchImpl,
  });

  assert.equal(calls, 3); // 1 initial + 2 retries
  assert.equal(res.status, 200);
});

test("fetchWithRetry throws LLMNetworkError after exhausting retries", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    throw new Error("connection reset");
  };

  await assert.rejects(
    () => fetchWithRetry("anthropic", "https://example.test", {}, {
      timeoutMs: 1000,
      maxRetries: 2,
      sleep: noSleep,
      fetchImpl,
    }),
    (err: unknown) => {
      assert.ok(err instanceof LLMNetworkError);
      assert.equal(err.provider, "anthropic");
      return true;
    },
  );

  assert.equal(calls, 3); // 1 initial + 2 retries, all failed
});

test("fetchWithRetry aborts a hung request after the timeout and surfaces LLMNetworkError", async () => {
  let calls = 0;
  // A fetch that never resolves on its own; only the abort signal can end it.
  const fetchImpl = (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    });

  await assert.rejects(
    () => fetchWithRetry("openai", "https://example.test", {}, {
      timeoutMs: 10,
      maxRetries: 0,
      sleep: noSleep,
      fetchImpl,
    }),
    (err: unknown) => {
      assert.ok(err instanceof LLMNetworkError);
      assert.ok(/timed out/iu.test(err.message), `expected timeout message, got: ${err.message}`);
      return true;
    },
  );

  assert.equal(calls, 1);
});

test("fetchWithRetry does not retry timeouts", async () => {
  // A timed-out request may have completed server-side; re-POSTing it
  // double-bills tokens. Only connection-level failures are retried.
  let calls = 0;
  const fetchImpl = (_url: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      calls += 1;
      init?.signal?.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    });

  await assert.rejects(
    () => fetchWithRetry("openai", "https://example.test", {}, {
      timeoutMs: 10,
      maxRetries: 2,
      sleep: noSleep,
      fetchImpl,
    }),
    (err: unknown) => {
      assert.ok(err instanceof LLMNetworkError);
      assert.ok(/timed out/iu.test(err.message));
      return true;
    },
  );

  assert.equal(calls, 1, "a timeout must not be retried");
});

test("fetchWithRetry reports each retry through onRetry", async () => {
  // MANIFESTO: no hidden retries — every discarded attempt must be observable.
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls < 3) throw new Error("connection reset");
    return okResponse();
  };
  const seen: Array<{ attempt: number; message: string }> = [];

  const res = await fetchWithRetry("openai", "https://example.test", {}, {
    timeoutMs: 1000,
    maxRetries: 2,
    sleep: noSleep,
    fetchImpl,
    onRetry: (info) => seen.push({ attempt: info.attempt, message: info.error.message }),
  });

  assert.equal(res.status, 200);
  assert.deepEqual(seen.map((s) => s.attempt), [1, 2]);
  assert.ok(seen.every((s) => s.message.includes("connection reset")));
});

test("fetchWithRetry passes an AbortSignal through to fetch", async () => {
  let seenSignal: unknown;
  const fetchImpl = async (_url: string | URL | Request, init?: RequestInit) => {
    seenSignal = init?.signal;
    return okResponse();
  };

  await fetchWithRetry("openai", "https://example.test", { method: "POST" }, {
    timeoutMs: 1000,
    maxRetries: 0,
    sleep: noSleep,
    fetchImpl,
  });

  assert.ok(seenSignal instanceof AbortSignal);
});

test("resolveTransportOptions uses defaults when nothing is configured", () => {
  const opts = resolveTransportOptions({}, {});
  assert.equal(opts.timeoutMs, 60_000);
  assert.equal(opts.maxRetries, 2);
});

test("resolveTransportOptions prefers explicit config over env", () => {
  const opts = resolveTransportOptions(
    { timeoutMs: 5000, maxRetries: 5 },
    { WIRE_LLM_TIMEOUT_MS: "1234", WIRE_LLM_MAX_RETRIES: "9" },
  );
  assert.equal(opts.timeoutMs, 5000);
  assert.equal(opts.maxRetries, 5);
});

test("resolveTransportOptions reads env when config is absent", () => {
  const opts = resolveTransportOptions(
    {},
    { WIRE_LLM_TIMEOUT_MS: "1234", WIRE_LLM_MAX_RETRIES: "9" },
  );
  assert.equal(opts.timeoutMs, 1234);
  assert.equal(opts.maxRetries, 9);
});

test("resolveTransportOptions ignores invalid env values", () => {
  const opts = resolveTransportOptions(
    {},
    { WIRE_LLM_TIMEOUT_MS: "not-a-number", WIRE_LLM_MAX_RETRIES: "-1" },
  );
  assert.equal(opts.timeoutMs, 60_000);
  assert.equal(opts.maxRetries, 2);
});
