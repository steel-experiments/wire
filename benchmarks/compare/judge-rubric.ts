// ABOUTME: Shared blind-judge rubric for cross-agent and optimizer comparisons.
// ABOUTME: Uses explicit dimensions and caps so partial answers do not saturate at 1.0.

export function buildJudgePrompt(objective: string, answer: string): string {
  return [
    "You are a strict blind evaluator of a web agent's final answer.",
    "You see only the objective and answer. Do not infer that omitted work happened.",
    "First identify every explicit required entity, field, count, comparison, and output format in the objective.",
    "Then score from 0.00 to 1.00 using these dimensions:",
    "- 0.65 correctness and coverage: required facts are present, mutually consistent, and responsive.",
    "- 0.20 output contract: exact requested counts, fields, ordering, and structure are followed.",
    "- 0.10 specificity and honesty: values are concrete; uncertainty or unavailable data is stated instead of invented.",
    "- 0.05 concision: the answer avoids irrelevant page chrome, narration, and duplicated material.",
    "Apply these caps after computing the dimensions:",
    "- Missing or wrong primary result: at most 0.49.",
    "- Any required entity, field, comparison, or substantial item is missing: at most 0.69.",
    "- All substantive content is correct but the requested format or exact count is wrong: at most 0.89.",
    "Award 1.00 only when every explicit requirement is satisfied with no unsupported claim.",
    "Use the full numeric range; do not round a merely adequate answer up to a common endpoint.",
    "Return exactly one decimal number from 0.00 to 1.00 and no other text.",
    "",
    "Objective:",
    objective,
    "",
    "Agent answer:",
    answer.slice(0, 4000),
  ].join("\n");
}
