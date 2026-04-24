import { strict as assert } from "node:assert";
import { test } from "node:test";

import { buildFillByLabelCode, buildSelectByLabelCode, buildCheckByLabelCode } from "./forms.js";
import { buildClickByTextCode, buildClickBySelectorCode } from "./clicks.js";
import { buildUploadFileCode } from "./uploads.js";
import { buildExtractTableCode } from "./tables.js";

// ---------------------------------------------------------------------------
// forms.ts — buildFillByLabelCode
// ---------------------------------------------------------------------------

test("buildFillByLabelCode returns code string referencing label and value", () => {
  const code = buildFillByLabelCode("Email", "user@example.com");

  assert.ok(typeof code === "string");
  assert.ok(code.includes('"Email"'));
  assert.ok(code.includes('"user@example.com"'));
  assert.ok(code.includes("querySelectorAll('label')"));
  assert.ok(code.includes(".value ="));
  assert.ok(code.includes("input"));
  assert.ok(code.includes("change"));
});

test("buildFillByLabelCode escapes special characters in label and value", () => {
  const code = buildFillByLabelCode('Name "quoted"', "O'Brien\nnewline");

  // JSON.stringify escapes double quotes but leaves single quotes intact
  assert.ok(code.includes('"Name \\"quoted\\""'));
  assert.ok(code.includes("O'Brien"));
  // JSON.stringify turns the real newline into the two-char escape \n
  assert.match(code, /O'Brien\\nnewline/);
});

test("buildFillByLabelCode dispatches input and change events", () => {
  const code = buildFillByLabelCode("Field", "val");

  assert.match(code, /new Event\('input'/);
  assert.match(code, /new Event\('change'/);
  assert.match(code, /bubbles:\s*true/);
});

test("buildFillByLabelCode throws when label is not found", () => {
  const code = buildFillByLabelCode("Missing", "x");

  assert.match(code, /throw new Error\('No label found with text:/);
});

test("buildFillByLabelCode throws when no input is associated", () => {
  const code = buildFillByLabelCode("Label", "val");

  assert.match(code, /throw new Error\('No input found for label:/);
});

test("buildFillByLabelCode handles label with for attribute", () => {
  const code = buildFillByLabelCode("Email", "test@test.com");

  assert.ok(code.includes("getAttribute('for')"));
  assert.ok(code.includes("getElementById(forId)"));
});

test("buildFillByLabelCode handles label wrapping an input", () => {
  const code = buildFillByLabelCode("Name", "Alice");

  assert.ok(code.includes("querySelector('input, textarea, select')"));
});

test("buildFillByLabelCode calls focus before setting value", () => {
  const code = buildFillByLabelCode("Field", "val");

  const focusIndex = code.indexOf(".focus()");
  const valueIndex = code.indexOf(".value =");
  assert.ok(focusIndex < valueIndex, "focus() should come before value assignment");
});

// ---------------------------------------------------------------------------
// forms.ts — buildSelectByLabelCode
// ---------------------------------------------------------------------------

test("buildSelectByLabelCode returns code string referencing label and option value", () => {
  const code = buildSelectByLabelCode("Country", "United States");

  assert.ok(typeof code === "string");
  assert.ok(code.includes('"Country"'));
  assert.ok(code.includes('"United States"'));
  assert.ok(code.includes("querySelectorAll('label')"));
  assert.ok(code.includes("select.options"));
  assert.ok(code.includes("select.value = option.value"));
});

test("buildSelectByLabelCode escapes special characters", () => {
  const code = buildSelectByLabelCode('Size "large"', '10" x 20"');

  assert.ok(code.includes('"Size \\"large\\""'));
  assert.ok(code.includes('"10\\" x 20\\""'));
});

test("buildSelectByLabelCode throws when select not found", () => {
  const code = buildSelectByLabelCode("Category", "Books");

  assert.match(code, /throw new Error\('No select found for label:/);
});

test("buildSelectByLabelCode throws when option not found", () => {
  const code = buildSelectByLabelCode("Category", "Books");

  assert.match(code, /throw new Error\('No option found with text:/);
});

test("buildSelectByLabelCode dispatches change event", () => {
  const code = buildSelectByLabelCode("Color", "Red");

  assert.match(code, /new Event\('change'/);
  assert.match(code, /bubbles:\s*true/);
});

// ---------------------------------------------------------------------------
// forms.ts — buildCheckByLabelCode
// ---------------------------------------------------------------------------

test("buildCheckByLabelCode returns code string referencing label", () => {
  const code = buildCheckByLabelCode("Accept terms", true);

  assert.ok(typeof code === "string");
  assert.ok(code.includes('"Accept terms"'));
  assert.ok(code.includes("true"));
  assert.ok(code.includes("querySelectorAll('label')"));
  assert.ok(code.includes(".checked = true"));
});

test("buildCheckByLabelCode generates unchecked code when checked is false", () => {
  const code = buildCheckByLabelCode("Newsletter", false);

  assert.ok(code.includes(".checked = false"));
});

test("buildCheckByLabelCode escapes label text", () => {
  const code = buildCheckByLabelCode('I agree "yes"', true);

  assert.ok(code.includes('"I agree \\"yes\\""'));
});

test("buildCheckByLabelCode throws when label not found", () => {
  const code = buildCheckByLabelCode("Missing", true);

  assert.match(code, /throw new Error\('No label found with text:/);
});

test("buildCheckByLabelCode throws when no checkbox found", () => {
  const code = buildCheckByLabelCode("Toggle", true);

  assert.match(code, /throw new Error\('No checkbox\/radio found for label:/);
});

test("buildCheckByLabelCode dispatches change event", () => {
  const code = buildCheckByLabelCode("Subscribe", true);

  assert.match(code, /new Event\('change'/);
});

test("buildCheckByLabelCode searches for checkbox and radio inputs", () => {
  const code = buildCheckByLabelCode("Choice", true);

  assert.ok(code.includes('input[type="checkbox"]'));
  assert.ok(code.includes('input[type="radio"]'));
});

// ---------------------------------------------------------------------------
// clicks.ts — buildClickByTextCode
// ---------------------------------------------------------------------------

test("buildClickByTextCode returns code string with text and default tag", () => {
  const code = buildClickByTextCode("Submit");

  assert.ok(typeof code === "string");
  assert.ok(code.includes('"Submit"'));
  assert.ok(code.includes('"button"'));
  assert.ok(code.includes("querySelectorAll("));
  assert.ok(code.includes(".textContent?.trim()"));
  assert.ok(code.includes(".click()"));
});

test("buildClickByTextCode accepts custom tag", () => {
  const code = buildClickByTextCode("Home", "a");

  assert.ok(code.includes('"a"'));
  assert.ok(code.includes("querySelectorAll("));
});

test("buildClickByTextCode escapes text with special characters", () => {
  const code = buildClickByTextCode('Click "here"');

  assert.ok(code.includes('"Click \\"here\\""'));
});

test("buildClickByTextCode throws when element not found", () => {
  const code = buildClickByTextCode("Missing");

  assert.match(code, /throw new Error/);
  assert.ok(code.includes("No"));
  assert.ok(code.includes("found with text"));
});

test("buildClickByTextCode uses default tag button when tag is omitted", () => {
  const code = buildClickByTextCode("Save");

  assert.ok(code.includes('"button"'));
});

// ---------------------------------------------------------------------------
// clicks.ts — buildClickBySelectorCode
// ---------------------------------------------------------------------------

test("buildClickBySelectorCode returns code string with selector", () => {
  const code = buildClickBySelectorCode("#submit-btn");

  assert.ok(typeof code === "string");
  assert.ok(code.includes('"#submit-btn"'));
  assert.ok(code.includes("querySelector"));
  assert.ok(code.includes(".click()"));
});

test("buildClickBySelectorCode escapes special characters in selector", () => {
  const code = buildClickBySelectorCode('[data-testid="save"]');

  assert.ok(code.includes('"[data-testid=\\"save\\"]"'));
});

test("buildClickBySelectorCode throws when element not found", () => {
  const code = buildClickBySelectorCode("#missing");

  assert.match(code, /throw new Error\('No element found for selector:/);
});

// ---------------------------------------------------------------------------
// uploads.ts — buildUploadFileCode
// ---------------------------------------------------------------------------

test("buildUploadFileCode returns code string with selector and filename", () => {
  const code = buildUploadFileCode("#resume", "/home/user/resume.pdf");

  assert.ok(typeof code === "string");
  assert.ok(code.includes('"#resume"'));
  assert.ok(code.includes('"resume.pdf"'));
  assert.ok(code.includes("querySelector"));
  assert.ok(code.includes("DataTransfer"));
  assert.ok(code.includes(".files ="));
});

test("buildUploadFileCode throws when no file input found", () => {
  const code = buildUploadFileCode("#missing", "/tmp/file.txt");

  assert.match(code, /throw new Error\('No file input found for selector:/);
});

test("buildUploadFileCode validates input type is file", () => {
  const code = buildUploadFileCode("input[name='avatar']", "/path/to/img.png");

  assert.ok(code.includes("input.type !== 'file'"));
  assert.ok(code.includes("input.tagName !== 'INPUT'"));
});

test("buildUploadFileCode dispatches change event", () => {
  const code = buildUploadFileCode("#file", "/tmp/doc.pdf");

  assert.match(code, /new Event\('change'/);
  assert.match(code, /bubbles:\s*true/);
});

test("buildUploadFileCode extracts filename from path", () => {
  const code = buildUploadFileCode("#f", "/a/b/c/document.pdf");

  assert.ok(code.includes('"document.pdf"'));
});

test("buildUploadFileCode handles filename without directory", () => {
  const code = buildUploadFileCode("#f", "report.csv");

  assert.ok(code.includes('"report.csv"'));
});

test("buildUploadFileCode uses DataTransfer to set files", () => {
  const code = buildUploadFileCode("#f", "/tmp/file.txt");

  assert.ok(code.includes("new DataTransfer()"));
  assert.ok(code.includes("dataTransfer.items.add(file)"));
  assert.ok(code.includes("input.files = dataTransfer.files"));
});

// ---------------------------------------------------------------------------
// tables.ts — buildExtractTableCode
// ---------------------------------------------------------------------------

test("buildExtractTableCode returns code string with selector", () => {
  const code = buildExtractTableCode("#data-table");

  assert.ok(typeof code === "string");
  assert.ok(code.includes('"#data-table"'));
  assert.ok(code.includes("querySelector"));
  assert.ok(code.includes("querySelectorAll('tr')"));
});

test("buildExtractTableCode throws when table not found", () => {
  const code = buildExtractTableCode("#missing");

  assert.match(code, /throw new Error\('No table found for selector:/);
});

test("buildExtractTableCode validates element is a table", () => {
  const code = buildExtractTableCode("#not-a-table");

  assert.ok(code.includes("table.tagName !== 'TABLE'"));
});

test("buildExtractTableCode extracts td and th cells", () => {
  const code = buildExtractTableCode("table");

  assert.ok(code.includes("querySelectorAll('td, th')"));
});

test("buildExtractTableCode trims cell text content", () => {
  const code = buildExtractTableCode("table");

  assert.ok(code.includes(".textContent?.trim()"));
});

test("buildExtractTableCode returns JSON-stringified result", () => {
  const code = buildExtractTableCode("table");

  assert.ok(code.includes("JSON.stringify(result)"));
  assert.match(code, /return JSON\.stringify/);
});

test("buildExtractTableCode defaults empty cells to empty string", () => {
  const code = buildExtractTableCode("table");

  assert.ok(code.includes("?? ''"));
});

// ---------------------------------------------------------------------------
// Cross-cutting: all helpers return strings, not functions
// ---------------------------------------------------------------------------

test("all form helpers return non-empty strings", () => {
  const results = [
    buildFillByLabelCode("L", "V"),
    buildSelectByLabelCode("L", "V"),
    buildCheckByLabelCode("L", true),
  ];

  for (const r of results) {
    assert.ok(typeof r === "string");
    assert.ok(r.length > 0);
  }
});

test("all click helpers return non-empty strings", () => {
  const results = [
    buildClickByTextCode("Click"),
    buildClickBySelectorCode("#btn"),
  ];

  for (const r of results) {
    assert.ok(typeof r === "string");
    assert.ok(r.length > 0);
  }
});

test("upload and table helpers return non-empty strings", () => {
  const upload = buildUploadFileCode("#f", "/tmp/file.txt");
  const table = buildExtractTableCode("#t");

  assert.ok(typeof upload === "string");
  assert.ok(upload.length > 0);
  assert.ok(typeof table === "string");
  assert.ok(table.length > 0);
});
