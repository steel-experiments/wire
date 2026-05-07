import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  BrowserRawRequest,
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  SessionConfig,
  SessionId,
  SessionStatus,
} from "../../shared/types.js";
import { createId, nowIsoUtc } from "../../shared/ids.js";
import type { BrowserObserveInput, BrowserProvider } from "../../browser/bridge.js";
import type { ActionHandler } from "../../agent/actions.js";

export interface SteelProviderConfig {
  apiKey: string;
  baseUrl?: string;
  webSocketFactory?: (url: string) => WebSocketLike;
  cdpCommandTimeoutMs?: number;
  onRetry?: (event: SteelRetryEvent) => void | Promise<void>;
  logger?: SteelLogger;
}

export interface SteelRetryEvent {
  operation: "createSession";
  attempt: number;
  maxRetries: number;
  delayMs: number;
  status: number;
  message: string;
}

export interface SteelLogger {
  error?(message: string, context?: Record<string, unknown>): void;
  warn?(message: string, context?: Record<string, unknown>): void;
}

const DEFAULT_BASE_URL = "https://api.steel.dev/v1";
const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 30_000;
const RAW_RUNTIME_EVALUATE_TIMEOUT_MS = 12_000;
const STEEL_REGION_CODES = new Set(["lax", "iad"]);

interface SteelSessionResponse {
  id: string;
  status: string;
  websocketUrl: string;
  sessionViewerUrl: string;
  debugUrl?: string;
  createdAt: string;
  expiresAt?: string;
  profileId?: string;
  region?: string;
  proxy?: string | boolean | Record<string, unknown>;
}

interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

interface WebSocketLike {
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  send(data: string): void;
  close(): void;
}

function mapStatus(steelStatus: string): SessionStatus {
  switch (steelStatus) {
    case "live":
    case "active":
      return "ready";
    case "created":
    case "queued":
    case "launching":
      return "starting";
    case "released":
    case "closed":
      return "stopped";
    case "timeout":
    case "timed_out":
    case "error":
    case "failed":
      return "failed";
    default:
      return "starting";
  }
}

function toBrowserSession(steel: SteelSessionResponse, region?: string): BrowserSession {
  const session: BrowserSession = {
    id: `session_${steel.id}` as SessionId,
    provider: "steel",
    liveUrl: steel.sessionViewerUrl,
    wsUrl: steel.websocketUrl,
    createdAt: steel.createdAt ?? nowIsoUtc(),
    status: mapStatus(steel.status),
  };

  if (steel.debugUrl) {
    session.debugUrl = steel.debugUrl;
  }

  if (steel.profileId) {
    session.profileId = `profile_${steel.profileId}` as never;
  }

  if (region) {
    session.region = region;
  }

  return session;
}

class SteelApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Steel API error (${status}): ${message}`);
    this.name = "SteelApiError";
  }
}

async function steelFetch<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${baseUrl}${path}`;
  const headers: Record<string, string> = {
    "steel-api-key": apiKey,
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };

  let response: Response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (err) {
    throw new SteelApiError(0, `Network error: ${(err as Error).message}`);
  }

  if (!response.ok) {
    let detail: string;
    try {
      const body = (await response.json()) as { message?: string; error?: string };
      detail = body.message ?? body.error ?? response.statusText;
    } catch {
      detail = response.statusText;
    }
    throw new SteelApiError(response.status, detail);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

interface SteelCreateSessionBody {
  persistProfile?: boolean;
  profileId?: string;
  region?: string;
  useProxy?: boolean | Record<string, unknown>;
  solveCaptcha?: boolean;
  stealth?: boolean;
  userAgent?: string;
  locale?: string;
  timezone?: string;
  viewport?: { width: number; height: number };
  timeout?: number;
  [key: string]: unknown;
}

function buildCreateSessionBody(input: CreateSessionInput): SteelCreateSessionBody {
  const body: SteelCreateSessionBody = {};

  if (input.profileId) {
    body.profileId = input.profileId.replace(/^profile_/u, "");
    body.persistProfile = true;
  }

  const inputRegion = normalizeSteelRegion(input.region);
  if (inputRegion) {
    body.region = inputRegion;
  }

  // sessionConfig takes precedence over legacy proxyCountryCode
  if (input.sessionConfig) {
    const cfg = input.sessionConfig;
    if (cfg.useProxy !== undefined) {
      body.useProxy = cfg.useProxy as boolean | Record<string, unknown>;
    }
    if (cfg.solveCaptcha !== undefined) {
      body.solveCaptcha = cfg.solveCaptcha;
    }
    if (cfg.stealth !== undefined) {
      body.stealth = cfg.stealth;
    }
    if (typeof cfg.userAgent === "string") {
      body.userAgent = cfg.userAgent;
    }
    const configRegion = normalizeSteelRegion(cfg.region);
    if (configRegion) {
      body.region = configRegion;
    }
    if (typeof cfg.locale === "string") {
      body.locale = cfg.locale;
    }
    if (typeof cfg.timezone === "string") {
      body.timezone = cfg.timezone;
    }
    if (cfg.viewport) {
      body.viewport = cfg.viewport;
    }
    if (cfg.providerOptions) {
      Object.assign(body, cfg.providerOptions);
    }
  } else if (input.proxyCountryCode) {
    body.useProxy = {
      geolocation: { country: input.proxyCountryCode },
    };
  }

  if (input.timeoutMinutes) {
    body.timeout = input.timeoutMinutes * 60_000;
  }

  if (input.metadata) {
    Object.assign(body, input.metadata);
  }

  return body;
}

function normalizeSteelRegion(region: unknown): string | undefined {
  if (typeof region !== "string") return undefined;
  const normalized = region.trim().toLowerCase();
  return STEEL_REGION_CODES.has(normalized) ? normalized : undefined;
}

function sanitizedSessionConfig(config: SessionConfig): SessionConfig {
  const sanitized: SessionConfig = { ...config };
  const region = normalizeSteelRegion(sanitized.region);
  if (region) {
    sanitized.region = region;
  } else {
    delete sanitized.region;
  }
  return sanitized;
}

function extractSteelId(sessionId: SessionId): string {
  return sessionId.replace(/^session_/u, "");
}

export class SteelProvider implements BrowserProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly cdpCommandTimeoutMs: number;
  private readonly onRetry: ((event: SteelRetryEvent) => void | Promise<void>) | undefined;
  private readonly logger: SteelLogger | undefined;

  constructor(config: SteelProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.webSocketFactory = config.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.cdpCommandTimeoutMs = config.cdpCommandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS;
    this.onRetry = config.onRetry;
    this.logger = config.logger;
  }

  async createSession(input: CreateSessionInput = {}): Promise<BrowserSession> {
    const body = buildCreateSessionBody(input);
    const maxRetries = 3;
    let lastError: unknown;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const steel = await steelFetch<SteelSessionResponse>(
          this.baseUrl,
          this.apiKey,
          "/sessions",
          { method: "POST", body: JSON.stringify(body) },
        );
        return toBrowserSession(steel, body.region);
      } catch (err) {
        lastError = err;
        const status = err instanceof SteelApiError ? err.status : 0;
        // Only retry on transient errors: 500+ or network failures (status 0)
        if (status !== 0 && status < 500) {
          throw err;
        }
        if (attempt < maxRetries) {
          const delay = 500 * Math.pow(2, attempt);
          await this.onRetry?.({
            operation: "createSession",
            attempt: attempt + 1,
            maxRetries,
            delayMs: delay,
            status,
            message: err instanceof Error ? err.message : String(err),
          });
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError;
  }

  async getSession(sessionId: SessionId): Promise<BrowserSession> {
    const steelId = extractSteelId(sessionId);
    const steel = await steelFetch<SteelSessionResponse>(
      this.baseUrl,
      this.apiKey,
      `/sessions/${steelId}`,
    );

    return toBrowserSession(steel);
  }

  async stopSession(sessionId: SessionId): Promise<void> {
    const steelId = extractSteelId(sessionId);
    await steelFetch<void>(
      this.baseUrl,
      this.apiKey,
      `/sessions/${steelId}/release`,
      { method: "POST" },
    );
  }

  private withAuth(session: BrowserSession): BrowserSession {
    if (!session.wsUrl) return session;
    const url = new URL(session.wsUrl);
    url.searchParams.set("apiKey", this.apiKey);
    return { ...session, wsUrl: url.toString() };
  }

  async observe(input: BrowserObserveInput): Promise<BrowserObservation> {
    const session = this.withAuth(await this.getSession(input.sessionId));

    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const targets = await listPageTargets(cdp);
      const target = pickTarget(targets, input.targetId);
      const sessionId = await attachToTarget(cdp, target.targetId);
      const snapshot = await evaluateJson<Record<string, unknown>>(cdp, sessionId, OBSERVE_SCRIPT);

      // Capture screenshot via CDP for multimodal LLM context
      let screenshotBase64: string | undefined;
      try {
        const screenshotResult = await cdp.send<{ data?: string }>(
          "Page.captureScreenshot",
          { format: "jpeg", quality: 50 },
          sessionId,
        );
        screenshotBase64 = screenshotResult.data;
      } catch {
        // Screenshot is best-effort; don't block observation if it fails
      }

      const observation: BrowserObservation = {
        sessionId: input.sessionId,
        targetId: target.targetId,
        url: asString(snapshot.url, target.url),
        title: asString(snapshot.title, target.title),
        tabs: targets.map((item) => ({
          id: item.targetId,
          title: item.title,
          url: item.url,
          active: item.targetId === target.targetId,
        })),
      };

      if (screenshotBase64) {
        observation.screenshotBase64 = screenshotBase64;
      }

      const focusedElement = asRecord(snapshot.focusedElement);
      if (focusedElement) {
        observation.focusedElement = focusedElement as NonNullable<BrowserObservation["focusedElement"]>;
      }
      const pageSummary = asRecord(snapshot.pageSummary);
      if (pageSummary) {
        observation.pageSummary = pageSummary as NonNullable<BrowserObservation["pageSummary"]>;
      }

      return observation;
    });
  }

  async exec(input: BrowserExecRequest): Promise<BrowserExecResult> {
    const session = this.withAuth(await this.getSession(input.sessionId));

    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const startedAt = Date.now();
      const targets = await listPageTargets(cdp);
      const selected = pickExecTargets(targets, input.target);
      const stdout: string[] = [];
      const stderr: string[] = [];
      let ok = true;
      let returnValue: unknown;

      for (const target of selected) {
        try {
          validateBrowserCode(input.code);
          const sessionId = await attachToTarget(cdp, target.targetId);
          const value = await evaluateJson<unknown>(cdp, sessionId, wrapUserCode(input.code), input.timeoutMs);
          returnValue = value;
          if (value !== undefined) {
            stdout.push(typeof value === "string" ? value : JSON.stringify(value));
          }
        } catch (err) {
          ok = false;
          stderr.push(err instanceof Error ? err.message : String(err));
        }
      }

      const result: BrowserExecResult = {
        ok,
        durationMs: Date.now() - startedAt,
      };
      if (stdout.length > 0) {
        result.stdout = stdout.join("\n");
      }
      if (stderr.length > 0) {
        result.stderr = stderr.join("\n");
      }
      if (returnValue !== undefined) {
        result.returnValue = returnValue as NonNullable<BrowserExecResult["returnValue"]>;
      }
      return result;
    });
  }

  async raw(input: BrowserRawRequest): Promise<unknown> {
    const session = this.withAuth(await this.getSession(input.sessionId));
    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const needsTargetSession = cdpMethodNeedsTargetSession(input.method);
      if (needsTargetSession) {
        const targets = await listPageTargets(cdp);
        const target = pickTarget(targets);
        const targetSessionId = await attachToTarget(cdp, target.targetId);
        const raw = capRawRuntimeEvaluate(input.method, input.params);
        return cdp.send(input.method, raw.params, targetSessionId, raw.timeoutMs);
      }
      const raw = capRawRuntimeEvaluate(input.method, input.params);
      return cdp.send(input.method, raw.params, undefined, raw.timeoutMs);
    });
  }

  /**
   * Send multiple CDP commands over a single connection.
   * Reuses one WebSocket and target session attachment for all commands.
   * Returns the result of the last command, or throws on the first failure.
   */
  async rawBatch(
    sessionId: SessionId,
    commands: Array<{ method: string; params?: Record<string, unknown> }>,
  ): Promise<unknown> {
    const session = this.withAuth(await this.getSession(sessionId));
    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const needsTarget = commands.some((c) => cdpMethodNeedsTargetSession(c.method));
      let targetSessionId: string | undefined;
      if (needsTarget) {
        const targets = await listPageTargets(cdp);
        const target = pickTarget(targets);
        targetSessionId = await attachToTarget(cdp, target.targetId);
      }

      let lastResult: unknown;
      for (const cmd of commands) {
        const sid = cdpMethodNeedsTargetSession(cmd.method) ? targetSessionId : undefined;
        const raw = capRawRuntimeEvaluate(cmd.method, cmd.params);
        lastResult = await cdp.send(cmd.method, raw.params, sid, raw.timeoutMs);
      }
      return lastResult;
    });
  }
}

