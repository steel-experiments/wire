// ABOUTME: Provider-agnostic LLM contract — message shapes, the LLMProvider
// ABOUTME: interface, and typed errors shared by every concrete provider.

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
  readonly model: string;
  readonly reasoningEffort?: string | undefined;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<ChatResponse>;
}

// Typed errors

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
