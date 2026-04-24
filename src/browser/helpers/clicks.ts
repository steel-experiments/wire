// ---------------------------------------------------------------------------
// Thin click helpers — generate JS code strings for browser.exec()
// ---------------------------------------------------------------------------

/**
 * Generate JS code that clicks an element by its visible text content.
 *
 * Searches all elements matching `tag` for one whose trimmed textContent
 * equals `text`, then calls `.click()` on it.
 */
export function buildClickByTextCode(text: string, tag = "button"): string {
  const textJson = JSON.stringify(text);
  const tagJson = JSON.stringify(tag);

  return `
const elements = document.querySelectorAll(${tagJson});
const target = Array.from(elements).find(el => el.textContent?.trim() === ${textJson});
if (!target) throw new Error('No ' + ${tagJson} + ' found with text: ' + ${textJson});
target.click();
`.trim();
}

/**
 * Generate JS code that clicks an element by CSS selector.
 *
 * Queries the document for `selector` and clicks the first match.
 */
export function buildClickBySelectorCode(selector: string): string {
  const selectorJson = JSON.stringify(selector);

  return `
const target = document.querySelector(${selectorJson});
if (!target) throw new Error('No element found for selector: ' + ${selectorJson});
target.click();
`.trim();
}
