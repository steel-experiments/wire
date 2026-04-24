// ---------------------------------------------------------------------------
// LLM provider contract
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

interface OpenAIChatChoice {
  message: { role: string; content: string };
  finish_reason: string;
}

interface OpenAIChatUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

interface OpenAIChatResponse {
  id: string;
  object: string;
  model: string;
  choices: OpenAIChatChoice[];
  usage?: OpenAIChatUsage;
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

    const body: Record<string, unknown> = {
      model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    };

    if (options?.temperature !== undefined) {
      body.temperature = options.temperature;
    }

    if (options?.maxTokens !== undefined) {
      body.max_tokens = options.maxTokens;
    }

    const url = `${this.baseUrl}/chat/completions`;
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

    const data = (await response.json()) as OpenAIChatResponse;

    const choice = data.choices[0];
    if (!choice) {
      throw new LLMApiError("openai", response.status, "No choices returned");
    }

    const result: ChatResponse = {
      content: choice.message.content,
      model: data.model,
    };

    if (data.usage) {
      result.usage = {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
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
