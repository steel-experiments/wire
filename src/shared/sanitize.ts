// ABOUTME: Prompt-hygiene filters for untrusted text (page content, skill
// ABOUTME: guidance) injected into prompts. Shared by agent and skills.

const INJECTION_LINE_PATTERN = /^(system|ignore previous|disregard|forget)\b/iu;
const SYSTEM_TAG_PATTERN = /<system>[\s\S]*?<\/system>/giu;
const SKILL_GUIDANCE_CHAR_LIMIT = 1000;

export function stripInjectionPatterns(text: string): string {
  let result = text.replace(SYSTEM_TAG_PATTERN, "");
  result = result
    .split("\n")
    .filter((line) => !INJECTION_LINE_PATTERN.test(line))
    .join("\n");
  return result;
}

export function sanitizeSkillContent(text: string): string {
  return stripInjectionPatterns(text).slice(0, SKILL_GUIDANCE_CHAR_LIMIT);
}
