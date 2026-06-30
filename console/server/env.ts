// ABOUTME: Loads the Wire repo .env so the console shares STEEL_API_KEY etc.
// ABOUTME: Bun auto-loads ./console/.env, but the keys live in the parent wire/.env.

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function loadRepoEnv(): void {
  // server/env.ts -> console/ -> wire/ , so ../../.env is the repo .env.
  const candidates = [
    join(process.cwd(), ".env"),
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env"),
  ];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/u);
      if (!match) continue;
      if (process.env[match[1]!] !== undefined) continue; // real env wins
      process.env[match[1]!] = match[2]!.replace(/^["']|["']$/gu, "");
    }
  }
}
