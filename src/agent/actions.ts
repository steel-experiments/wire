// The handler contract lives in browser/actions.ts so providers can implement
// handlers without importing agent code; re-exported here for agent callers.
export type {
  ActionExecutionContext,
  ActionHandler,
  ActionHandlerState,
} from "../browser/actions.js";
import type { ActionHandler } from "../browser/actions.js";

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
