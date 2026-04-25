import { NotFoundError, CorruptError, StorageError } from "../storage/atomic.js";

// ---------------------------------------------------------------------------
// Error taxonomy for agent-native CLI
// ---------------------------------------------------------------------------

export type WireErrorClass =
  | "input"
  | "auth"
  | "network"
  | "session"
  | "infra"
  | "policy"
  | "internal";

export interface WireError {
  error_class: WireErrorClass;
  error_code: string;
  retryable: boolean;
  hint: string;
  details?: unknown;
}

// ---------------------------------------------------------------------------
// classifyError — maps unknown errors to structured WireError
// ---------------------------------------------------------------------------

export function classifyError(error: unknown): WireError {
  // NotFoundError → map based on entity kind
  if (error instanceof NotFoundError) {
    if (error.entityKind === "runs") {
      return {
        error_class: "session",
        error_code: "RUN_NOT_FOUND",
        retryable: false,
        hint: `Run "${error.entityId}" does not exist. Use "wire list" to see available runs.`,
      };
    }
    if (error.entityKind === "checkpoints") {
      return {
        error_class: "session",
        error_code: "CHECKPOINT_NOT_FOUND",
        retryable: false,
        hint: `Checkpoint for "${error.entityId}" does not exist. The run may have already completed.`,
      };
    }
    return {
      error_class: "session",
      error_code: "NOT_FOUND",
      retryable: false,
      hint: `${error.entityKind} "${error.entityId}" not found.`,
    };
  }

  // CorruptError
  if (error instanceof CorruptError) {
    return {
      error_class: "infra",
      error_code: "STORAGE_CORRUPT",
      retryable: false,
      hint: `Storage file is corrupt: ${error.filePath}. Consider deleting and re-running.`,
      details: { path: error.filePath },
    };
  }

  // StorageError (retryable)
  if (error instanceof StorageError) {
    return {
      error_class: "infra",
      error_code: "STORAGE_READ_FAILED",
      retryable: true,
      hint: "Storage operation failed. Check filesystem permissions and retry.",
    };
  }

  // Known error messages from runner.ts / main.ts
  if (error instanceof Error) {
    const msg = error.message;

    if (/no objective/i.test(msg)) {
      return {
        error_class: "input",
        error_code: "MISSING_OBJECTIVE",
        retryable: false,
        hint: "Provide --objective <text> or --task-file <path>.",
      };
    }

    if (/invalid task file json/i.test(msg)) {
      return {
        error_class: "input",
        error_code: "INVALID_TASK_FILE",
        retryable: false,
        hint: "Provide a valid JSON task file with an objective field.",
      };
    }

    if (/multiple.*provider/i.test(msg)) {
      return {
        error_class: "input",
        error_code: "MULTIPLE_PROVIDERS",
        retryable: false,
        hint: "Set llm.provider, WIRE_PROVIDER, or --provider to disambiguate.",
      };
    }

    if (/does not match provider/i.test(msg)) {
      return {
        error_class: "input",
        error_code: "PROVIDER_MODEL_MISMATCH",
        retryable: false,
        hint: "The --model value does not match the selected --provider.",
      };
    }

    // Network / timeout patterns
    if (/network|timeout|ECONN|ETIMEDOUT/i.test(msg)) {
      return {
        error_class: "network",
        error_code: "NETWORK_TIMEOUT",
        retryable: true,
        hint: "Network error occurred. Check connectivity and retry.",
      };
    }

    // No LLM provider available
    if (/no.*llm.*provider|no.*provider.*available/i.test(msg)) {
      return {
        error_class: "auth",
        error_code: "NO_LLM_PROVIDER",
        retryable: false,
        hint: "Set OPENAI_API_KEY or ANTHROPIC_API_KEY, or configure llm.provider in wire.json.",
      };
    }
  }

  // Fallback
  return {
    error_class: "internal",
    error_code: "INTERNAL_ERROR",
    retryable: false,
    hint: "An unexpected error occurred. Check logs for details.",
    details: error instanceof Error ? error.message : String(error),
  };
}
