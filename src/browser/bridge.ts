import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  BrowserRawRequest,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSession,
  CreateSessionInput,
  SessionId,
} from "../shared/types.js";

// Browser observe input

export interface BrowserObserveInput {
  sessionId: SessionId;
  targetId?: string;
}

// Browser provider contract

export interface BrowserProvider {
  createSession(input: CreateSessionInput): Promise<BrowserSession>;
  getSession(sessionId: SessionId): Promise<BrowserSession>;
  stopSession(sessionId: SessionId): Promise<void>;
  observe(input: BrowserObserveInput): Promise<BrowserObservation>;
  screenshot?(input: BrowserScreenshotRequest): Promise<BrowserScreenshotResult>;
  exec(input: BrowserExecRequest): Promise<BrowserExecResult>;
  raw?(input: BrowserRawRequest): Promise<unknown>;
}
