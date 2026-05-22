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
  return `STALLED: Your last ${noProgress} successful execs returned no usable data (empty payloads, navigation-only, or error-shaped). Stop probing the same way — extract real content (innerText, attributes, structured DOM) or pivot to a different page.`;
}

export function stuckPrompt(sameSig: number, sameResult: number): string {
  return `STUCK: You ran the same exec code ${sameSig} times in a row and got the same result ${sameResult} times. Stop probing — change strategy now or the run will be aborted.`;
}

export function repeatingPrompt(sameSig: number): string {
  return `REPEATING: You ran the same exec code ${sameSig} times in a row. If this isn't progressing, switch to a different selector, action, or approach.`;
}

export const BASE_ACTION_GUIDANCE = [
  "Return exactly one next action as JSON.",
  "Each observation includes a screenshot of the page. Look at it FIRST. If the screenshot shows a modal, banner, cookie wall, tutorial, or overlay blocking the content you need, dismiss it before doing anything else — usually with `await clickVisibleText(\"<button text from the screenshot>\")`.",
  "When the goal needs interacting with a visible element (a button, link, tab), prefer clicking it by its visible label over hand-rolling a DOM selector. Reading the screenshot is faster and more reliable than guessing class names.",
  "The page-summary fields (URL, title, headings, element counts) are orientation only. To read the page's actual text content, use exec (e.g. `return document.body.innerText`).",
  'For "observe", omit payload unless you need {"targetId":"..."}',
  'For "edit-helper", set payload.source to the complete JS-compatible helper module for this task. Use it only when a reusable helper would reduce repeated code in later exec steps.',
  'For "exec", set payload.code to JavaScript that runs in the browser. Code is auto-wrapped as (async () => { YOUR_CODE })(). Do NOT wrap your code in another IIFE; use top-level `return` to output results.',
  'When the user asks to save or produce a file, return an artifact envelope from exec: `{artifacts:[{filename:"result.md",kind:"markdown",mimeType:"text/markdown",content:"..."}],data:{...}}`. Choose the filename, kind, MIME type, and complete file content yourself; this also works for CSV, JSON, TXT, HTML, JS, Python, and other text files.',
  "Each exec call defaults to a 12-second CDP timeout and payload.timeoutMs is capped at 12000. Keep scripts short; avoid sleep/poll loops. For long sequences, split across turns or return wireActions.",
  'For "raw", set payload.method to a CDP method and payload.params to its parameters. Use raw only when exec cannot reach the needed browser behavior.',
  'Use `await wire.click(elOrSelector)` for user-facing clicks that should reach the page as real browser input. Use ordinary DOM APIs for reading, searching, computing, and extraction.',
  "The only `wire.*` page API is `wire.click`. Do not call `wire.goto`, `wire.type`, `wire.navigate`, `wire.press`, or other `wire.*` methods.",
  '"exec" code can return {wireActions: [{method, params}, ...]} to send CDP commands after the code runs. Keep wireActions batches under 80 commands; send another action after reading state.',
  "When DOM clicks fail across iframe, shadow DOM, or cross-origin boundaries, use viewport-coordinate `Input.dispatchMouseEvent` clicks via raw or wireActions.",
  "Prefer direct URL patterns before brittle DOM hunting when the destination is obvious.",
  'For direct navigation, run one exec that only navigates, e.g. `window.location.href = "<url>"; return {navigated:true};`. Do not click, scrape, or read the destination DOM in that same exec.',
  "For `data:` URLs, do not use `window.location.href` from exec. Make the next action a single raw `Page.navigate` with the target URL, then wait for Wire's auto-observe.",
  'Raw `data:` navigation shape: `{"kind":"raw","summary":"Navigate to data URL","payload":{"method":"Page.navigate","params":{"url":"data:..."}}}`.',
  "For web search tasks, use DuckDuckGo (duckduckgo.com) or Bing (bing.com). Google blocks headless browsers with captchas.",
  "Before extracting search result selectors, confirm the current URL is still the search results page. If you opened a result tab/page, switch back to the search target or re-run the search before scraping SERP selectors.",
  "If an observation warns about tab drift or a new tab, choose the intended tab explicitly with observe payload.targetId or exec payload.target {tabId}.",
  "Wire auto-observes after navigation code. Do NOT emit a separate observe after navigating.",
  "After navigation, wait for Wire's auto-observe, then use a separate exec for `wire.click` or extraction on the loaded page.",
  "After navigating to a target page, always exec code to extract the answer before finishing. Navigation alone is not task completion.",
  "Only use finish after your exec code has returned the actual answer in its return value.",
  "Helpers available in every exec block — they are task-local and may be replaced with edit-helper when the current task needs a different thin helper surface:",
  '  • `const btn = [...document.querySelectorAll("button,a,[role=button]")].find(el => /continue|accept/i.test(el.textContent || "")); await wire.click(btn);` — use JS to find a visible target, then `wire.click` for a real browser click.',
  '  • `await clickVisibleText("Skip")` — clicks the first visible button/link whose text contains the argument. Use this to dismiss modals, accept cookies, follow CTAs.',
  '  • `await fillByLabel("Email", "alice@example.com")` — focuses the input matched by <label>, aria-label, or placeholder, sets the value, and fires input/change events.',
  '  • `extractTable("table.results")` — returns a 2D array of cell text from the matched table.',
  '  • `await waitForSelector(".game-container", 5000)` — resolves when the selector appears, rejects after timeoutMs.',
  "These helpers throw a descriptive error if the target is missing — let the throw bubble up so you see what went wrong, then adjust.",
  "Use reusable routes, selectors, waits, and traps from loaded skills when they apply.",
  "Do not wrap the JSON in prose.",
];
