// ABOUTME: Wire-protocol types shared by the server and the SPA.
// ABOUTME: Minimal local shapes — the console never imports Wire's own types.

/** A trace event as emitted by `wire run --stream-json` (one JSON line each). */
export interface WireTraceEvent {
  id: string;
  runId: string;
  ts: string;
  kind: string;
  payload: Record<string, unknown>;
}

export type RunStatus = "starting" | "running" | "finished" | "error" | "awaiting-approval";

export interface PendingApproval {
  approvalId: string;
  summary: string;
  actionKind?: string;
  riskKind?: string;
  codeExcerpt?: string;
}

/** The console's view of a launched run, correlated by a local launchId. */
export interface RunSummary {
  launchId: string;
  runId?: string;
  objective: string;
  mode: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number;
  stepCount: number;
  classification?: string;
  result?: string;
  outcomeSummary?: string;
  /** Public, embeddable Steel session player (Wire's debugUrl, not the auth-gated dashboard liveUrl). */
  liveViewUrl?: string;
  pendingApproval?: PendingApproval;
  error?: string;
}

/** Messages pushed over the multiplexed SSE stream. */
export type ServerEvent =
  | { type: "run-started"; run: RunSummary }
  | { type: "run-updated"; run: RunSummary }
  | { type: "run-finished"; run: RunSummary }
  | { type: "trace"; launchId: string; runId?: string; event: WireTraceEvent };

export interface LaunchRequest {
  objective: string;
  mode?: string;
  maxSteps?: number;
  provider?: string;
  model?: string;
}
