// ABOUTME: Action-handler contract between the agent loop and browser
// ABOUTME: providers, defined here so providers never import agent code.

import type {
  BrowserSession,
  ProfileId,
  ProposedAction,
  Run,
  SessionConfig,
  SessionId,
  TraceEvent,
} from "../shared/types.js";
import type { BrowserProvider } from "./bridge.js";

export interface ActionExecutionContext {
  onSessionReconfigured?: (
    details: { oldSessionId: SessionId; newSession: BrowserSession; summary: string },
  ) => Promise<void> | void;
  includePageSketch?: boolean;
}

// The slice of loop state an action handler may read and mutate. Structurally
// satisfied by the agent's LoopState.
export interface ActionHandlerState {
  run: Run;
  events: TraceEvent[];
  sessionId: SessionId;
  sessionLiveUrl?: string;
  sessionConfig?: SessionConfig;
  profileId?: ProfileId;
  latestScreenshotBase64?: string;
}

export interface ActionHandler {
  kind: string;
  description: string;
  execute(
    state: ActionHandlerState,
    action: ProposedAction,
    provider: BrowserProvider,
    context?: ActionExecutionContext,
  ): Promise<{ authWallHit?: boolean }>;
}
