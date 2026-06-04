import type { BrowserExecRequest, BrowserSession } from "../../../shared/types.js";
import type { SteelLogger, TargetInfo, WebSocketLike } from "./types.js";

const RAW_RUNTIME_EVALUATE_TIMEOUT_MS = 12_000;

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  private readonly listeners = new Map<string, Array<(params: unknown) => void | Promise<void>>>();
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
          this.logger?.error?.(`steel:ws ${message} - ${this.pending.size} pending command(s) aborted`);
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
          const event = message as { method?: string; params?: unknown; sessionId?: string };
          if (event.method) {
            const params = event.params && typeof event.params === "object" && !Array.isArray(event.params)
              ? { ...(event.params as Record<string, unknown>), __sessionId: event.sessionId }
              : event.params;
            void this.emit(event.method, params);
          }
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

  on(method: string, listener: (params: unknown) => void | Promise<void>): void {
    const existing = this.listeners.get(method) ?? [];
    existing.push(listener);
    this.listeners.set(method, existing);
  }

  close(): void {
    this.socket.close();
  }

  private async emit(method: string, params: unknown): Promise<void> {
    const listeners = this.listeners.get(method) ?? [];
    for (const listener of listeners) {
      try {
        await listener(params);
      } catch (err) {
        this.logger?.warn?.("steel:cdp event listener failed", {
          method,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private rejectPending(error: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }
}

export async function withConnection<T>(
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

export async function listPageTargets(cdp: CdpConnection): Promise<TargetInfo[]> {
  const response = await cdp.send<{ targetInfos?: TargetInfo[] }>("Target.getTargets");
  return (response.targetInfos ?? []).filter((target) => target.type === "page");
}

export function pickTarget(targets: TargetInfo[], targetId?: string): TargetInfo {
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

export function pickExecTargets(
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

export async function attachToTarget(cdp: CdpConnection, targetId: string): Promise<string> {
  const response = await cdp.send<{ sessionId: string }>("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  return response.sessionId;
}

export async function evaluateJson<T>(
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

export function cdpMethodNeedsTargetSession(method: string): boolean {
  return /^(DOM|Input|Page|Runtime)\./u.test(method);
}

export function capRawRuntimeEvaluate(method: string, params?: Record<string, unknown>): { params?: Record<string, unknown>; timeoutMs?: number } {
  if (method !== "Runtime.evaluate") return params ? { params } : {};
  const requested = typeof params?.timeout === "number" && Number.isFinite(params.timeout)
    ? Math.floor(params.timeout)
    : RAW_RUNTIME_EVALUATE_TIMEOUT_MS;
  const timeout = Math.min(RAW_RUNTIME_EVALUATE_TIMEOUT_MS, Math.max(1, requested));
  return { params: { ...params, timeout }, timeoutMs: timeout };
}

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
    const hasFrame = /\bat\s+/.test(description);
    return hasFrame ? description : `${description}${loc}`;
  }
  return details.text ?? fallback ?? "Runtime evaluation failed";
}
