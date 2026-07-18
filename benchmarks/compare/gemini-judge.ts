const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface GeminiJudgeResult {
  score: number | null;
  note?: string;
}

type FetchLike = (
  input: string | URL | globalThis.Request,
  init?: RequestInit,
) => Promise<Response>;

function interactionText(value: unknown): string {
  if (typeof value !== "object" || value === null) return "";
  const record = value as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  if (!Array.isArray(record.steps)) return "";
  for (let index = record.steps.length - 1; index >= 0; index--) {
    const step = record.steps[index];
    if (typeof step !== "object" || step === null) continue;
    const stepRecord = step as Record<string, unknown>;
    if (stepRecord.type !== "model_output" || !Array.isArray(stepRecord.content)) continue;
    return stepRecord.content
      .flatMap((block) => (
        typeof block === "object"
        && block !== null
        && (block as Record<string, unknown>).type === "text"
        && typeof (block as Record<string, unknown>).text === "string"
          ? [(block as Record<string, unknown>).text as string]
          : []
      ))
      .join("");
  }
  return "";
}

function parseScore(text: string): number | null {
  const normalized = text.trim();
  if (!/^(?:0(?:\.\d+)?|1(?:\.0+)?)$/u.test(normalized)) return null;
  const score = Number(normalized);
  return Number.isFinite(score) && score >= 0 && score <= 1 ? score : null;
}

function diagnostic(error: unknown): string {
  if (error instanceof Error && error.name === "AbortError") return "Gemini judge timed out";
  return "Gemini judge request failed";
}

/**
 * Score one blind objective/answer pair through Gemini's stateless Interactions
 * API. The API key is header-only and provider response bodies never enter
 * diagnostics, so secrets and echoed prompt content cannot leak into results.
 */
export async function judgeWithGemini(input: {
  apiKey: string;
  model: string;
  prompt: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}): Promise<GeminiJudgeResult> {
  if (input.apiKey === "") return { score: null, note: "GEMINI_API_KEY is missing" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const response = await (input.fetchImpl ?? fetch)(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-goog-api-key": input.apiKey,
      },
      body: JSON.stringify({
        model: input.model.replace(/^models\//u, ""),
        input: input.prompt,
        store: false,
        generation_config: {
          temperature: 1,
          max_output_tokens: 65_536,
          top_p: 0.95,
          thinking_level: "high",
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return { score: null, note: `Gemini judge HTTP ${response.status}` };
    }
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_RESPONSE_BYTES) {
      return { score: null, note: "Gemini judge response exceeded 64 KiB" };
    }
    let decoded: unknown;
    try {
      decoded = JSON.parse(body);
    } catch {
      return { score: null, note: "Gemini judge returned malformed JSON" };
    }
    const output = interactionText(decoded);
    const score = parseScore(output);
    return score === null
      ? { score: null, note: "Gemini judge returned an invalid score" }
      : { score };
  } catch (error) {
    return { score: null, note: diagnostic(error) };
  } finally {
    clearTimeout(timer);
  }
}
