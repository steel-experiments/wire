import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  BrowserRawRequest,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  SessionId,
} from "../../../shared/types.js";
import type { BrowserObserveInput, BrowserProvider } from "../../../browser/bridge.js";
import { validateBrowserCode } from "./code-validation.js";
import {
  buildCreateSessionBody,
  DEFAULT_BASE_URL,
  DEFAULT_CDP_COMMAND_TIMEOUT_MS,
  DEFAULT_GET_SESSION_RETRY_DELAY_MS,
  extractSteelId,
  GET_SESSION_MAX_ATTEMPTS,
  SteelApiError,
  steelFetch,
  toBrowserSession,
} from "./api.js";
import {
  attachToTarget,
  capRawRuntimeEvaluate,
  cdpMethodNeedsTargetSession,
  evaluateJson,
  listPageTargets,
  pickExecTargets,
  pickTarget,
  withConnection,
} from "./cdp.js";
import { defaultWireClickPolicy, installWireClickBinding } from "./wire-click.js";
import type {
  SteelLogger,
  SteelProviderConfig,
  SteelRetryEvent,
  SteelSessionResponse,
  WebSocketLike,
  WireClickPolicyDecision,
  WireClickRequest,
} from "./types.js";

export type {
  SteelLogger,
  SteelProviderConfig,
  SteelRetryEvent,
  WebSocketLike,
  WireClickPolicyDecision,
  WireClickRequest,
} from "./types.js";

// Some Steel deployments have a brief post-create propagation window where
// GET /sessions/{id} 404s for ~1-2s after the session is created. Retry on
// 404 with a short bounded budget so observe()'s first read doesn't crash.

export class SteelProvider implements BrowserProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly webSocketFactory: (url: string) => WebSocketLike;
  private readonly cdpCommandTimeoutMs: number;
  private readonly createSessionMaxRetries: number;
  private readonly getSessionRetryDelayMs: number;
  private readonly wireClickPolicy: (request: WireClickRequest) => WireClickPolicyDecision;
  private readonly onRetry: ((event: SteelRetryEvent) => void | Promise<void>) | undefined;
  private readonly logger: SteelLogger | undefined;

  constructor(config: SteelProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.webSocketFactory = config.webSocketFactory ?? ((url) => new WebSocket(url) as unknown as WebSocketLike);
    this.cdpCommandTimeoutMs = config.cdpCommandTimeoutMs ?? DEFAULT_CDP_COMMAND_TIMEOUT_MS;
    this.createSessionMaxRetries = config.createSessionMaxRetries ?? 0;
    this.getSessionRetryDelayMs = config.getSessionRetryDelayMs ?? DEFAULT_GET_SESSION_RETRY_DELAY_MS;
    this.wireClickPolicy = config.wireClickPolicy ?? defaultWireClickPolicy;
    this.onRetry = config.onRetry;
    this.logger = config.logger;
  }

  async createSession(input: CreateSessionInput = {}): Promise<BrowserSession> {
    const body = buildCreateSessionBody(input);
    const maxRetries = Math.max(0, Math.floor(this.createSessionMaxRetries));
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
    let lastError: unknown;
    for (let attempt = 1; attempt <= GET_SESSION_MAX_ATTEMPTS; attempt++) {
      try {
        const steel = await steelFetch<SteelSessionResponse>(
          this.baseUrl,
          this.apiKey,
          `/sessions/${steelId}`,
        );
        return toBrowserSession(steel);
      } catch (err) {
        lastError = err;
        const status = err instanceof SteelApiError ? err.status : -1;
        if (status !== 404 || attempt === GET_SESSION_MAX_ATTEMPTS) {
          throw err;
        }
        if (this.getSessionRetryDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, this.getSessionRetryDelayMs));
        }
      }
    }
    throw lastError;
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

  async screenshot(input: BrowserScreenshotRequest): Promise<BrowserScreenshotResult> {
    const session = this.withAuth(await this.getSession(input.sessionId));

    return withConnection(this.webSocketFactory, session, this.cdpCommandTimeoutMs, this.logger, async (cdp) => {
      const targets = await listPageTargets(cdp);
      const target = pickTarget(targets, input.targetId);
      const sessionId = await attachToTarget(cdp, target.targetId);
      const result = await cdp.send<{ data?: string }>(
        "Page.captureScreenshot",
        { format: "png" },
        sessionId,
      );
      if (!result.data) {
        throw new Error("Page.captureScreenshot returned no data");
      }
      return {
        dataBase64: result.data,
        mimeType: "image/png",
        targetId: target.targetId,
      };
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
      const wireEvents: JsonObject[] = [];
      let ok = true;
      let returnValue: unknown;

      for (const target of selected) {
        try {
          validateBrowserCode(input.code);
          const sessionId = await attachToTarget(cdp, target.targetId);
          await installWireClickBinding(cdp, sessionId, wireEvents, this.wireClickPolicy);
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
      if (wireEvents.length > 0) {
        result.wireEvents = wireEvents;
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
  const baseUrl = config?.baseUrl ?? process.env.STEEL_BASE_URL;
  if (baseUrl) {
    providerConfig.baseUrl = baseUrl;
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
  if (config?.createSessionMaxRetries !== undefined) {
    providerConfig.createSessionMaxRetries = config.createSessionMaxRetries;
  }
  if (config?.getSessionRetryDelayMs !== undefined) {
    providerConfig.getSessionRetryDelayMs = config.getSessionRetryDelayMs;
  }
  if (config?.wireClickPolicy) {
    providerConfig.wireClickPolicy = config.wireClickPolicy;
  }
  if (config?.logger) {
    providerConfig.logger = config.logger;
  }

  return new SteelProvider(providerConfig);
}
