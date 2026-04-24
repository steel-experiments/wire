// ---------------------------------------------------------------------------
// Thin table extraction helper — generate JS code string for browser.exec()
// ---------------------------------------------------------------------------

/**
 * Generate JS code that extracts all rows and cells from a <table> as string[][].
 *
 * The generated code queries for `selector`, walks every <tr> in the table,
 * and collects the trimmed textContent of each <td>/<th> cell.
 * The result is returned as a JSON-serialisable string[][] array.
 */
export function buildExtractTableCode(selector: string): string {
  const selectorJson = JSON.stringify(selector);

  return `
const table = document.querySelector(${selectorJson});
if (!table || table.tagName !== 'TABLE') throw new Error('No table found for selector: ' + ${selectorJson});
const rows = table.querySelectorAll('tr');
const result = Array.from(rows).map(row => {
  const cells = row.querySelectorAll('td, th');
  return Array.from(cells).map(cell => cell.textContent?.trim() ?? '');
});
return JSON.stringify(result);
`.trim();
}
