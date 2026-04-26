import type { LoopState } from "./loop.js";
import type { BrowserSession, ProposedAction, SessionId } from "../shared/types.js";
import type { BrowserProvider } from "../browser/bridge.js";

export interface ActionExecutionContext {
  onSessionReconfigured?: (
    details: { oldSessionId: SessionId; newSession: BrowserSession; summary: string },
  ) => Promise<void> | void;
}

export interface ActionHandler {
  kind: string;
  description: string;
  execute(
    state: LoopState,
    action: ProposedAction,
    provider: BrowserProvider,
    context?: ActionExecutionContext,
  ): Promise<{ authWallHit?: boolean }>;
}

export class ActionRegistry {
  private readonly handlers = new Map<string, ActionHandler>();

  register(handler: ActionHandler): void {
    this.handlers.set(handler.kind, handler);
  }

  get(kind: string): ActionHandler | undefined {
    return this.handlers.get(kind);
  }

  descriptions(): Array<{ kind: string; description: string }> {
    return [...this.handlers.values()].map((h) => ({ kind: h.kind, description: h.description }));
  }
}
