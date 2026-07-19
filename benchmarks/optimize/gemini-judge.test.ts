import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeWithGemini } from "../compare/gemini-judge.ts";

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Gemini blind judge", () => {
  it("uses the stateless Interactions endpoint and parses the final model score", async () => {
    let request: { url: string; init: RequestInit } | undefined;
    const result = await judgeWithGemini({
      apiKey: "fixture-gemini-key",
      model: "models/gemini-3.1-pro-preview",
      prompt: "blind rubric",
      timeoutMs: 1_000,
      fetchImpl: async (url, init = {}) => {
        request = { url: String(url), init };
        return response({
          steps: [{ type: "model_output", content: [{ type: "text", text: "0.84" }] }],
        });
      },
    });

    assert.deepEqual(result, { score: 0.84 });
    assert.match(request!.url, /\/v1beta\/interactions$/u);
    assert.equal((request!.init.headers as Record<string, string>)["x-goog-api-key"], "fixture-gemini-key");
    const body = JSON.parse(String(request!.init.body)) as Record<string, unknown>;
    assert.equal(body.model, "gemini-3.1-pro-preview");
    assert.equal(body.store, false);
    assert.deepEqual(body.generation_config, {
      temperature: 1,
      max_output_tokens: 65_536,
      top_p: 0.95,
      thinking_level: "high",
    });
  });

  it("accepts the REST output_text convenience field", async () => {
    const result = await judgeWithGemini({
      apiKey: "fixture-gemini-key",
      model: "gemini-3.1-pro-preview",
      prompt: "blind rubric",
      timeoutMs: 1_000,
      fetchImpl: async () => response({ output_text: "1.0" }),
    });
    assert.deepEqual(result, { score: 1 });
  });

  it("rejects prose, out-of-range values, malformed JSON, and oversized output", async () => {
    const cases: Array<[Response, string]> = [
      [response({ output_text: "Score: 0.9" }), "invalid score"],
      [response({ output_text: "1.1" }), "invalid score"],
      [new Response("not-json"), "malformed JSON"],
      [new Response(JSON.stringify({ output_text: "0.5", padding: "x".repeat(65_536) })), "exceeded 64 KiB"],
    ];
    for (const [providerResponse, expected] of cases) {
      const result = await judgeWithGemini({
        apiKey: "fixture-gemini-key",
        model: "gemini-3.1-pro-preview",
        prompt: "blind rubric",
        timeoutMs: 1_000,
        fetchImpl: async () => providerResponse,
      });
      assert.equal(result.score, null);
      assert.match(result.note ?? "", new RegExp(expected, "u"));
    }
  });

  it("returns bounded diagnostics without reflecting provider bodies or credentials", async () => {
    const secret = "fixture-secret-do-not-copy";
    const result = await judgeWithGemini({
      apiKey: secret,
      model: "gemini-3.1-pro-preview",
      prompt: "blind rubric",
      timeoutMs: 1_000,
      fetchImpl: async () => new Response(`provider reflected ${secret}`, { status: 429 }),
    });
    assert.deepEqual(result, { score: null, note: "Gemini judge HTTP 429" });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
  });

  it("fails closed when the key is missing or the request fails", async () => {
    assert.deepEqual(await judgeWithGemini({
      apiKey: "",
      model: "gemini-3.1-pro-preview",
      prompt: "blind rubric",
      timeoutMs: 1_000,
    }), { score: null, note: "GEMINI_API_KEY is missing" });

    const failed = await judgeWithGemini({
      apiKey: "fixture-gemini-key",
      model: "gemini-3.1-pro-preview",
      prompt: "blind rubric",
      timeoutMs: 1_000,
      fetchImpl: async () => { throw new Error("network fixture-secret-do-not-copy"); },
    });
    assert.deepEqual(failed, { score: null, note: "Gemini judge request failed" });
  });
});
