// ABOUTME: Run-bounding helpers for embedded/unattended execution — autonomous
// ABOUTME: approval resolution and wall-clock deadlines layered onto a config.
import { autoApprovingEngine } from "../policy/engine.js";
import type { RuntimeConfig } from "./runtime.js";

// True when the run's cancelSignal was tripped by the wall-clock deadline
// rather than by a caller-provided signal. The deadline aborts with a
// TimeoutError DOMException, whose name AbortSignal.any propagates.
export function isWallClockTimeout(signal?: AbortSignal): boolean {
  if (!signal?.aborted) return false;
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === "TimeoutError";
}

// Applies the autonomous approval resolution. "allow" wraps the policy engine
// so gated actions auto-proceed; "deny" is handled in the loop (see the
// pendingApproval branch) so the run can stop with a precise classification.
export function withApprovalResolution(config: RuntimeConfig): RuntimeConfig {
  if (config.onApprovalRequired === "allow") {
    return { ...config, policyEngine: autoApprovingEngine(config.policyEngine) };
  }
  return config;
}

// Layers a wall-clock deadline onto the run by combining an internal timeout
// signal with any caller cancelSignal. Returns a cleanup() that must be called
// to clear the timer regardless of how the run ends.
export function withWallClockTimeout(config: RuntimeConfig): { config: RuntimeConfig; cleanup: () => void } {
  if (config.maxWallClockMs === undefined) {
    return { config, cleanup: () => {} };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("Wall-clock timeout exceeded", "TimeoutError"));
  }, config.maxWallClockMs);
  // Don't let a pending deadline keep the process alive after the run returns.
  (timer as { unref?: () => void }).unref?.();
  const sources = config.cancelSignal ? [config.cancelSignal, controller.signal] : [controller.signal];
  return {
    config: { ...config, cancelSignal: AbortSignal.any(sources) },
    cleanup: () => clearTimeout(timer),
  };
}
