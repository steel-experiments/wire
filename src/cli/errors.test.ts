import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyError } from "./errors.js";
import { NotFoundError, CorruptError, StorageError } from "../storage/atomic.js";

test("classifyError: NotFoundError for runs → RUN_NOT_FOUND", () => {
  const err = new NotFoundError("runs", "run_abc123");
  const result = classifyError(err);
  assert.equal(result.error_class, "session");
  assert.equal(result.error_code, "RUN_NOT_FOUND");
  assert.equal(result.retryable, false);
  assert.ok(result.hint.includes("run_abc123"));
});

test("classifyError: NotFoundError for checkpoints → CHECKPOINT_NOT_FOUND", () => {
  const err = new NotFoundError("checkpoints", "run_abc123");
  const result = classifyError(err);
  assert.equal(result.error_code, "CHECKPOINT_NOT_FOUND");
  assert.equal(result.error_class, "session");
  assert.equal(result.retryable, false);
});

test("classifyError: generic NotFoundError → NOT_FOUND", () => {
  const err = new NotFoundError("tasks", "task_abc");
  const result = classifyError(err);
  assert.equal(result.error_code, "NOT_FOUND");
  assert.equal(result.error_class, "session");
});

test("classifyError: CorruptError → STORAGE_CORRUPT", () => {
  const err = new CorruptError("/path/to/file.json", "invalid JSON");
  const result = classifyError(err);
  assert.equal(result.error_class, "infra");
  assert.equal(result.error_code, "STORAGE_CORRUPT");
  assert.equal(result.retryable, false);
  assert.ok(result.hint!.includes("/path/to/file.json"));
});

test("classifyError: StorageError → STORAGE_READ_FAILED (retryable)", () => {
  const err = new StorageError("Failed to read file");
  const result = classifyError(err);
  assert.equal(result.error_class, "infra");
  assert.equal(result.error_code, "STORAGE_READ_FAILED");
  assert.equal(result.retryable, true);
});

test("classifyError: 'no objective' → MISSING_OBJECTIVE", () => {
  const err = new Error("no objective provided");
  const result = classifyError(err);
  assert.equal(result.error_code, "MISSING_OBJECTIVE");
  assert.equal(result.error_class, "input");
  assert.equal(result.retryable, false);
});

test("classifyError: 'multiple providers' → MULTIPLE_PROVIDERS", () => {
  const err = new Error("Multiple LLM providers are configured");
  const result = classifyError(err);
  assert.equal(result.error_code, "MULTIPLE_PROVIDERS");
  assert.equal(result.error_class, "input");
});

test("classifyError: provider/model mismatch → PROVIDER_MODEL_MISMATCH", () => {
  const err = new Error('Model "claude-3" does not match provider "openai".');
  const result = classifyError(err);
  assert.equal(result.error_code, "PROVIDER_MODEL_MISMATCH");
  assert.equal(result.error_class, "input");
});

test("classifyError: network errors → NETWORK_TIMEOUT (retryable)", () => {
  const cases = ["network error", "ETIMEDOUT", "ECONNREFUSED", "Connection timeout"];
  for (const msg of cases) {
    const result = classifyError(new Error(msg));
    assert.equal(result.error_code, "NETWORK_TIMEOUT");
    assert.equal(result.error_class, "network");
    assert.equal(result.retryable, true);
  }
});

test("classifyError: 'no LLM provider' → NO_LLM_PROVIDER", () => {
  const err = new Error("No LLM provider available");
  const result = classifyError(err);
  assert.equal(result.error_code, "NO_LLM_PROVIDER");
  assert.equal(result.error_class, "auth");
});

test("classifyError: unknown Error → INTERNAL_ERROR", () => {
  const result = classifyError(new Error("something unexpected"));
  assert.equal(result.error_code, "INTERNAL_ERROR");
  assert.equal(result.error_class, "internal");
  assert.equal(result.retryable, false);
});

test("classifyError: non-Error value → INTERNAL_ERROR with details", () => {
  const result = classifyError("string error");
  assert.equal(result.error_code, "INTERNAL_ERROR");
  assert.equal(result.details, "string error");
});
