import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserObservation,
  BrowserRawRequest,
  BrowserSession,
  CreateSessionInput,
  SessionId,
} from "../../shared/types.js";
import type { BrowserObserveInput, BrowserProvider } from "../../browser/bridge.js";

/**
 * Custom browser provider stub. Extend this class to integrate with
 * non-Steel browser infrastructure (local Chrome, BrowserBase, etc.).
 */
export class CustomProvider implements BrowserProvider {
  async createSession(_input: CreateSessionInput): Promise<BrowserSession> {
    throw new Error("CustomProvider.createSession not implemented");
  }

  async getSession(_sessionId: SessionId): Promise<BrowserSession> {
    throw new Error("CustomProvider.getSession not implemented");
  }

  async stopSession(_sessionId: SessionId): Promise<void> {
    throw new Error("CustomProvider.stopSession not implemented");
  }

  async observe(_input: BrowserObserveInput): Promise<BrowserObservation> {
    throw new Error("CustomProvider.observe not implemented");
  }

  async exec(_input: BrowserExecRequest): Promise<BrowserExecResult> {
    throw new Error("CustomProvider.exec not implemented");
  }

  async raw(_input: BrowserRawRequest): Promise<unknown> {
    throw new Error("CustomProvider.raw not implemented");
  }
}