function cdpMethodNeedsTargetSession(method: string): boolean {
  return /^(DOM|Input|Page|Runtime)\./u.test(method);
}

function capRawRuntimeEvaluate(method: string, params?: Record<string, unknown>): { params?: Record<string, unknown>; timeoutMs?: number } {
  if (method !== "Runtime.evaluate") return params ? { params } : {};
  const requested = typeof params?.timeout === "number" && Number.isFinite(params.timeout)
    ? Math.floor(params.timeout)
    : RAW_RUNTIME_EVALUATE_TIMEOUT_MS;
  const timeout = Math.min(RAW_RUNTIME_EVALUATE_TIMEOUT_MS, Math.max(1, requested));
  return { params: { ...params, timeout }, timeoutMs: timeout };
}

const OBSERVE_SCRIPT = `(() => {
  // Orientation-only: where am I, what's on the page, what can I interact with.
  // Content extraction is the agent's job via exec — not the observer's.
  const headings = [];
  for (const h of document.querySelectorAll("h1,h2,h3")) {
    const t = (h.textContent ?? "").trim();
    if (t && headings.length < 5) headings.push(t.slice(0, 120));
  }
  const active = document.activeElement;
  return {
    url: window.location.href,
    title: document.title,
    focusedElement: active ? {
      tag: active.tagName?.toLowerCase?.(),
      role: active.getAttribute?.("role") ?? undefined,
      label: active.getAttribute?.("aria-label") ?? undefined,
      selectorHint: active.id ? "#" + active.id : undefined,
    } : undefined,
    pageSummary: {
      headings,
      forms: document.forms.length,
      buttons: document.querySelectorAll("button, input[type=button], input[type=submit]").length,
      dialogs: document.querySelectorAll("dialog, [role=\\"dialog\\"]").length,
      tables: document.querySelectorAll("table").length,
      links: document.querySelectorAll("a[href]").length,
      inputs: document.querySelectorAll("input,textarea,select").length,
    },
  };
})()`;

