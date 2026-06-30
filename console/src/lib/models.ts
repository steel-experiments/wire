// ABOUTME: Curated LLM choices for the composer's model switcher.
// ABOUTME: Each maps to a Wire provider+model; "Wire default" sends neither.

export interface ModelOption {
  label: string;
  provider?: string;
  model?: string;
}

export const MODELS: ModelOption[] = [
  { label: "GLM-5.1", provider: "zai", model: "glm-5.1" },
  { label: "GLM-4.7", provider: "zai", model: "glm-4.7" },
  { label: "Claude Sonnet 4.6", provider: "anthropic", model: "claude-sonnet-4-6" },
  { label: "GPT-5.4-mini", provider: "openai", model: "gpt-5.4-mini" },
  { label: "Wire default (.env)", provider: undefined, model: undefined },
];

export const DEFAULT_MODEL_LABEL = "GLM-5.1";

export function modelByLabel(label: string): ModelOption {
  return MODELS.find((m) => m.label === label) ?? MODELS[0]!;
}
