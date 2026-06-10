import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveLlmConfig, loadConfig } from "./config.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// resolveLlmConfig — precedence tests
// ---------------------------------------------------------------------------

test("resolveLlmConfig returns CLI values when all sources provided", () => {
  const config = resolveLlmConfig(
    "anthropic",
    "cli-model",
    "openai",
    "env-model",
    { llm: { provider: "openai", model: "config-model" } },
  );
  assert.equal(config.provider, "anthropic");
  assert.equal(config.model, "cli-model");
});

test("resolveLlmConfig returns env values when no CLI values", () => {
  const config = resolveLlmConfig(
    undefined,
    undefined,
    "anthropic",
    "env-model",
    { llm: { provider: "openai", model: "config-model" } },
  );
  assert.equal(config.provider, "anthropic");
  assert.equal(config.model, "env-model");
});

test("resolveLlmConfig returns config llm values when no CLI or env", () => {
  const config = resolveLlmConfig(
    undefined,
    undefined,
    undefined,
    undefined,
    { llm: { provider: "anthropic", model: "config-model" } },
  );
  assert.equal(config.provider, "anthropic");
  assert.equal(config.model, "config-model");
});

test("resolveLlmConfig falls back to legacy root fields", () => {
  const config = resolveLlmConfig(
    undefined,
    undefined,
    undefined,
    undefined,
    { provider: "openai", model: "legacy-model" },
  );
  assert.equal(config.provider, "openai");
  assert.equal(config.model, "legacy-model");
});

test("resolveLlmConfig returns empty config when nothing provided", () => {
  assert.deepEqual(resolveLlmConfig(undefined, undefined, undefined, undefined, undefined), {});
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
    await writeFile(join(dir, "wire.json"), JSON.stringify({
      llm: { provider: "openai", model: "gpt-5.4-mini" },
      browser: { session: { useProxy: true, solveCaptcha: true, stealth: true, region: "us-east-1" } },
    }));
    const config = await loadConfig(dir, dir);
    assert.equal(config.llm?.provider, "openai");
    assert.equal(config.llm?.model, "gpt-5.4-mini");
    assert.equal(config.browser?.session?.useProxy, true);
    assert.equal(config.browser?.session?.solveCaptcha, true);
    assert.equal(config.browser?.session?.stealth, true);
    assert.equal(config.browser?.session?.region, "us-east-1");
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
      JSON.stringify({ llm: { provider: "anthropic", model: "claude-sonnet-4-6" } }),
    );
    const config = await loadConfig(projectDir, userDir);
    assert.equal(config.llm?.provider, "anthropic");
    assert.equal(config.llm?.model, "claude-sonnet-4-6");
  } finally {
    await rm(userDir, { recursive: true });
    await rm(projectDir, { recursive: true });
  }
});

test("loadConfig reads config from WIRE_HOME when no test userDir is supplied", async () => {
  const wireHome = await makeIsolatedDir();
  const projectDir = await makeIsolatedDir();
  const previous = process.env.WIRE_HOME;
  try {
    process.env.WIRE_HOME = wireHome;
    await writeFile(
      join(wireHome, "config.json"),
      JSON.stringify({ llm: { provider: "openai", model: "from-wire-home" } }),
    );
    const config = await loadConfig(projectDir);
    assert.equal(config.llm?.provider, "openai");
    assert.equal(config.llm?.model, "from-wire-home");
  } finally {
    if (previous === undefined) {
      delete process.env.WIRE_HOME;
    } else {
      process.env.WIRE_HOME = previous;
    }
    await rm(wireHome, { recursive: true });
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
      JSON.stringify({ llm: { provider: "openai", model: "user-default" }, browser: { session: { useProxy: true, region: "us-west-1" } } }),
    );
    await writeFile(
      join(projectDir, "wire.json"),
      JSON.stringify({ llm: { model: "project-override" }, browser: { session: { solveCaptcha: true, region: "eu-west-1" } } }),
    );
    const config = await loadConfig(projectDir, userDir);
    assert.equal(config.llm?.provider, "openai");
    assert.equal(config.llm?.model, "project-override");
    assert.equal(config.browser?.session?.useProxy, true);
    assert.equal(config.browser?.session?.solveCaptcha, true);
    assert.equal(config.browser?.session?.region, "eu-west-1");
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
      JSON.stringify({ llm: { provider: "anthropic", model: "user-default" } }),
    );
    await writeFile(join(projectDir, "wire.json"), "{}");
    const config = await loadConfig(projectDir, userDir);
    assert.equal(config.llm?.provider, "anthropic");
    assert.equal(config.llm?.model, "user-default");
  } finally {
    await rm(userDir, { recursive: true });
    await rm(projectDir, { recursive: true });
  }
});

test("loadConfig preserves legacy root model fields", async () => {
  const dir = await makeIsolatedDir();
  try {
    await writeFile(join(dir, "wire.json"), JSON.stringify({ model: "gpt-5.4-mini", provider: "openai" }));
    const config = await loadConfig(dir, dir);
    assert.equal(config.provider, "openai");
    assert.equal(config.model, "gpt-5.4-mini");
  } finally {
    await rm(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// Z.ai provider and baseUrl
// ---------------------------------------------------------------------------

test("resolveLlmConfig accepts zai provider and resolves baseUrl precedence", () => {
  const config = resolveLlmConfig(
    "zai",
    undefined,
    undefined,
    undefined,
    { llm: { provider: "openai", baseUrl: "https://config.example.com/v1" } },
    "https://cli.example.com/v1",
    "https://env.example.com/v1",
  );
  assert.equal(config.provider, "zai");
  assert.equal(config.baseUrl, "https://cli.example.com/v1");
});

test("resolveLlmConfig falls back to env baseUrl then config baseUrl", () => {
  const fromEnv = resolveLlmConfig(
    undefined,
    undefined,
    undefined,
    undefined,
    { llm: { baseUrl: "https://config.example.com/v1" } },
    undefined,
    "https://env.example.com/v1",
  );
  assert.equal(fromEnv.baseUrl, "https://env.example.com/v1");

  const fromConfig = resolveLlmConfig(
    undefined,
    undefined,
    undefined,
    undefined,
    { llm: { baseUrl: "https://config.example.com/v1" } },
  );
  assert.equal(fromConfig.baseUrl, "https://config.example.com/v1");
});

test("loadConfig reads zai provider and llm.baseUrl from wire.json", async () => {
  const dir = await makeIsolatedDir();
  try {
    await writeFile(join(dir, "wire.json"), JSON.stringify({
      llm: { provider: "zai", model: "glm-4.7", baseUrl: "https://api.z.ai/api/anthropic/v1" },
    }));
    const config = await loadConfig(dir, dir);
    assert.equal(config.llm?.provider, "zai");
    assert.equal(config.llm?.model, "glm-4.7");
    assert.equal(config.llm?.baseUrl, "https://api.z.ai/api/anthropic/v1");
  } finally {
    await rm(dir, { recursive: true });
  }
});