function wrapUserCode(code: string): string {
  return `(async () => { ${code} })()`;
}

// ---------------------------------------------------------------------------
// Code validation — reject dangerous patterns before browser execution
// ---------------------------------------------------------------------------

type CodeToken =
  | { kind: "identifier"; value: string }
  | { kind: "string"; value: string }
  | { kind: "punct"; value: string };

const BLOCKED_GLOBAL_IDENTIFIERS = new Set([
  "eval",
  "Function",
  "importScripts",
]);

const BLOCKED_MEMBER_PROPERTIES = new Map([
  ["navigator", new Set(["sendBeacon"])],
  ["document", new Set(["cookie"])],
  ["window", new Set(["eval", "Function", "importScripts"])],
  ["globalThis", new Set(["eval", "Function", "importScripts"])],
]);

function tokenizeCode(code: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  let i = 0;

  while (i < code.length) {
    const ch = code[i]!;
    const next = code[i + 1];

    if (/\s/u.test(ch)) {
      i++;
      continue;
    }

    if (ch === "/" && next === "/") {
      i += 2;
      while (i < code.length && code[i] !== "\n") i++;
      continue;
    }

    if (ch === "/" && next === "*") {
      i += 2;
      while (i + 1 < code.length && !(code[i] === "*" && code[i + 1] === "/")) i++;
      i = Math.min(code.length, i + 2);
      continue;
    }

    if (ch === "\"" || ch === "'" || ch === "`") {
      const quote = ch;
      let value = "";
      i++;
      while (i < code.length) {
        const current = code[i]!;
        if (current === "\\") {
          i += 2;
          continue;
        }
        if (current === quote) {
          i++;
          break;
        }
        value += current;
        i++;
      }
      tokens.push({ kind: "string", value });
      continue;
    }

    if (/[A-Za-z_$]/u.test(ch)) {
      let value = ch;
      i++;
      while (i < code.length && /[A-Za-z0-9_$]/u.test(code[i]!)) {
        value += code[i]!;
        i++;
      }
      tokens.push({ kind: "identifier", value });
      continue;
    }

    tokens.push({ kind: "punct", value: ch });
    i++;
  }

  return tokens;
}

