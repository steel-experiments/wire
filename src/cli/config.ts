import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import type { JsonObject, SessionConfig } from "../shared/types.js";

// Config types

export type LlmProvider = "openai" | "anthropic";

export interface LlmConfig {
  provider?: LlmProvider;
  model?: string;
}

export interface WireConfig {
  llm?: LlmConfig;
  browser?: { session?: SessionConfig };
  provider?: LlmProvider;
  model?: string;
}

// readConfigFile — reads a JSON config file, returns {} on missing/invalid

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeProvider(value: unknown): LlmProvider | undefined {
  return value === "openai" || value === "anthropic" ? value : undefined;
}

function normalizeSessionConfig(raw: unknown): SessionConfig | undefined {
  if (!isRecord(raw)) return undefined;

  const session: SessionConfig = {};
  if (typeof raw["useProxy"] === "boolean") session.useProxy = raw["useProxy"];
  if (isRecord(raw["useProxy"])) {
    const proxy: NonNullable<Exclude<SessionConfig["useProxy"], boolean>> = {};
    if (isRecord(raw["useProxy"]["geolocation"]) && typeof raw["useProxy"]["geolocation"]["country"] === "string") {
      proxy.geolocation = { country: raw["useProxy"]["geolocation"]["country"] };
    }
    if (typeof raw["useProxy"]["server"] === "string") proxy.server = raw["useProxy"]["server"];
    if (proxy.geolocation || proxy.server) session.useProxy = proxy;
  }
  if (typeof raw["solveCaptcha"] === "boolean") session.solveCaptcha = raw["solveCaptcha"];
  if (typeof raw["stealth"] === "boolean") session.stealth = raw["stealth"];
  if (typeof raw["userAgent"] === "string") session.userAgent = raw["userAgent"];
  if (typeof raw["region"] === "string") session.region = raw["region"];
  if (typeof raw["locale"] === "string") session.locale = raw["locale"];
  if (typeof raw["timezone"] === "string") session.timezone = raw["timezone"];
  if (isRecord(raw["viewport"]) && typeof raw["viewport"]["width"] === "number" && typeof raw["viewport"]["height"] === "number") {
    session.viewport = { width: raw["viewport"]["width"], height: raw["viewport"]["height"] };
  }
  if (isRecord(raw["providerOptions"])) {
    session.providerOptions = raw["providerOptions"] as JsonObject;
  }
  return Object.keys(session).length > 0 ? session : undefined;
}

function normalizeConfig(raw: unknown): WireConfig {
  if (!isRecord(raw)) {
    return {};
  }

  const config: WireConfig = {};

  if (typeof raw["model"] === "string") {
    config.model = raw["model"];
  }

  const provider = normalizeProvider(raw["provider"]);
  if (provider) {
    config.provider = provider;
  }

  if (isRecord(raw["llm"])) {
    const llm: LlmConfig = {};
    const llmProvider = normalizeProvider(raw["llm"]["provider"]);
    if (llmProvider) {
      llm.provider = llmProvider;
    }
    if (typeof raw["llm"]["model"] === "string") {
      llm.model = raw["llm"]["model"];
    }
    if (llm.provider || llm.model) {
      config.llm = llm;
    }
  }

  if (isRecord(raw["browser"])) {
    const session = normalizeSessionConfig(raw["browser"]["session"]);
    if (session) config.browser = { session };
  }

  return config;
}

async function readConfigFile(path: string, strict?: boolean): Promise<WireConfig> {
  try {
    const raw = await readFile(path, "utf-8");
    try {
      return normalizeConfig(JSON.parse(raw) as unknown);
    } catch {
      if (strict) {
        throw new Error(`Invalid JSON in config file: ${path}`);
      }
      return {};
    }
  } catch (err) {
    if (strict && (err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
    return {};
  }
}

// loadConfig — merges user-level ~/.wire/config.json with project wire.json
// Project config overrides user-level defaults.

export async function loadConfig(dir?: string, userDir?: string, strict?: boolean): Promise<WireConfig> {
  const userHome = userDir ?? homedir();
  const user = await readConfigFile(resolve(userHome, ".wire", "config.json"), strict);
  const project = await readConfigFile(resolve(dir ?? process.cwd(), "wire.json"), strict);

  if (strict) {
    const userEmpty = Object.keys(user).length === 0;
    const projectEmpty = Object.keys(project).length === 0;
    if (userEmpty && projectEmpty) {
      throw new Error("No Wire configuration found. Create wire.json or ~/.wire/config.json.");
    }
  }
  const merged: WireConfig = {
    ...user,
    ...project,
  };

  const llm = {
    ...(user.llm ?? {}),
    ...(project.llm ?? {}),
  };

  if (llm.provider || llm.model) {
    merged.llm = llm;
  }

  const session = {
    ...(user.browser?.session ?? {}),
    ...(project.browser?.session ?? {}),
  };
  if (Object.keys(session).length > 0) {
    merged.browser = { session };
  }

  return merged;
}

// resolveLlmConfig — CLI flag > env var > config file > legacy config

export function resolveLlmConfig(
  cliProvider?: LlmProvider,
  cli?: string,
  envProvider?: LlmProvider,
  env?: string,
  config?: WireConfig,
): LlmConfig {
  const provider = cliProvider ?? envProvider ?? config?.llm?.provider ?? config?.provider;
  const model = cli ?? env ?? config?.llm?.model ?? config?.model;

  const resolved: LlmConfig = {};
  if (provider) {
    resolved.provider = provider;
  }
  if (model) {
    resolved.model = model;
  }
  return resolved;
}
