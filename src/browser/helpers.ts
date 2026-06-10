
/**
 * Plain browser-side JavaScript helpers available in every exec code block.
 * These are function definitions only — they execute only when called.
 * Thin by design: if a helper hides causal structure, write querySelector directly.
 */
export const DEFAULT_HELPER_SOURCE = `
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


const FORBIDDEN_HELPER_PATTERNS = [
  /\brequire\s*\(/u,
  /\bprocess\s*\./u,
  /\bBuffer\s*\./u,
  /\b__dirname\b/u,
  /\b__filename\b/u,
  /\bimport\s+[^("'`]/u,
];

const EXPORT_KEYWORD_PATTERN =
  /^\s*export\s+(?=(?:async\s+)?function\b|class\b|const\b|let\b|var\b)/gmu;

/**
 * Convert a browser helper module into executable page-context code.
 *
 * The runtime accepts JS-compatible module source so helper edits remain
 * inspectable. We strip top-level `export` keywords because CDP evaluates the
 * helpers as a script preamble inside the async exec wrapper.
 */
export function helperSourceToPreamble(source: string): string {
  return source.trimStart().replace(EXPORT_KEYWORD_PATTERN, "");
}

export function validateHelperSource(source: string): { ok: true } | { ok: false; reason: string } {
  if (source.trim().length === 0) {
    return { ok: false, reason: "helper source is empty" };
  }

  for (const pattern of FORBIDDEN_HELPER_PATTERNS) {
    if (pattern.test(source)) {
      return { ok: false, reason: `helper source uses forbidden pattern ${pattern.source}` };
    }
  }

  try {
    // Validate after export stripping. Wrapping mirrors provider execution.
    // eslint-disable-next-line no-new-func
    new Function(`return (async () => {\n${helperSourceToPreamble(source)}\n})();`);
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  return { ok: true };
}

function diffLines(before: string, after: string): string {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const lines = ["--- helpers/before.js", "+++ helpers/after.js"];
  const max = Math.max(beforeLines.length, afterLines.length);

  for (let i = 0; i < max; i++) {
    const oldLine = beforeLines[i];
    const newLine = afterLines[i];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) lines.push(`-${oldLine}`);
    if (newLine !== undefined) lines.push(`+${newLine}`);
  }

  return lines.join("\n");
}

export function createHelperDiff(before: string, after: string): string {
  return diffLines(before.trimEnd(), after.trimEnd());
}

/**
 * Prepend browser-side helpers before user-authored exec code.
 * The combined string runs inside the provider's async IIFE wrapper.
 */
export function prependHelpers(code: string, helperSource: string = DEFAULT_HELPER_SOURCE): string {
  return `${helperSourceToPreamble(helperSource)}\n${code}`;
}