function staticStringExpression(tokens: CodeToken[], start: number, end: number): string | undefined {
  let value = "";
  let expectString = true;

  for (let i = start; i < end; i++) {
    const token = tokens[i]!;
    if (expectString) {
      if (token.kind !== "string") {
        return undefined;
      }
      value += token.value;
      expectString = false;
      continue;
    }

    if (token.kind !== "punct" || token.value !== "+") {
      return undefined;
    }
    expectString = true;
  }

  return expectString ? undefined : value;
}

function isCallLike(tokens: CodeToken[], index: number): boolean {
  const next = tokens[index + 1];
  if (next?.kind === "punct" && next.value === "(") {
    return true;
  }

  const previous = tokens[index - 1];
  return previous?.kind === "identifier" && previous.value === "new";
}

function memberAccessStart(tokens: CodeToken[], index: number): number | undefined {
  const next = tokens[index + 1];
  if (next?.kind === "punct" && next.value === ".") {
    return index + 2;
  }
  if (next?.kind === "punct" && next.value === "[") {
    return index + 1;
  }
  if (next?.kind === "punct" && next.value === "?" && tokens[index + 2]?.kind === "punct") {
    const afterQuestion = tokens[index + 2]!;
    if (afterQuestion.value === ".") {
      return index + 3;
    }
    if (afterQuestion.value === "[") {
      return index + 2;
    }
  }
  return undefined;
}

export function validateBrowserCode(code: string): void {
  const found: string[] = [];
  const tokens = tokenizeCode(code);

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== "identifier") {
      continue;
    }

    const previous = tokens[i - 1];
    const isProperty = previous?.kind === "punct" && previous.value === ".";
    if (!isProperty && BLOCKED_GLOBAL_IDENTIFIERS.has(token.value) && isCallLike(tokens, i)) {
      found.push(token.value);
      continue;
    }

    const blockedProperties = BLOCKED_MEMBER_PROPERTIES.get(token.value);
    if (!blockedProperties) {
      continue;
    }

    const accessStart = memberAccessStart(tokens, i);
    if (accessStart === undefined) {
      continue;
    }

    const property = tokens[accessStart];
    if (property?.kind === "identifier" && blockedProperties.has(property.value)) {
      found.push(`${token.value}.${property.value}`);
      continue;
    }

    const open = tokens[accessStart];
    if (open?.kind !== "punct" || open.value !== "[") {
      continue;
    }
    let closeIndex = accessStart + 1;
    while (closeIndex < tokens.length) {
      const close = tokens[closeIndex]!;
      if (close.kind === "punct" && close.value === "]") {
        break;
      }
      closeIndex++;
    }
    if (closeIndex >= tokens.length) {
      continue;
    }
    const computed = staticStringExpression(tokens, accessStart + 1, closeIndex);
    if (computed && blockedProperties.has(computed)) {
      found.push(`${token.value}[${computed}]`);
    }
  }

  if (found.length > 0) {
    throw new Error(`Browser code contains blocked patterns: ${found.join(", ")}`);
  }
}

