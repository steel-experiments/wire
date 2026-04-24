import { strict as assert } from "node:assert";
import { test, mock } from "node:test";

import {
  OpenAIProvider,
  createOpenAIProvider,
  LLMApiError,
  LLMNetworkError,
} from "./openai.js";
import type { ChatMessage, ChatOptions } from "./openai.js";
import { AnthropicProvider, createAnthropicProvider } from "./anthropic.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOpenAIResponse(overrides: Record<string, unknown> = {}): Response {
  const body = {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: "gpt-4o",
    choices: [
      {
        message: { role: "assistant", content: "Hello!" },
        finish_reason: "stop",
        index: 0,
      },
    ],
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    },
    ...overrides,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeAnthropicResponse(overrides: Record<string, unknown> = {}): Response {
  const body = {
    id: "msg_test",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello!" }],
    model: "claude-sonnet-4-20250514",
    stop_reason: "end_turn",
    usage: { input_tokens: 10, output_tokens: 5 },
    ...overrides,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function makeMessages(): ChatMessage[] {
  return [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Say hello." },
  ];
}

// ---------------------------------------------------------------------------
// OpenAI — createOpenAIProvider
// ---------------------------------------------------------------------------

test("createOpenAIProvider throws when no apiKey or env var", () => {
  const original = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;

  try {
    assert.throws(() => createOpenAIProvider(), /OPENAI_API_KEY is required/);
  } finally {
    if (original) process.env.OPENAI_API_KEY = original;
  }
});

test("createOpenAIProvider uses config apiKey", () => {
  const provider = createOpenAIProvider({ apiKey: "test-key" });
  assert.ok(provider instanceof OpenAIProvider);
});

test("createOpenAIProvider uses env OPENAI_API_KEY", () => {
  const original = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "env-test-key";

  try {
    const provider = createOpenAIProvider();
    assert.ok(provider instanceof OpenAIProvider);
  } finally {
    if (original) {
      process.env.OPENAI_API_KEY = original;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
  }
});

test("createOpenAIProvider forwards baseUrl and model", () => {
  const provider = createOpenAIProvider({
    apiKey: "test-key",
    baseUrl: "https://custom.api.com/v1",
    model: "gpt-4o-mini",
  });
  assert.ok(provider instanceof OpenAIProvider);
});

// ---------------------------------------------------------------------------
// OpenAI — chat
// ---------------------------------------------------------------------------

test("OpenAIProvider.chat sends messages and returns ChatResponse", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    capturedUrl = input.toString();
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeOpenAIResponse();
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const result = await provider.chat(makeMessages());

    assert.equal(result.content, "Hello!");
    assert.equal(result.model, "gpt-4o");
    assert.ok(result.usage);
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 5);
    assert.ok(capturedUrl.endsWith("/chat/completions"));
    assert.deepEqual(capturedBody.messages, [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Say hello." },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat uses default model when none specified", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeOpenAIResponse();
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    await provider.chat(makeMessages());
    assert.equal(capturedBody.model, "gpt-5.4-mini");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat uses custom model from constructor", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeOpenAIResponse();
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key", model: "gpt-4o-mini" });
    await provider.chat(makeMessages());
    assert.equal(capturedBody.model, "gpt-4o-mini");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat uses model from options over constructor default", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeOpenAIResponse();
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key", model: "gpt-4o" });
    const options: ChatOptions = { model: "gpt-4o-mini" };
    await provider.chat(makeMessages(), options);
    assert.equal(capturedBody.model, "gpt-4o-mini");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat sends temperature and maxTokens when provided", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeOpenAIResponse();
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    await provider.chat(makeMessages(), { temperature: 0.5, maxTokens: 100 });
    assert.equal(capturedBody.temperature, 0.5);
    assert.equal(capturedBody.max_tokens, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat omits temperature and maxTokens when not set", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeOpenAIResponse();
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    await provider.chat(makeMessages());
    assert.equal(capturedBody.temperature, undefined);
    assert.equal(capturedBody.max_tokens, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat throws LLMNetworkError on fetch failure", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("Connection refused");
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    await assert.rejects(
      () => provider.chat(makeMessages()),
      (err: unknown) => err instanceof LLMNetworkError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat throws LLMApiError on non-2xx response", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({ error: { message: "Rate limited" } }),
      { status: 429, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    await assert.rejects(
      () => provider.chat(makeMessages()),
      (err: unknown) => {
        assert.ok(err instanceof LLMApiError);
        assert.equal(err.status, 429);
        assert.ok(err.message.includes("Rate limited"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat throws LLMApiError when no choices returned", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return makeOpenAIResponse({ choices: [] });
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    await assert.rejects(
      () => provider.chat(makeMessages()),
      (err: unknown) => {
        assert.ok(err instanceof LLMApiError);
        assert.ok(err.message.includes("No choices"));
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat uses custom baseUrl", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";

  globalThis.fetch = async (input: string | URL | Request) => {
    capturedUrl = input.toString();
    return makeOpenAIResponse();
  };

  try {
    const provider = new OpenAIProvider({
      apiKey: "test-key",
      baseUrl: "https://proxy.example.com/v1",
    });
    await provider.chat(makeMessages());
    assert.ok(capturedUrl.startsWith("https://proxy.example.com/v1/"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenAIProvider.chat handles missing usage gracefully", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return makeOpenAIResponse({ usage: undefined });
  };

  try {
    const provider = new OpenAIProvider({ apiKey: "test-key" });
    const result = await provider.chat(makeMessages());
    assert.equal(result.usage, undefined);
    assert.equal(result.content, "Hello!");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("LLMProviderError does not expose API key", () => {
  const err = new LLMApiError("openai", 401, "Unauthorized");
  assert.ok(!err.message.includes("test-key"));
  assert.ok(!err.message.includes("sk-"));
});

// ---------------------------------------------------------------------------
// Anthropic — createAnthropicProvider
// ---------------------------------------------------------------------------

test("createAnthropicProvider throws when no apiKey or env var", () => {
  const original = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    assert.throws(() => createAnthropicProvider(), /ANTHROPIC_API_KEY is required/);
  } finally {
    if (original) process.env.ANTHROPIC_API_KEY = original;
  }
});

test("createAnthropicProvider uses config apiKey", () => {
  const provider = createAnthropicProvider({ apiKey: "test-key" });
  assert.ok(provider instanceof AnthropicProvider);
});

test("createAnthropicProvider uses env ANTHROPIC_API_KEY", () => {
  const original = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "env-test-key";

  try {
    const provider = createAnthropicProvider();
    assert.ok(provider instanceof AnthropicProvider);
  } finally {
    if (original) {
      process.env.ANTHROPIC_API_KEY = original;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }
});

// ---------------------------------------------------------------------------
// Anthropic — chat
// ---------------------------------------------------------------------------

test("AnthropicProvider.chat separates system message from user messages", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeAnthropicResponse();
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    await provider.chat(makeMessages());

    // System message should be in the system field, not in messages
    assert.equal(capturedBody.system, "You are a helpful assistant.");
    const msgs = capturedBody.messages as { role: string; content: string }[];
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0]!.role, "user");
    assert.equal(msgs[0]!.content, "Say hello.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat concatenates multiple system messages", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeAnthropicResponse();
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const messages: ChatMessage[] = [
      { role: "system", content: "Part one." },
      { role: "system", content: "Part two." },
      { role: "user", content: "Go." },
    ];
    await provider.chat(messages);

    assert.equal(capturedBody.system, "Part one.\n\nPart two.");
    const msgs = capturedBody.messages as { role: string }[];
    assert.equal(msgs.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat sends correct headers", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return makeAnthropicResponse();
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    await provider.chat(makeMessages());

    assert.equal(capturedHeaders["x-api-key"], "test-key");
    assert.equal(capturedHeaders["anthropic-version"], "2023-06-01");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat returns ChatResponse with usage", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return makeAnthropicResponse();
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const result = await provider.chat(makeMessages());

    assert.equal(result.content, "Hello!");
    assert.ok(result.usage);
    assert.equal(result.usage.inputTokens, 10);
    assert.equal(result.usage.outputTokens, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat concatenates multiple text blocks", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return makeAnthropicResponse({
      content: [
        { type: "text", text: "Part one. " },
        { type: "text", text: "Part two." },
      ],
    });
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    const result = await provider.chat(makeMessages());
    assert.equal(result.content, "Part one. Part two.");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat throws LLMNetworkError on fetch failure", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    throw new Error("Connection refused");
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    await assert.rejects(
      () => provider.chat(makeMessages()),
      (err: unknown) => err instanceof LLMNetworkError,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat throws LLMApiError on non-2xx response", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = async () => {
    return new Response(
      JSON.stringify({ error: { message: "Invalid request" } }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    await assert.rejects(
      () => provider.chat(makeMessages()),
      (err: unknown) => {
        assert.ok(err instanceof LLMApiError);
        assert.equal(err.status, 400);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat sends temperature and maxTokens", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeAnthropicResponse();
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    await provider.chat(makeMessages(), { temperature: 0.7, maxTokens: 200 });
    assert.equal(capturedBody.temperature, 0.7);
    assert.equal(capturedBody.max_tokens, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat uses default max_tokens when not specified", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeAnthropicResponse();
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key" });
    await provider.chat(makeMessages());
    assert.equal(capturedBody.max_tokens, 4096);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat uses custom baseUrl", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";

  globalThis.fetch = async (input: string | URL | Request) => {
    capturedUrl = input.toString();
    return makeAnthropicResponse();
  };

  try {
    const provider = new AnthropicProvider({
      apiKey: "test-key",
      baseUrl: "https://proxy.anthropic.com/v1",
    });
    await provider.chat(makeMessages());
    assert.ok(capturedUrl.startsWith("https://proxy.anthropic.com/v1/"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AnthropicProvider.chat uses custom model from constructor", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> = {};

  globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    capturedBody = JSON.parse(init?.body as string) as Record<string, unknown>;
    return makeAnthropicResponse();
  };

  try {
    const provider = new AnthropicProvider({ apiKey: "test-key", model: "claude-3-haiku-20240307" });
    await provider.chat(makeMessages());
    assert.equal(capturedBody.model, "claude-3-haiku-20240307");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
