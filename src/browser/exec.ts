import type {
  BrowserExecRequest,
  BrowserExecResult,
  BrowserExecTarget,
  SessionId,
} from "../shared/types.js";

import { resolveTarget } from "./targets.js";

// ---------------------------------------------------------------------------
// Code execution adapter
// ---------------------------------------------------------------------------

export interface ExecOptions {
  provider: { exec(input: BrowserExecRequest): Promise<BrowserExecResult> };
  sessionId: SessionId;
  code: string;
  timeoutMs?: number;
  target?: BrowserExecTarget;
  attachments?: string[];
  artifactDir?: string;
}

/**
 * Execute JavaScript/TypeScript code against a browser session.
 *
 * This is a thin adapter that builds the provider input, delegates to
 * `provider.exec()`, and returns the result. The actual JS execution
 * happens in the provider via CDP.
 */
export async function execCode(options: ExecOptions): Promise<BrowserExecResult> {
  const resolvedTarget = resolveTarget(options.target);

  const input: BrowserExecRequest = {
    sessionId: options.sessionId,
    code: options.code,
  };

  if (options.timeoutMs) {
    input.timeoutMs = options.timeoutMs;
  }

  // Always set the resolved target so the provider knows which tab to use.
  input.target = resolvedTarget;

  if (options.attachments && options.attachments.length > 0) {
    input.attachments = options.attachments;
  }

  return options.provider.exec(input);
}

const NAVIGATION_PATTERNS = [
  /\bwindow\s*\.\s*location\s*(?:=|\.href\s*=|\.assign\s*\(|\.replace\s*\(|\.reload\s*\(|\[)/u,
  /\blocation\s*(?:=|\.href\s*=|\.assign\s*\(|\.replace\s*\(|\.reload\s*\()/u,
  /\bdocument\s*\.\s*location\s*(?:=|\.href\s*=|\.assign\s*\(|\.replace\s*\(|\.reload\s*\(|\[)/u,
];

export function isLikelyNavigationCode(code: string): boolean {
  return NAVIGATION_PATTERNS.some((pattern) => pattern.test(code));
}