class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly ready: Promise<void>;

  constructor(
    private readonly socket: WebSocketLike,
    private readonly commandTimeoutMs: number,
    private readonly logger?: SteelLogger,
  ) {
    this.ready = new Promise((resolve, reject) => {
      this.socket.onopen = () => resolve();
      this.socket.onerror = (event) => {
        const parts: string[] = [];
        if (event && typeof event === "object") {
          if (event.message) parts.push(`message=${event.message}`);
          if (event.error?.message) parts.push(`error=${event.error.message}`);
          if (event.code) parts.push(`code=${event.code}`);
        }
        const detail = parts.length > 0 ? parts.join(" ") : "no detail (likely session expired)";
        const message = `Steel CDP WebSocket error: ${detail}`;
        const error = new Error(message);
        this.logger?.error?.(`steel:ws ${message}`);
        this.rejectPending(error);
        reject(error);
      };
      this.socket.onclose = (event) => {
        const code = event?.code;
        const reason = event?.reason;
        const wasClean = event?.wasClean;
        const detail = [
          code !== undefined ? `code=${code}` : "",
          reason ? `reason=${reason}` : "",
          wasClean !== undefined ? `wasClean=${wasClean}` : "",
        ].filter(Boolean).join(" ");
        const message = `Steel CDP socket closed${detail ? ` (${detail})` : ""}`;
        if (this.pending.size > 0) {
          this.logger?.error?.(`steel:ws ${message} — ${this.pending.size} pending command(s) aborted`);
        }
        this.rejectPending(new Error(message));
      };
      this.socket.onmessage = (event) => {
        let message: {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        try {
          message = JSON.parse(String(event.data)) as typeof message;
        } catch (err) {
          this.rejectPending(new Error(`Invalid CDP message: ${err instanceof Error ? err.message : String(err)}`));
          return;
        }
        if (message.id === undefined) {
          return;
        }
        const entry = this.pending.get(message.id);
        if (!entry) {
          return;
        }
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) {
          entry.reject(new Error(message.error.message ?? "CDP error"));
          return;
        }
        entry.resolve(message.result);
      };
    });
  }

  async send<T>(method: string, params?: Record<string, unknown>, sessionId?: string, timeoutMs?: number): Promise<T> {
    await this.ready;
    const id = this.nextId++;
    const effectiveTimeoutMs = timeoutMs
      ? Math.min(this.commandTimeoutMs, Math.max(1, timeoutMs))
      : this.commandTimeoutMs;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timed out after ${effectiveTimeoutMs}ms: ${method}`));
      }, effectiveTimeoutMs);
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
      const message: Record<string, unknown> = { id, method };
      if (params) {
        message.params = params;
      }
      if (sessionId) {
        message.sessionId = sessionId;
      }
      try {
        this.socket.send(JSON.stringify(message));
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err);
      }
    });
  }

  close(): void {
    this.socket.close();
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

async function withConnection<T>(
  webSocketFactory: (url: string) => WebSocketLike,
  session: BrowserSession,
  commandTimeoutMs: number,
  logger: SteelLogger | undefined,
  run: (cdp: CdpConnection) => Promise<T>,
): Promise<T> {
  if (!session.wsUrl) {
    throw new Error("Steel session missing wsUrl");
  }

  const cdp = new CdpConnection(webSocketFactory(session.wsUrl), commandTimeoutMs, logger);
  try {
    return await run(cdp);
  } finally {
    cdp.close();
  }
}

async function listPageTargets(cdp: CdpConnection): Promise<TargetInfo[]> {
  const response = await cdp.send<{ targetInfos?: TargetInfo[] }>("Target.getTargets");
  return (response.targetInfos ?? []).filter((target) => target.type === "page");
}

function pickTarget(targets: TargetInfo[], targetId?: string): TargetInfo {
  if (targets.length === 0) {
    throw new Error("No page targets available");
  }

  if (targetId) {
    const exact = targets.find((target) => target.targetId === targetId);
    if (!exact) {
      throw new Error(`Target not found: ${targetId}`);
    }
    return exact;
  }

  return targets[0]!;
}

function pickExecTargets(
  targets: TargetInfo[],
  target: BrowserExecRequest["target"],
): TargetInfo[] {
  if (target === "all-tabs") {
    return targets;
  }

  if (typeof target === "object" && target !== null && "tabId" in target) {
    return [pickTarget(targets, target.tabId)];
  }

  return [pickTarget(targets)];
}

async function attachToTarget(cdp: CdpConnection, targetId: string): Promise<string> {
  const response = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return response.sessionId;
}

async function evaluateJson<T>(
  cdp: CdpConnection,
  sessionId: string,
  expression: string,
  timeoutMs?: number,
): Promise<T> {
  const response = await cdp.send<{
    result?: { value?: T; description?: string };
    exceptionDetails?: {
      text?: string;
      lineNumber?: number;
      columnNumber?: number;
      exception?: { className?: string; description?: string };
    };
  }>(
    "Runtime.evaluate",
    {
      expression,
      awaitPromise: true,
      returnByValue: true,
      timeout: timeoutMs,
    },
    sessionId,
    timeoutMs,
  );

  if (response.exceptionDetails) {
    throw new Error(formatExceptionDetails(response.exceptionDetails, response.result?.description));
  }

  return response.result?.value as T;
}

/**
 * Build a human- and model-readable error message from CDP `exceptionDetails`.
 * `text` alone is usually just "Uncaught (in promise)" — useless for debugging.
 * The actual class/message/stack lives under `exception.description`. Surface
 * line/column when present so the model can see *where* in its own code it
 * blew up.
 */
function formatExceptionDetails(
  details: {
    text?: string;
    lineNumber?: number;
    columnNumber?: number;
    exception?: { className?: string; description?: string };
  },
  fallback?: string,
): string {
  const description = details.exception?.description?.trim();
  if (description && description.length > 0) {
    const loc = details.lineNumber !== undefined
      ? ` (line ${details.lineNumber + 1}${details.columnNumber !== undefined ? `, col ${details.columnNumber + 1}` : ""})`
      : "";
    // `description` typically already contains class+message+stack; only
    // append a location if the description didn't already include a frame.
    const hasFrame = /\bat\s+/.test(description);
    return hasFrame ? description : `${description}${loc}`;
  }
  return details.text ?? fallback ?? "Runtime evaluation failed";
}

function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

export function createSteelProvider(
  config?: Partial<SteelProviderConfig>,
): SteelProvider {
  const apiKey = config?.apiKey ?? process.env.STEEL_API_KEY ?? "";
  if (!apiKey) {
    throw new Error("STEEL_API_KEY is required. Set the environment variable or pass apiKey in config.");
  }

  const providerConfig: SteelProviderConfig = { apiKey };
  if (config?.baseUrl) {
    providerConfig.baseUrl = config.baseUrl;
  }
  if (config?.webSocketFactory) {
    providerConfig.webSocketFactory = config.webSocketFactory;
  }
  if (config?.cdpCommandTimeoutMs) {
    providerConfig.cdpCommandTimeoutMs = config.cdpCommandTimeoutMs;
  }
  if (config?.onRetry) {
    providerConfig.onRetry = config.onRetry;
  }

  return new SteelProvider(providerConfig);
}

// ---------------------------------------------------------------------------
// Steel action handlers — provider-specific actions for the action registry
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProxyConfig(value: unknown): SessionConfig["useProxy"] | undefined {
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) return undefined;

  const proxy: Exclude<SessionConfig["useProxy"], boolean | undefined> = {};
  if (isRecord(value["geolocation"]) && typeof value["geolocation"]["country"] === "string") {
    proxy.geolocation = { country: value["geolocation"]["country"] };
  }
  if (typeof value["server"] === "string") {
    proxy.server = value["server"];
  }
  return proxy.geolocation || proxy.server ? proxy : undefined;
}

export function createSteelActionHandlers(): ActionHandler[] {
  return [{
    kind: "reconfigure",
    description: 'For "reconfigure", set payload fields: useProxy (bool or approved proxy object), solveCaptcha (bool), stealth (bool), userAgent (string), region ("lax" or "iad" only), locale (string), timezone (string), viewport ({width,height}). Creates a new browser session with updated settings. Use when blocked by captcha, IP block, or anti-bot detection. Do not invent region names.',
    async execute(state, action, provider, context) {
      const requested = action.payload as JsonObject | undefined;
      const merged: SessionConfig = sanitizedSessionConfig(state.sessionConfig ?? {});

      if (requested?.useProxy !== undefined) {
        const useProxy = readProxyConfig(requested.useProxy);
        if (useProxy !== undefined) merged.useProxy = useProxy;
      }
      if (requested?.solveCaptcha !== undefined) {
        merged.solveCaptcha = Boolean(requested.solveCaptcha);
      }
      if (requested?.stealth !== undefined) {
        merged.stealth = Boolean(requested.stealth);
      }
      if (typeof requested?.userAgent === "string") {
        merged.userAgent = requested.userAgent;
      }
      if (typeof requested?.region === "string") {
        const region = normalizeSteelRegion(requested.region);
        if (region) {
          merged.region = region;
        } else {
          delete merged.region;
        }
      }
      if (typeof requested?.locale === "string") {
        merged.locale = requested.locale;
      }
      if (typeof requested?.timezone === "string") {
        merged.timezone = requested.timezone;
      }
      if (isRecord(requested?.viewport) && typeof requested.viewport["width"] === "number" && typeof requested.viewport["height"] === "number") {
        merged.viewport = { width: requested.viewport["width"], height: requested.viewport["height"] };
      }

      const oldSessionId = state.sessionId;

      const sessionInput: CreateSessionInput = { sessionConfig: merged };
      if (state.profileId) {
        sessionInput.profileId = state.profileId;
      }

      const newSession = await provider.createSession(sessionInput);
      await context?.onSessionReconfigured?.({
        oldSessionId,
        newSession,
        summary: action.summary,
      });

      try {
        await provider.stopSession(oldSessionId);
      } catch { /* best-effort */ }

      state.sessionId = newSession.id;
      state.sessionConfig = merged;
      const liveUrl = newSession.liveUrl ?? newSession.debugUrl;
      if (liveUrl) {
        state.sessionLiveUrl = liveUrl;
      }
      if (newSession.profileId) {
        state.profileId = newSession.profileId;
      }

      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "thought-summary",
        payload: {
          summary: action.summary,
          kind: "reconfigure",
          oldSessionId,
          newSessionId: newSession.id,
          config: merged as JsonObject,
        },
      });

      // Auto-observe new session so agent sees about:blank
      const observation = await provider.observe({ sessionId: state.sessionId });
      const { toObservationPayload } = await import("../../browser/observe.js");
      const { redactJsonObject } = await import("../../shared/redact.js");
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "observation",
        payload: redactJsonObject(toObservationPayload(observation)),
      });
      if (observation.screenshotBase64) {
        state.latestScreenshotBase64 = observation.screenshotBase64;
      }

      return {};
    },
  }];
}
