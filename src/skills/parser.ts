import { parseBoundary, skillFrontmatterSchema } from "../shared/schemas.js";
import type { SkillFrontmatter } from "../shared/types.js";

// Frontmatter extraction

/**
 * Extract the YAML-like frontmatter block (text between `---` delimiters)
 * and the remaining body text from a markdown skill file.
 *
 * Returns `{ frontmatter, body }` or throws if the `---` markers are missing
 * or malformed.
 */
function splitFrontmatter(
  content: string,
  label: string,
): { frontmatter: string; body: string } {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    throw new Error(`${label}: missing opening --- frontmatter delimiter`);
  }

  const afterFirst = trimmed.slice(3);
  const closeIdx = afterFirst.indexOf("\n---");

  if (closeIdx === -1) {
    throw new Error(`${label}: missing closing --- frontmatter delimiter`);
  }

  const frontmatter = afterFirst.slice(0, closeIdx).trim();
  const body = afterFirst.slice(closeIdx + 4); // skip past "\n---"

  return { frontmatter, body };
}

// Minimal YAML-like parser

/**
 * Parse a very small subset of YAML: top-level string, number, boolean, and
 * date scalars, plus flat lists using `- ` syntax. No nested objects, no
 * quotes, no multiline strings. This is enough for skill frontmatter.
 */
function parseSimpleYaml(raw: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  const listItems: unknown[] = [];

  function flushList(): void {
    if (currentKey !== null && listItems.length > 0) {
      result[currentKey] = listItems.slice();
      listItems.length = 0;
    }
  }

  for (const rawLine of raw.split("\n")) {
    const line = rawLine.trimEnd();

    // Blank line
    if (line.length === 0) continue;

    // List item: "  - value"
    const listMatch = /^(\s*)-\s+(.+)$/u.exec(line);
    if (listMatch) {
      listItems.push(parseScalar(listMatch[2]!));
      continue;
    }

    // Key-value pair: "key: value"
    const kvMatch = /^([a-zA-Z_][a-zA-Z0-9_]*):\s*(.*)$/u.exec(line);
    if (kvMatch) {
      flushList();

      currentKey = kvMatch[1]!;
      const value = kvMatch[2]!.trim();

      if (value.length === 0) {
        // Empty value means a list will follow
        continue;
      }

      result[currentKey] = parseScalar(value);
      currentKey = null;
      continue;
    }

    // Ignore anything else (should not happen in valid frontmatter)
  }

  flushList();

  return result;
}

function parseScalar(value: string): unknown {
  // Quoted string — strip quotes
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;

  // Number (integer or float)
  if (/^-?\d+$/u.test(value)) return parseInt(value, 10);
  if (/^-?\d+\.\d+$/u.test(value)) return parseFloat(value);

  // Date (YYYY-MM-DD)
  if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) return value;

  // Plain string
  return value;
}

// Public API

/**
 * Parse a markdown skill file's frontmatter and return validated
 * `SkillFrontmatter`.
 *
 * @param content - Raw markdown file content.
 * @param label   - Optional label for error messages (e.g. file path).
 */
export function parseSkillFile(
  content: string,
  label = "skill-file",
): SkillFrontmatter {
  const { frontmatter } = splitFrontmatter(content, label);
  const raw = parseSimpleYaml(frontmatter);

  return parseBoundary<SkillFrontmatter>(
    skillFrontmatterSchema,
    raw,
    label,
  );
}

/**
 * Extract `## Section Name` sections from the body (everything after the
 * frontmatter closing `---`). Returns a `Map<sectionName, sectionBody>`
 * where sectionName is the heading text (trimmed) and sectionBody is the
 * text between that heading and the next `## ` heading (or end of body).
 */
export function extractSections(content: string): Map<string, string> {
  const sections = new Map<string, string>();
  const { body } = splitFrontmatter(content, "skill-file");

  const lines = body.split("\n");
  let currentName: string | null = null;
  let currentLines: string[] = [];

  function flush(): void {
    if (currentName !== null) {
      sections.set(currentName, currentLines.join("\n").trim());
    }
  }

  for (const line of lines) {
    const headingMatch = /^## (.+)$/u.exec(line);
    if (headingMatch) {
      flush();
      currentName = headingMatch[1]!.trim();
      currentLines = [];
    } else if (currentName !== null) {
      currentLines.push(line);
    }
  }

  flush();

  return sections;
}
