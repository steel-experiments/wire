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

const tsFiles = walk("src").filter((file) => /\.tsx?$/u.test(file));
const failures = [];

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
