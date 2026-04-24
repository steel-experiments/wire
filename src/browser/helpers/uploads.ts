// ---------------------------------------------------------------------------
// Thin upload helper — generate JS code string for browser.exec()
// ---------------------------------------------------------------------------

/**
 * Generate JS code that sets a file input's files property.
 *
 * The generated code locates the file input via `selector`, creates a
 * synthetic File object for `filePath` (extracting just the filename),
 * and assigns it to the input's `files` property before dispatching
 * a change event.
 *
 * Note: real file content injection requires CDP or provider-side support.
 * This helper handles the DOM-side mechanics; the provider must supply
 * actual file bytes via the attachments mechanism.
 */
export function buildUploadFileCode(selector: string, filePath: string): string {
  const selectorJson = JSON.stringify(selector);
  // Extract just the filename from the path for the synthetic File object.
  const fileName = filePath.split("/").pop() ?? filePath;
  const fileNameJson = JSON.stringify(fileName);

  return `
const input = document.querySelector(${selectorJson});
if (!input || input.tagName !== 'INPUT' || input.type !== 'file') {
  throw new Error('No file input found for selector: ' + ${selectorJson});
}
const file = new File([], ${fileNameJson}, { type: 'application/octet-stream' });
const dataTransfer = new DataTransfer();
dataTransfer.items.add(file);
input.files = dataTransfer.files;
input.dispatchEvent(new Event('change', { bubbles: true }));
`.trim();
}
