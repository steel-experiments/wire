import type { SessionConfig } from "../shared/types.js";
import { autoApprovingEngine, createPolicyEngine, type PolicyEngine } from "../policy/engine.js";
import { createSteelActionHandlers, createSteelProvider } from "../providers/browser/steel.js";
import type { LLMProvider } from "../providers/llm/openai.js";
import { createOpenAIProvider } from "../providers/llm/openai.js";
import { createAnthropicProvider, createZaiProvider } from "../providers/llm/anthropic.js";
import type { RuntimeConfig } from "../agent/runtime.js";
import { loadSession, saveSession } from "../storage/sessions.js";
import { saveTraceBlobValue } from "../storage/blobs.js";
import { defaultSkillDir, defaultStorageRoot } from "../shared/paths.js";
import { createConsoleTraceSink } from "../ui/stream.js";
import type { LlmProvider } from "./config.js";

export interface RunOptions {
  objective: string;
  mode?: "task" | "investigate" | "experiment";
  profileId?: string;
  provider?: LlmProvider;
  model?: string;
  baseUrl?: string;
  maxSteps?: number;
  skillDir?: string;
  sessionConfig?: SessionConfig;
  json?: boolean;
  yes?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
  keepSessionOpen?: boolean;
  traceLlmMessages?: boolean;
  criticalPointReview?: boolean;
}

export function resolveSkillDir(
  explicit?: string,
  env: { WIRE_SKILLS?: string } = process.env as { WIRE_SKILLS?: string },
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (env.WIRE_SKILLS !== undefined && env.WIRE_SKILLS.length > 0) return env.WIRE_SKILLS;
  return defaultSkillDir();
}

function inferProviderFromModel(model?: string): LlmProvider | undefined {
  if (!model) return undefined;
  if (/^(gpt-|o[1-9]|o\d|chatgpt-)/u.test(model)) return "openai";
  if (/^claude-/u.test(model)) return "anthropic";
  if (/^glm-/iu.test(model)) return "zai";
  return undefined;
}

export function resolveProviderSelection(provider?: LlmProvider, model?: string): LlmProvider | undefined {
  const inferred = inferProviderFromModel(model);
  if (provider && inferred && provider !== inferred) {
    throw new Error(`Model "${model}" does not match provider "${provider}".`);
  }
  if (provider) return provider;
  if (inferred) return inferred;

  // Key detection reads process.env, which includes .env (loaded at startup).
  // When several keys are present the first match wins; set WIRE_PROVIDER to
  // pick a default explicitly.
  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);
  const hasZai = Boolean(process.env.ZAI_API_KEY);
  if (hasOpenAi) return "openai";
  if (hasAnthropic) return "anthropic";
  if (hasZai) return "zai";
  return undefined;
}

function createLlmProvider(provider?: LlmProvider, model?: string, baseUrl?: string): LLMProvider | undefined {
  const selectedProvider = resolveProviderSelection(provider, model);
  if (!selectedProvider) return undefined;

  const factoryConfig: { model?: string; baseUrl?: string } = {};
  if (model) factoryConfig.model = model;
  if (baseUrl) factoryConfig.baseUrl = baseUrl;

  if (selectedProvider === "openai") {
    return createOpenAIProvider(factoryConfig);
  }
  if (selectedProvider === "anthropic") {
    return createAnthropicProvider(factoryConfig);
  }
  return createZaiProvider(factoryConfig);
}

function defaultMaxSteps(mode: "task" | "investigate" | "experiment"): number {
  switch (mode) {
    case "investigate": return 20;
    case "experiment": return 25;
    default: return 30;
  }
}

export function resolveCriticalPointReview(
  _mode: "task" | "investigate" | "experiment" | undefined,
  explicit: boolean | undefined,
): boolean {
  if (explicit !== undefined) return explicit;
  return true;
}

export function createRuntimeConfig(
  options: Pick<RunOptions, "profileId" | "maxSteps" | "skillDir" | "sessionConfig" | "provider" | "model" | "baseUrl" | "yes" | "json" | "mode" | "verbose" | "quiet" | "color" | "keepSessionOpen" | "traceLlmMessages" | "criticalPointReview">,
): RuntimeConfig {
  let policyEngine: PolicyEngine = createPolicyEngine();
  if (options.yes) {
    policyEngine = autoApprovingEngine(policyEngine);
  }

  const isJson = options.json === true;
  const maxSteps = options.maxSteps ?? defaultMaxSteps(options.mode ?? "task");
  const config: RuntimeConfig = {
    provider: createSteelProvider(),
    actionHandlers: createSteelActionHandlers(),
    policyEngine,
    maxSteps,
    async onSessionCreated(session) {
      const url = session.debugUrl ?? session.liveUrl;
      if (!isJson && url) {
        console.log(`Debug URL:    ${url}`);
        console.log("");
      }
      await saveSession(defaultStorageRoot(), session);
    },
    async onSessionReconfigured({ oldSessionId, newSession, summary }) {
      const url = newSession.debugUrl ?? newSession.liveUrl;
      if (!isJson) {
        console.log(`Session reconfigured: ${summary}`);
        console.log(`Old session: ${oldSessionId}`);
        console.log(`New session: ${newSession.id}`);
        if (url) {
          console.log(`Debug URL:    ${url}`);
        }
        console.log("");
      }
      await saveSession(defaultStorageRoot(), newSession);
    },
    async onSessionEnded({ sessionId, status }) {
      const root = defaultStorageRoot();
      const session = await loadSession(root, sessionId).catch(() => undefined);
      if (!session) return;
      await saveSession(root, { ...session, status });
    },
  };

  if (options.keepSessionOpen) config.keepSessionOpen = true;
  if (resolveCriticalPointReview(options.mode, options.criticalPointReview)) {
    config.criticalPointReview = true;
  }
  if (options.traceLlmMessages === true || process.env.WIRE_TRACE_LLM_MESSAGES === "1") {
    config.traceLlmMessages = true;
    config.saveTraceBlob = async (runId, kind, value, contentType) => {
      const blob = await saveTraceBlobValue(defaultStorageRoot(), runId, kind, value, contentType);
      return { hash: blob.hash, size: blob.size, kind: blob.kind };
    };
  }

  if (!isJson && options.quiet !== true) {
    const sinkOpts: Parameters<typeof createConsoleTraceSink>[0] = { maxSteps };
    if (options.verbose !== undefined) sinkOpts.verbose = options.verbose;
    if (options.color !== undefined) sinkOpts.color = options.color;
    const consoleSink = createConsoleTraceSink(sinkOpts);
    config.traceSink = { onEvent: (event) => consoleSink.onEvent(event) };
  }

  const llmProvider = createLlmProvider(options.provider, options.model, options.baseUrl);
  if (llmProvider) {
    config.llmProvider = llmProvider;
  }
  config.skillDir = resolveSkillDir(options.skillDir);
  config.sessionInput = { timeoutMinutes: Math.max(15, Math.ceil(maxSteps * 30 / 60)) };
  if (options.profileId || options.sessionConfig) {
    if (options.profileId) config.sessionInput.profileId = options.profileId as never;
    if (options.sessionConfig) config.sessionInput.sessionConfig = options.sessionConfig;
  }

  return config;
}
