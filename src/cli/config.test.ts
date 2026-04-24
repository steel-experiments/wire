import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveModel, loadConfig } from "./config.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// resolveModel — precedence tests
// ---------------------------------------------------------------------------

test("resolveModel returns CLI flag when all sources provided", () => {
  assert.equal(resolveModel("cli-model", "env-model", "config-model"), "cli-model");
});

test("resolveModel returns env var when no CLI flag", () => {
  assert.equal(resolveModel(undefined, "env-model", "config-model"), "env-model");
});

test("resolveModel returns config value when no CLI or env", () => {
  assert.equal(resolveModel(undefined, undefined, "config-model"), "config-model");
});

test("resolveModel returns undefined when nothing provided", () => {
  assert.equal(resolveModel(undefined, undefined, undefined), undefined);
});

test("resolveModel returns CLI flag even when env and config are set", () => {
  assert.equal(resolveModel("gpt-5.4-mini", "claude-sonnet-4-6", "other"), "gpt-5.4-mini");
});

test("resolveModel returns env var when only env is set", () => {
  assert.equal(resolveModel(undefined, "claude-sonnet-4-6", undefined), "claude-sonnet-4-6");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeIsolatedDir(): Promise<string> {
  const dir = join(tmpdir(), `wire-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
// loadConfig — file reading tests
// ---------------------------------------------------------------------------

test("loadConfig returns {} when both files are missing", async () => {
  const dir = await makeIsolatedDir();
  try {
    const config = await loadConfig(dir, dir);
    assert.deepEqual(config, {});
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("loadConfig reads project wire.json", async () => {
  const dir = await makeIsolatedDir();
  try {
    await writeFile(join(dir, "wire.json"), JSON.stringify({ model: "gpt-5.4-mini" }));
    const config = await loadConfig(dir, dir);
    assert.equal(config.model, "gpt-5.4-mini");
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("loadConfig returns {} for invalid project JSON", async () => {
  const dir = await makeIsolatedDir();
  try {
    await writeFile(join(dir, "wire.json"), "not-json");
    const config = await loadConfig(dir, dir);
    assert.deepEqual(config, {});
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("loadConfig returns {} for empty wire.json", async () => {
  const dir = await makeIsolatedDir();
  try {
    await writeFile(join(dir, "wire.json"), "{}");
    const config = await loadConfig(dir, dir);
    assert.deepEqual(config, {});
  } finally {
    await rm(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// loadConfig — user + project merge tests
// ---------------------------------------------------------------------------

test("loadConfig reads user-level ~/.wire/config.json", async () => {
  const userDir = await makeIsolatedDir();
  const projectDir = await makeIsolatedDir();
  try {
    await mkdir(join(userDir, ".wire"), { recursive: true });
    await writeFile(
      join(userDir, ".wire", "config.json"),
      JSON.stringify({ model: "claude-sonnet-4-6" }),
    );
    const config = await loadConfig(projectDir, userDir);
    assert.equal(config.model, "claude-sonnet-4-6");
  } finally {
    await rm(userDir, { recursive: true });
    await rm(projectDir, { recursive: true });
  }
});

test("loadConfig merges user defaults with project overrides", async () => {
  const userDir = await makeIsolatedDir();
  const projectDir = await makeIsolatedDir();
  try {
    await mkdir(join(userDir, ".wire"), { recursive: true });
    await writeFile(
      join(userDir, ".wire", "config.json"),
      JSON.stringify({ model: "user-default" }),
    );
    await writeFile(
      join(projectDir, "wire.json"),
      JSON.stringify({ model: "project-override" }),
    );
    const config = await loadConfig(projectDir, userDir);
    assert.equal(config.model, "project-override");
  } finally {
    await rm(userDir, { recursive: true });
    await rm(projectDir, { recursive: true });
  }
});

test("loadConfig uses user config when project has no model", async () => {
  const userDir = await makeIsolatedDir();
  const projectDir = await makeIsolatedDir();
  try {
    await mkdir(join(userDir, ".wire"), { recursive: true });
    await writeFile(
      join(userDir, ".wire", "config.json"),
      JSON.stringify({ model: "user-default" }),
    );
    await writeFile(join(projectDir, "wire.json"), "{}");
    const config = await loadConfig(projectDir, userDir);
    assert.equal(config.model, "user-default");
  } finally {
    await rm(userDir, { recursive: true });
    await rm(projectDir, { recursive: true });
  }
});
