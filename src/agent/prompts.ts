export const ACTIVE_BROWSER_SYSTEM_GUIDANCE =
  "You have an active browser session. You MUST interact with the browser to complete tasks — never answer from prior knowledge.";

export const USER_MESSAGE_GUIDANCE = {
  redirected: "The user redirected the task. Follow the new objective above as the primary goal.",
  direct:
    "These are direct instructions from the user. Treat them as authoritative " +
    "for plan adjustments unless they conflict with the policy engine.",
} as const;

export const LOADED_SKILLS_GUIDANCE =
  "Loaded skills:\nSite-specific; follow their Workflow and Traps before guessing.";

export const NO_CONTEXT_PROMPT = "No context available yet. Proceed with the task objective.";

export const STATE_UNCHANGED_WARNING =
  "WARNING: Your last 2+ actions had no effect. Try a different approach: raw CDP input (Input.dispatchKeyEvent for trusted keypresses), click a specific element, or inspect the DOM more carefully.";

export function stalledPrompt(noProgress: number): string {
  return `STALLED: Your last ${noProgress} successful execs returned no usable data (empty payloads, navigation-only, or error-shaped). Stop probing the same way — extract real content (innerText, attributes, structured DOM), or return to the last working page and pivot via an observed on-page link, a loaded skill, or site search. Do not invent another URL.`;
}

export function stuckPrompt(sameSig: number, sameResult: number): string {
  return `STUCK: You ran the same exec code ${sameSig} times in a row and got the same result ${sameResult} times. Stop probing — change strategy now or the run will be aborted.`;
}

export function repeatingPrompt(sameSig: number): string {
  return `REPEATING: You ran the same exec code ${sameSig} times in a row. If this isn't progressing, switch to a different selector, action, or approach.`;
}

export {
  ACTION_GUIDANCE_ITEMS,
  BASE_ACTION_GUIDANCE,
  actionGuidanceTexts,
  type ActionGuidanceHome,
  type ActionGuidanceItem,
} from "./action-guidance.js";
