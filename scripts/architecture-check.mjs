import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const fileCaps = new Map([
  ["src/agent/runtime.ts", 1_000],
  ["src/agent/loop.ts", 700],
  ["src/cli/runner.ts", 450],
  ["src/agent/agent.test.ts", 2_500],
]);

const globalCaps = {
  productionFileLoc: 950,
  testFileLoc: 2_500,
};

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walk(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function countLines(path) {
  const size = statSync(path).size;
  if (size === 0) return 0;
  const text = readFileSync(path, "utf8");
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length;
}

// Import-graph boundaries (docs/architecture.md): lower layers must not
// reach into higher ones, and nothing outside providers/llm may depend on a
// concrete provider module for its types. Each rule forbids imports FROM a
// module prefix TO a path matching `to`.
const importRules = [
  { from: "src/providers/", to: /^src\/agent\//u, why: "providers must not import agent code" },
  { from: "src/skills/", to: /^src\/agent\//u, why: "skills must not import agent code" },
  { from: "src/agent/", to: /^src\/eval\//u, why: "agent must not import eval code" },
  { from: "src/eval/", to: /^src\/cli\//u, why: "eval must not import CLI code" },
  { from: "src/browser/", to: /^src\/agent\//u, why: "browser must not import agent code" },
  { from: "src/shared/", to: /^src\/(?!shared\/)/u, why: "shared must not import other layers" },
  {
    from: "src/",
    to: /^src\/providers\/llm\/openai\.js$/u,
    typeOnly: true,
    exempt: /^src\/(providers\/llm\/|index\.ts$)/u,
    why: "import the LLM contract from providers/llm/types.js, not a concrete provider",
  },
];

// Known violations awaiting refactor. Empty as of 2026-06-10 — additions
// require a documented decision.
const importAllowlist = new Set([]);

function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return undefined;
  const dir = fromFile.split("/").slice(0, -1).join("/");
  const parts = [...dir.split("/")];
  for (const segment of spec.replace(/\.js$/u, ".ts").split("/")) {
    if (segment === "." || segment === "") continue;
    else if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

function checkImports(file, failures) {
  const source = readFileSync(file, "utf8");
  const importPattern = /^import\s+(type\s+)?[^;]*?from\s+"([^"]+)"|^export\s+(type\s+)?[^;]*?from\s+"([^"]+)"/gmu;
  for (const match of source.matchAll(importPattern)) {
    const isTypeOnly = Boolean(match[1] ?? match[3]);
    const spec = match[2] ?? match[4];
    const resolved = resolveImport(file, spec);
    if (!resolved) continue;
    const resolvedJs = resolved.replace(/\.ts$/u, ".js");
    for (const rule of importRules) {
      if (!file.startsWith(rule.from)) continue;
      if (rule.exempt?.test(file)) continue;
      if (rule.typeOnly && !isTypeOnly) continue;
      if (!rule.to.test(resolved) && !rule.to.test(resolvedJs)) continue;
      const edge = `${file} -> ${resolved}`;
      if (importAllowlist.has(edge)) continue;
      failures.push(`${edge}: ${rule.why}`);
    }
  }
}

const tsFiles = walk("src").filter((file) => /\.tsx?$/u.test(file));
const failures = [];

for (const file of tsFiles.filter((f) => !/\.test\.tsx?$/u.test(f))) {
  checkImports(file, failures);
}

for (const [file, cap] of fileCaps) {
  const loc = countLines(file);
  if (loc > cap) {
    failures.push(`${file}: ${loc} LOC exceeds cap ${cap}`);
  }
}

for (const file of tsFiles) {
  const loc = countLines(file);
  const isTest = /\.test\.tsx?$/u.test(file);
  const cap = isTest ? globalCaps.testFileLoc : globalCaps.productionFileLoc;
  if (loc > cap) {
    failures.push(`${file}: ${loc} LOC exceeds ${isTest ? "test" : "production"} cap ${cap}`);
  }
}

if (failures.length > 0) {
  console.error("Architecture fitness check failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("Architecture fitness check passed.");
