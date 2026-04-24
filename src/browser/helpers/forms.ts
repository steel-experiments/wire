// ---------------------------------------------------------------------------
// Thin form-filling helpers — generate JS code strings for browser.exec()
// ---------------------------------------------------------------------------

/**
 * Generate JS code that fills a form field by its label text.
 *
 * The generated code searches for a <label> whose trimmed text content matches
 * `label`, then sets the `.value` of the associated input/textarea and
 * dispatches input + change events so frameworks pick up the change.
 */
export function buildFillByLabelCode(label: string, value: string): string {
  const labelJson = JSON.stringify(label);
  const valueJson = JSON.stringify(value);

  return `
const labels = document.querySelectorAll('label');
const match = Array.from(labels).find(l => l.textContent?.trim() === ${labelJson});
if (!match) throw new Error('No label found with text: ' + ${labelJson});
const forId = match.getAttribute('for');
let input;
if (forId) {
  input = document.getElementById(forId);
} else {
  input = match.querySelector('input, textarea, select');
}
if (!input) throw new Error('No input found for label: ' + ${labelJson});
input.focus();
input.value = ${valueJson};
input.dispatchEvent(new Event('input', { bubbles: true }));
input.dispatchEvent(new Event('change', { bubbles: true }));
`.trim();
}

/**
 * Generate JS code that selects a dropdown option by label text.
 *
 * The generated code finds the <label> matching `label`, locates the
 * associated <select>, sets its value to the <option> whose trimmed text
 * matches `value`, and dispatches a change event.
 */
export function buildSelectByLabelCode(label: string, value: string): string {
  const labelJson = JSON.stringify(label);
  const valueJson = JSON.stringify(value);

  return `
const labels = document.querySelectorAll('label');
const match = Array.from(labels).find(l => l.textContent?.trim() === ${labelJson});
if (!match) throw new Error('No label found with text: ' + ${labelJson});
const forId = match.getAttribute('for');
let select;
if (forId) {
  select = document.getElementById(forId);
} else {
  select = match.querySelector('select');
}
if (!select || select.tagName !== 'SELECT') throw new Error('No select found for label: ' + ${labelJson});
const option = Array.from(select.options).find(o => o.textContent?.trim() === ${valueJson});
if (!option) throw new Error('No option found with text: ' + ${valueJson});
select.value = option.value;
select.dispatchEvent(new Event('change', { bubbles: true }));
`.trim();
}

/**
 * Generate JS code that checks or unchecks a checkbox/radio by label text.
 *
 * The generated code finds the <label> matching `label`, locates the
 * associated <input type="checkbox"> or <input type="radio">, sets its
 * `.checked` property, and dispatches a change event.
 */
export function buildCheckByLabelCode(label: string, checked: boolean): string {
  const labelJson = JSON.stringify(label);
  const checkedJs = checked ? "true" : "false";

  return `
const labels = document.querySelectorAll('label');
const match = Array.from(labels).find(l => l.textContent?.trim() === ${labelJson});
if (!match) throw new Error('No label found with text: ' + ${labelJson});
const forId = match.getAttribute('for');
let input;
if (forId) {
  input = document.getElementById(forId);
} else {
  input = match.querySelector('input[type="checkbox"], input[type="radio"]');
}
if (!input) throw new Error('No checkbox/radio found for label: ' + ${labelJson});
input.checked = ${checkedJs};
input.dispatchEvent(new Event('change', { bubbles: true }));
`.trim();
}
