// OpenAI provider (Responses API)

import { fetchWithRetry, resolveTransportOptions } from "./transport.js";
import type { TransportOptions } from "./transport.js";
import { LLMApiError, LLMNetworkError, LLMProviderError } from "./types.js";
import type { ChatMessage, ChatOptions, ChatResponse, ContentPart, LLMProvider } from "./types.js";

// Re-export the provider-agnostic contract so existing importers keep working;
// new code should import from ./types.js directly.
export { LLMApiError, LLMNetworkError, LLMProviderError } from "./types.js";
export type { ChatMessage, ChatOptions, ChatResponse, ContentPart, LLMProvider } from "./types.js";

export type OpenAIReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

const OPENAI_REASONING_EFFORT_VALUES = ["none", "low", "medium", "high", "xhigh"] as const;

export function parseOpenAIReasoningEffort(value: unknown): OpenAIReasoningEffort | undefined {
  return (OPENAI_REASONING_EFFORT_VALUES as readonly string[]).includes(value as string)
    ? (value as OpenAIReasoningEffort)
    : undefined;
}

// OpenAI provider configuration

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: OpenAIReasoningEffort;
  timeoutMs?: number;
  maxRetries?: number;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.4-mini";

// OpenAI API response types

interface OpenAIOutputMessage {
  type: "message";
  role: string;
  content: Array<{ type: "output_text"; text: string }>;
}

interface OpenAIResponseUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

interface OpenAIResponse {
  id: string;
  object: string;
  status: string;
  model: string;
  output: OpenAIOutputMessage[];
  usage?: OpenAIResponseUsage;
}

interface OpenAIErrorResponse {
  error?: { message?: string; type?: string; code?: string };
}

// OpenAI provider

export class OpenAIProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  public readonly model: string;
  public readonly reasoningEffort: OpenAIReasoningEffort | undefined;
  private readonly transport: TransportOptions;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.model = config.model ?? DEFAULT_MODEL;
    this.reasoningEffort = config.reasoningEffort;
    this.transport = resolveTransportOptions(
      { timeoutMs: config.timeoutMs, maxRetries: config.maxRetries },
      process.env,
    );
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.model;

    // Separate system messages for the `instructions` field
    const systemParts: string[] = [];
    const input: Array<Record<string, unknown>> = [];
    for (const m of messages) {
      if (m.role === "system") {
        const text = typeof m.content === "string"
          ? m.content
          : m.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
        systemParts.push(text);
      } else if (Array.isArray(m.content)) {
        // Multimodal content: map to OpenAI Responses API input format
        const contentItems: Array<Record<string, unknown>> = [];
        for (const part of m.content) {
          if (part.type === "text" && part.text !== undefined) {
            contentItems.push({ type: "input_text", text: part.text });
          } else if (part.type === "image_url" && part.image_url !== undefined) {
            contentItems.push({ type: "input_image", image_url: part.image_url.url });
          }
        }
        input.push({ role: m.role, content: contentItems });
      } else {
        input.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model,
      input,
    };

    if (systemParts.length > 0) {
      body.instructions = systemParts.join("\n\n");
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (options?.maxTokens !== undefined) {
      body.max_output_tokens = options.maxTokens;
    }

    if (this.reasoningEffort !== undefined && this.reasoningEffort !== "none") {
      body.reasoning = { effort: this.reasoningEffort };
    }

    const url = `${this.baseUrl}/responses`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const response = await fetchWithRetry(
      "openai",
      url,
      { method: "POST", headers, body: JSON.stringify(body) },
      this.transport,
    );

    if (!response.ok) {
      let detail: string;
      try {
        const errBody = (await response.json()) as OpenAIErrorResponse;
        detail = errBody.error?.message ?? response.statusText;
      } catch {
        detail = response.statusText;
      }
      throw new LLMApiError("openai", response.status, detail);
    }

    const data = (await response.json()) as OpenAIResponse;

    const message = data.output.find((o) => o.type === "message");
    if (!message) {
      throw new LLMApiError("openai", response.status, "No message in output");
    }

    const content = message.content
      .filter((c) => c.type === "output_text")
      .map((c) => c.text)
      .join("");

    const result: ChatResponse = {
      content,
      model: data.model,
    };

    if (data.usage) {
      result.usage = {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      };
    }

    return result;
  }
}

// Factory

export function createOpenAIProvider(
  config?: Partial<OpenAIProviderConfig>,
): OpenAIProvider {
  const apiKey = config?.apiKey ?? process.env.OPENAI_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "OPENAI_API_KEY is required. Set the environment variable or pass apiKey in config.",
    );
  }

  const providerConfig: OpenAIProviderConfig = { apiKey };

  if (config?.baseUrl) {
    providerConfig.baseUrl = config.baseUrl;
  }

  if (config?.model) {
    providerConfig.model = config.model;
  }

  const reasoningEffort = config?.reasoningEffort ?? parseOpenAIReasoningEffort(process.env.OPENAI_REASONING_EFFORT);
  if (reasoningEffort) {
    providerConfig.reasoningEffort = reasoningEffort;
  }

  return new OpenAIProvider(providerConfig);
}
