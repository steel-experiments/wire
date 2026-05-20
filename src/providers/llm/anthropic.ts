import type { ChatMessage, ChatOptions, ChatResponse, ContentPart, LLMProvider } from "./openai.js";
import { LLMNetworkError, LLMApiError } from "./openai.js";

// Anthropic provider configuration

export type AnthropicReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";

const ANTHROPIC_REASONING_EFFORT_VALUES = ["low", "medium", "high", "xhigh", "max"] as const;

export function parseAnthropicReasoningEffort(value: unknown): AnthropicReasoningEffort | undefined {
  return (ANTHROPIC_REASONING_EFFORT_VALUES as readonly string[]).includes(value as string)
    ? (value as AnthropicReasoningEffort)
    : undefined;
}

export interface AnthropicProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  reasoningEffort?: AnthropicReasoningEffort;
}

const DEFAULT_BASE_URL = "https://api.anthropic.com/v1";
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Anthropic API response types

interface AnthropicContentBlock {
  type: string;
  text?: string;
}

interface AnthropicUsage {
  input_tokens: number;
  output_tokens: number;
}

interface AnthropicMessageResponse {
  id: string;
  type: string;
  role: string;
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: string;
  usage: AnthropicUsage;
}

interface AnthropicErrorResponse {
  error?: { message?: string; type?: string };
}

// Anthropic provider

export class AnthropicProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  public readonly model: string;
  public readonly reasoningEffort: AnthropicReasoningEffort | undefined;

  constructor(config: AnthropicProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.model = config.model ?? DEFAULT_MODEL;
    this.reasoningEffort = config.reasoningEffort;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.model;

    // Anthropic uses a separate system prompt instead of a system message in the array
    let systemPrompt: string | undefined;
    const userMessages: Array<{ role: string; content: string | Array<Record<string, unknown>> }> = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        const text = typeof msg.content === "string"
          ? msg.content
          : msg.content.filter((p): p is { type: "text"; text: string } => p.type === "text").map((p) => p.text).join("");
        systemPrompt = systemPrompt ? `${systemPrompt}\n\n${text}` : text;
      } else if (Array.isArray(msg.content)) {
        // Multimodal content: map to Anthropic's content array format
        const contentParts: Array<Record<string, unknown>> = [];
        for (const part of msg.content) {
          if (part.type === "text" && part.text !== undefined) {
            contentParts.push({ type: "text", text: part.text });
          } else if (part.type === "image_url" && part.image_url !== undefined) {
            const dataUrl = part.image_url.url;
            const base64Match = dataUrl.match(/^data:([^;]+);base64,(.+)$/u);
            if (base64Match) {
              contentParts.push({
                type: "image",
                source: {
                  type: "base64",
                  media_type: base64Match[1],
                  data: base64Match[2],
                },
              });
            }
          }
        }
        userMessages.push({ role: msg.role, content: contentParts });
      } else {
        userMessages.push({ role: msg.role, content: msg.content });
      }
    }

    const body: Record<string, unknown> = {
      model,
      messages: userMessages,
      max_tokens: options?.maxTokens ?? 4096,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (this.reasoningEffort !== undefined) {
      body.thinking = { type: "enabled", effort: this.reasoningEffort };
    }

    const url = `${this.baseUrl}/messages`;
    const headers: Record<string, string> = {
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };

    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new LLMNetworkError("anthropic", err as Error);
    }

    if (!response.ok) {
      let detail: string;
      try {
        const errBody = (await response.json()) as AnthropicErrorResponse;
        detail = errBody.error?.message ?? response.statusText;
      } catch {
        detail = response.statusText;
      }
      throw new LLMApiError("anthropic", response.status, detail);
    }

    const data = (await response.json()) as AnthropicMessageResponse;

    // Concatenate text blocks into a single content string
    const content = data.content
      .filter((block) => block.type === "text" && block.text !== undefined)
      .map((block) => block.text as string)
      .join("");

    const result: ChatResponse = {
      content,
      model: data.model,
      usage: {
        inputTokens: data.usage.input_tokens,
        outputTokens: data.usage.output_tokens,
      },
    };

    return result;
  }
}

// Factory

export function createAnthropicProvider(
  config?: Partial<AnthropicProviderConfig>,
): AnthropicProvider {
  const apiKey = config?.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is required. Set the environment variable or pass apiKey in config.",
    );
  }

  const providerConfig: AnthropicProviderConfig = { apiKey };

  if (config?.baseUrl) {
    providerConfig.baseUrl = config.baseUrl;
  }

  if (config?.model) {
    providerConfig.model = config.model;
  }

  const reasoningEffort = config?.reasoningEffort ?? parseAnthropicReasoningEffort(process.env.ANTHROPIC_REASONING_EFFORT);
  if (reasoningEffort) {
    providerConfig.reasoningEffort = reasoningEffort;
  }

  return new AnthropicProvider(providerConfig);
}
