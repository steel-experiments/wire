import type { CreateSessionInput } from "../../../shared/types.js";

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

export interface WebSocketLike {
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface SteelProviderConfig {
  apiKey: string;
  baseUrl?: string;
  webSocketFactory?: (url: string) => WebSocketLike;
  cdpCommandTimeoutMs?: number;
  createSessionMaxRetries?: number;
  getSessionRetryDelayMs?: number;
  wireClickPolicy?: (request: WireClickRequest) => WireClickPolicyDecision;
  onRetry?: (event: SteelRetryEvent) => void | Promise<void>;
  logger?: SteelLogger;
}

export interface SteelSessionResponse {
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

export interface TargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
}

export interface WireClickRequest {
  id: string;
  kind: "click";
  x: number;
  y: number;
  button?: "left" | "right" | "middle";
  target?: {
    tag?: string;
    role?: string;
    text?: string;
    ariaLabel?: string;
    selectorHint?: string;
  };
}

export interface WireClickPolicyDecision {
  result: "allow" | "deny" | "require-approval";
  reason?: string;
}

export interface SteelCreateSessionBody {
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

export type SteelCreateSessionInput = CreateSessionInput;
