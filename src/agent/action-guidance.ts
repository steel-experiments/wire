export type ActionGuidanceHome = "core" | "helper" | "skill";

export interface ActionGuidanceItem {
  id: string;
  home: ActionGuidanceHome;
  /** Ships only when the named runtime signal is active; absent = always. */
  when?: "query-echo" | "nav-404";
  text: string;
}

export const ACTION_GUIDANCE_ITEMS: ActionGuidanceItem[] = [
  {
    id: "return-json-action",
    home: "core",
    text: "Return exactly one next action as JSON.",
  },
  {
    id: "screenshot-first",
    home: "core",
    text: "Each observation includes a screenshot of the page. Look at it FIRST. If the screenshot shows a modal, banner, cookie wall, tutorial, or overlay blocking the content you need, dismiss it before doing anything else — usually with `await clickVisibleText(\"<button text from the screenshot>\")`.",
  },
  {
    id: "visible-label-clicks",
    home: "core",
    text: "When the goal needs interacting with a visible element (a button, link, tab), prefer clicking it by its visible label over hand-rolling a DOM selector. Reading the screenshot is faster and more reliable than guessing class names.",
  },
  {
    id: "page-summary-is-orientation",
    home: "core",
    text: "The page-summary fields (URL, title, headings, element counts, bounded link samples) are orientation and compact interaction affordances only. To read the page's actual text content, use exec (e.g. `return document.body.innerText`).",
  },
  {
    id: "observe-payload",
    home: "core",
    text: 'For "observe", omit payload unless you need {"targetId":"..."}',
  },
  {
    id: "edit-helper",
    home: "helper",
    text: 'For "edit-helper", set payload.source to the complete JS-compatible helper module for this task. Use it only when a reusable helper would reduce repeated code in later exec steps.',
  },
  {
    id: "exec-code-shape",
    home: "core",
    text: 'For "exec", set payload.code to JavaScript that runs in the browser. Code is auto-wrapped as (async () => { YOUR_CODE })(). Do NOT wrap your code in another IIFE; use top-level `return` to output results.',
  },
  {
    id: "artifact-envelope",
    home: "core",
    text: 'When the user asks to save or produce a file, return an artifact envelope from exec: `{artifacts:[{filename:"result.md",kind:"markdown",mimeType:"text/markdown",content:"..."}],data:{...}}`. Choose the filename, kind, MIME type, and complete file content yourself; this also works for CSV, JSON, TXT, HTML, JS, Python, and other text files.',
  },
  {
    id: "progress-ledger-envelope",
    home: "core",
    text: 'For multi-source, list/table, or repeated-unit tasks, preserve task-specific evidence across turns by returning a progress ledger from exec. Wire recognizes exactly these top-level envelope keys: `progress`, `progressLedger`, or `ledger`. Each value can be one entry or an array of entries. Example: `{progress:[{key:"vendor-a", fields:{name:"Vendor A", price:"$19", plan:"Starter"}, evidence:"Pricing table row under Starter plan"}], data:{extractedCount:1}}`. Use your own fields from the objective; Wire stores them without interpreting site-specific data. Do not invent alternate envelope keys: custom envelope names are invisible to the progress ledger system.',
  },
  {
    id: "exec-timeout",
    home: "core",
    text: "Each exec call defaults to a 12-second CDP timeout and payload.timeoutMs is capped at 12000. Keep scripts short; avoid sleep/poll loops. For long sequences, split across turns or return wireActions.",
  },
  {
    id: "raw-cdp",
    home: "core",
    text: 'For "raw", set payload.method to a CDP method and payload.params to its parameters. Use raw only when exec cannot reach the needed browser behavior.',
  },
  {
    id: "wire-click",
    home: "core",
    text: "Use `await wire.click(elOrSelector)` for user-facing clicks that should reach the page as real browser input. Use ordinary DOM APIs for reading, searching, computing, and extraction.",
  },
  {
    id: "wire-click-only",
    home: "core",
    text: "The only `wire.*` page API is `wire.click`. Do not call `wire.goto`, `wire.type`, `wire.navigate`, `wire.press`, or other `wire.*` methods.",
  },
  {
    id: "wire-actions-batch",
    home: "core",
    text: '"exec" code can return {wireActions: [{method, params}, ...]} to send CDP commands after the code runs. Keep wireActions batches under 80 commands; send another action after reading state.',
  },
  {
    id: "coordinate-input",
    home: "core",
    text: "When DOM clicks fail across iframe, shadow DOM, or cross-origin boundaries, use viewport-coordinate `Input.dispatchMouseEvent` clicks via raw or wireActions.",
  },
  {
    id: "direct-url-patterns",
    home: "core",
    text: "Use direct navigation only when the URL is grounded in the user's request, a loaded skill, an observed or extracted href, or a route pattern already verified on this site. Do not synthesize a route merely because its slug seems obvious.",
  },
  {
    id: "nav-404-recovery",
    home: "core",
    when: "nav-404",
    text: "The current observation is a not-found landing. Do not guess or synthesize another URL. Return to the last working page (for example with `history.back()`), then enumerate or click a visible on-page link, use a loaded skill, or use the site's own search/navigation. Navigate directly only to a target grounded in an observed href or loaded skill.",
  },
  {
    id: "direct-navigation-exec",
    home: "core",
    text: 'For direct navigation, run one exec that only navigates, e.g. `window.location.href = "<url>"; return {navigated:true};`. Do not click, scrape, or read the destination DOM in that same exec.',
  },
  {
    id: "data-url-raw",
    home: "core",
    text: "For `data:` URLs, do not use `window.location.href` from exec. Make the next action a single raw `Page.navigate` with the target URL, then wait for Wire's auto-observe.",
  },
  {
    id: "data-url-raw-shape",
    home: "core",
    text: 'Raw `data:` navigation shape: `{"kind":"raw","summary":"Navigate to data URL","payload":{"method":"Page.navigate","params":{"url":"data:..."}}}`.',
  },
  {
    id: "search-engine-choice",
    home: "core",
    text: "For web search tasks, use DuckDuckGo (duckduckgo.com) or Bing (bing.com). Google blocks headless browsers with captchas.",
  },
  {
    id: "serp-target-check",
    home: "core",
    text: "Before extracting search result selectors, confirm the current URL is still the search results page. If you opened a result tab/page, switch back to the search target or re-run the search before scraping SERP selectors.",
  },
  {
    id: "query-echo-trap",
    home: "core",
    when: "query-echo",
    text: "Your latest result mostly reflects your own search query back (query-echo). Pages titled with your exact query are almost certainly auto-generated result farms, not sources. Do not extract from them and do not chase further such results — pick a different result, a direct authoritative site, or refine the query.",
  },
  {
    id: "tab-drift",
    home: "core",
    text: "If an observation warns about tab drift or a new tab, choose the intended tab explicitly with observe payload.targetId or exec payload.target {tabId}.",
  },
  {
    id: "auto-observe-after-navigation",
    home: "core",
    text: "Wire auto-observes after navigation code. Do NOT emit a separate observe after navigating.",
  },
  {
    id: "separate-post-navigation-action",
    home: "core",
    text: "After navigation, wait for Wire's auto-observe, then use a separate exec for `wire.click` or extraction on the loaded page.",
  },
  {
    id: "extract-after-navigation",
    home: "core",
    text: "After navigating to a target page, always exec code to extract the answer before finishing. Navigation alone is not task completion.",
  },
  {
    id: "wait-before-extract",
    home: "helper",
    text: 'When extracting content that renders after load, begin the extraction exec with `await waitForSelector("<content selector>", 5000)` and read the DOM only after it resolves; scraping before the content appears is a common cause of empty results.',
  },
  {
    id: "finish-after-answer",
    home: "core",
    text: "Only use finish after your exec code has returned the actual answer in its return value.",
  },
  {
    id: "helper-section-intro",
    home: "helper",
    text: "Helpers available in every exec block — they are task-local and may be replaced with edit-helper when the current task needs a different thin helper surface:",
  },
  {
    id: "helper-wire-click-example",
    home: "helper",
    text: '  • `const btn = [...document.querySelectorAll("button,a,[role=button]")].find(el => /continue|accept/i.test(el.textContent || "")); await wire.click(btn);` — use JS to find a visible target, then `wire.click` for a real browser click.',
  },
  {
    id: "helper-click-visible-text",
    home: "helper",
    text: '  • `await clickVisibleText("Skip")` — clicks the first visible button/link whose text contains the argument. Use this to dismiss modals, accept cookies, follow CTAs.',
  },
  {
    id: "helper-fill-by-label",
    home: "helper",
    text: '  • `await fillByLabel("Email", "alice@example.com")` — focuses the input matched by <label>, aria-label, or placeholder, sets the value, and fires input/change events.',
  },
  {
    id: "helper-extract-table",
    home: "helper",
    text: '  • `extractTable("table.results")` — returns a 2D array of cell text from the matched table.',
  },
  {
    id: "helper-wait-for-selector",
    home: "helper",
    text: '  • `await waitForSelector("main, article, [data-loaded]", 5000)` — resolves when the selector appears, rejects after timeoutMs.',
  },
  {
    id: "helper-errors",
    home: "helper",
    text: "These helpers throw a descriptive error if the target is missing — let the throw bubble up so you see what went wrong, then adjust.",
  },
  {
    id: "loaded-skill-guidance",
    home: "skill",
    text: "Use reusable routes, selectors, waits, and traps from loaded skills when they apply.",
  },
  {
    id: "json-no-prose",
    home: "core",
    text: "Do not wrap the JSON in prose.",
  },
];

export const BASE_ACTION_GUIDANCE = ACTION_GUIDANCE_ITEMS.map((item) => item.text);

// The `home` tag is load-bearing: core items always ship; helper items ship
// because the helper preamble is unconditionally available in exec; skill
// items ship only when skills are actually loaded — guidance about skills a
// run doesn't have is prompt soup. `when`-tagged items ship only while their
// runtime signal is active, for the same reason.
export function actionGuidanceTexts(options: {
  skillsLoaded: boolean;
  queryEchoDetected?: boolean;
  nav404Detected?: boolean;
}): string[] {
  return ACTION_GUIDANCE_ITEMS
    .filter((item) => item.home !== "skill" || options.skillsLoaded)
    .filter((item) => item.when !== "query-echo" || options.queryEchoDetected === true)
    .filter((item) => item.when !== "nav-404" || options.nav404Detected === true)
    .map((item) => item.text);
}
