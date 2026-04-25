// ---------------------------------------------------------------------------
// LLM provider contract
// ---------------------------------------------------------------------------

export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface ChatResponse {
  content: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export interface LLMProvider {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

export class LLMProviderError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(`[${provider}] ${message}`);
    this.name = "LLMProviderError";
  }
}

export class LLMNetworkError extends LLMProviderError {
  public override readonly cause: Error;
  constructor(
    provider: string,
    cause: Error,
  ) {
    super(provider, `Network error: ${cause.message}`);
    this.name = "LLMNetworkError";
    this.cause = cause;
  }
}

export class LLMApiError extends LLMProviderError {
  public readonly status: number;
  constructor(
    provider: string,
    status: number,
    message: string,
  ) {
    super(provider, `API error (${status}): ${message}`);
    this.name = "LLMApiError";
    this.status = status;
  }
}

// ---------------------------------------------------------------------------
// OpenAI provider configuration
// ---------------------------------------------------------------------------

export interface OpenAIProviderConfig {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-5.4-mini";

// ---------------------------------------------------------------------------
// OpenAI API response types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly defaultModel: string;

  constructor(config: OpenAIProviderConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    this.defaultModel = config.model ?? DEFAULT_MODEL;
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse> {
    const model = options?.model ?? this.defaultModel;

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

    const url = `${this.baseUrl}/responses`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
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
      throw new LLMNetworkError("openai", err as Error);
    }

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

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

  return new OpenAIProvider(providerConfig);
}
