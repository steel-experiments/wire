// ABOUTME: Resilient fetch transport shared by LLM providers.
// ABOUTME: Adds a per-request timeout and a bounded retry on transient network failures.

import { LLMNetworkError } from "./openai.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;

type FetchImpl = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface TransportConfig {
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
}

export interface TransportOptions {
  timeoutMs: number;
  maxRetries: number;
  // Injectable so tests can avoid real backoff delays.
  sleep?: (ms: number) => Promise<void>;
  // Injectable so tests can drive fetch behavior; defaults to globalThis.fetch.
  fetchImpl?: FetchImpl;
}

function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return undefined;
  return n;
}

/**
 * Resolve timeout/retry settings from explicit config, falling back to env, then
 * to built-in defaults. Explicit config always wins so callers can override the
 * environment. Invalid env values are ignored rather than throwing.
 */
export function resolveTransportOptions(
  config: TransportConfig,
  env: Record<string, string | undefined>,
): TransportOptions {
  const envTimeout = parsePositiveInt(env.WIRE_LLM_TIMEOUT_MS);
  const envRetries = parsePositiveInt(env.WIRE_LLM_MAX_RETRIES);
  return {
    timeoutMs: config.timeoutMs ?? envTimeout ?? DEFAULT_TIMEOUT_MS,
    maxRetries: config.maxRetries ?? envRetries ?? DEFAULT_MAX_RETRIES,
  };
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/**
 * POST to an LLM endpoint with a hard timeout and a bounded retry on transient
 * network failures (connection errors and timeouts). Non-2xx responses are NOT
 * retried here — the caller inspects `response.ok` and raises LLMApiError — so
 * we never silently retry rate limits or server errors. Each attempt gets a
 * fresh AbortController; exhausting the budget throws LLMNetworkError.
 */
export async function fetchWithRetry(
  provider: string,
  url: string,
  init: RequestInit,
  opts: TransportOptions,
): Promise<Response> {
  const sleep = opts.sleep ?? defaultSleep;
  const doFetch = opts.fetchImpl ?? fetch;
  let lastError: Error = new Error("no attempts made");

  for (let attempt = 0; attempt <= opts.maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      lastError = isAbortError(err)
        ? new Error(`request timed out after ${opts.timeoutMs}ms`)
        : (err as Error);
    } finally {
      clearTimeout(timer);
    }

    if (attempt < opts.maxRetries) {
      await sleep(BACKOFF_BASE_MS * 2 ** attempt);
    }
  }

  throw new LLMNetworkError(provider, lastError);
}
