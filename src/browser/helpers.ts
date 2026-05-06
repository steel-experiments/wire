// ABOUTME: Browser-side helper functions injected as a preamble into every exec call.
// ABOUTME: Provides clickVisibleText, fillByLabel, extractTable, waitForSelector as plain JS.

/**
 * Plain browser-side JavaScript helpers available in every exec code block.
 * These are function definitions only — they execute only when called.
 * Thin by design: if a helper hides causal structure, write querySelector directly.
 */
export const HELPER_PREAMBLE = `
async function clickVisibleText(text) {
  const lower = text.toLowerCase().trim();
  const sel = 'button, a, [role="button"], [role="link"], input[type="submit"], input[type="button"], [type="reset"]';
  for (const el of document.querySelectorAll(sel)) {
    const label = (el.textContent || el.value || el.getAttribute('aria-label') || '').toLowerCase().trim();
    if (label.includes(lower)) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) { el.click(); return; }
    }
  }
  throw new Error('clickVisibleText: no visible element with text "' + text + '"');
}

async function fillByLabel(label, value) {
  const lower = label.toLowerCase().trim();
  for (const lEl of document.querySelectorAll('label')) {
    if ((lEl.textContent || '').toLowerCase().includes(lower)) {
      const input = lEl.htmlFor ? document.getElementById(lEl.htmlFor) : lEl.querySelector('input, textarea, select');
      if (input) {
        input.focus();
        if (input.tagName === 'SELECT') {
          for (const opt of input.options) {
            if (opt.text.toLowerCase() === value.toLowerCase()) { opt.selected = true; break; }
          }
        } else {
          input.value = value;
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }
  }
  for (const el of document.querySelectorAll('[aria-label], [placeholder]')) {
    const attr = (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').toLowerCase();
    if (attr.includes(lower)) {
      el.focus();
      el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
  }
  throw new Error('fillByLabel: no input found for label "' + label + '"');
}

function extractTable(selector) {
  const el = document.querySelector(selector);
  if (!el) throw new Error('extractTable: no element for "' + selector + '"');
  return [...el.querySelectorAll('tr')].map(row =>
    [...row.querySelectorAll('th, td')].map(cell => cell.textContent.trim())
  );
}

function waitForSelector(selector, timeoutMs = 5000) {
  const el = document.querySelector(selector);
  if (el) return Promise.resolve(el);
  return new Promise(function(resolve, reject) {
    const obs = new MutationObserver(function() {
      const found = document.querySelector(selector);
      if (found) { obs.disconnect(); resolve(found); }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(function() {
      obs.disconnect();
      reject(new Error('waitForSelector: "' + selector + '" not found within ' + timeoutMs + 'ms'));
    }, timeoutMs);
  });
}
`.trimStart();

/**
 * Prepend browser-side helpers before user-authored exec code.
 * The combined string runs inside the provider's async IIFE wrapper.
 */
export function prependHelpers(code: string): string {
  return `${HELPER_PREAMBLE}\n${code}`;
}
