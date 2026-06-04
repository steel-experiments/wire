import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function walk(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
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

const srcFiles = walk("src").filter((file) => /\.tsx?$/u.test(file));
const testFiles = srcFiles.filter((file) => /\.test\.tsx?$/u.test(file));
const prodFiles = srcFiles.filter((file) => !/\.test\.tsx?$/u.test(file));

const prodLoc = prodFiles.reduce((total, file) => total + countLines(file), 0);
const testLoc = testFiles.reduce((total, file) => total + countLines(file), 0);

console.log(`production TypeScript files: ${prodFiles.length}`);
console.log(`test TypeScript files:       ${testFiles.length}`);
console.log(`production TypeScript LOC:   ${prodLoc}`);
console.log(`test TypeScript LOC:         ${testLoc}`);
