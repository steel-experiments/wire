import type {
  BrowserSession,
  CreateSessionInput,
  SessionConfig,
  SessionId,
  SessionStatus,
} from "../../../shared/types.js";
import { nowIsoUtc } from "../../../shared/ids.js";
import type { SteelCreateSessionBody, SteelSessionResponse } from "./types.js";

export const DEFAULT_BASE_URL = "https://api.steel.dev/v1";
export const DEFAULT_CDP_COMMAND_TIMEOUT_MS = 30_000;
export const GET_SESSION_MAX_ATTEMPTS = 3;
export const DEFAULT_GET_SESSION_RETRY_DELAY_MS = 200;

const STEEL_REGION_CODES = new Set(["lax", "iad"]);

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

export function toBrowserSession(steel: SteelSessionResponse, region?: string): BrowserSession {
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

export class SteelApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`Steel API error (${status}): ${message}`);
    this.name = "SteelApiError";
  }
}

// Steel REST calls front every observe/exec; a stalled API must not hang a
// run forever. Mirrors the LLM transport's 60s request bound.
const STEEL_FETCH_TIMEOUT_MS = 60_000;

export async function steelFetch<T>(
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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), STEEL_FETCH_TIMEOUT_MS);
  try {
    response = await fetch(url, { ...options, headers, signal: controller.signal });
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    throw new SteelApiError(
      0,
      aborted
        ? `Network error: request timed out after ${STEEL_FETCH_TIMEOUT_MS}ms`
        : `Network error: ${(err as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
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

export function buildCreateSessionBody(input: CreateSessionInput): SteelCreateSessionBody {
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

export function normalizeSteelRegion(region: unknown): string | undefined {
  if (typeof region !== "string") return undefined;
  const normalized = region.trim().toLowerCase();
  return STEEL_REGION_CODES.has(normalized) ? normalized : undefined;
}

export function sanitizedSessionConfig(config: SessionConfig): SessionConfig {
  const sanitized: SessionConfig = { ...config };
  const region = normalizeSteelRegion(sanitized.region);
  if (region) {
    sanitized.region = region;
  } else {
    delete sanitized.region;
  }
  return sanitized;
}

export function extractSteelId(sessionId: SessionId): string {
  return sessionId.replace(/^session_/u, "");
}
