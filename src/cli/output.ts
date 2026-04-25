import type { WireError } from "./errors.js";

// ---------------------------------------------------------------------------
// Versioned output envelope for agent-native CLI
// ---------------------------------------------------------------------------

export interface WireOutput<T = unknown> {
  schema_version: "1.0";
  command: string;
  status: "succeeded" | "failed";
  data?: T;
  error?: WireError;
  run_id?: string;
}

export function success<T>(command: string, data: T, runId?: string): WireOutput<T> {
  const out: WireOutput<T> = {
    schema_version: "1.0",
    command,
    status: "succeeded",
    data,
  };
  if (runId !== undefined) {
    out.run_id = runId;
  }
  return out;
}

export function failure(command: string, error: WireError, runId?: string): WireOutput<never> {
  const out: WireOutput<never> = {
    schema_version: "1.0",
    command,
    status: "failed",
    error,
  };
  if (runId !== undefined) {
    out.run_id = runId;
  }
  return out;
}
