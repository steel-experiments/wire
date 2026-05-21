// ABOUTME: When an entity lookup misses the active storage root, peek at the
// ABOUTME: known alternates and report where the file actually lives.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { entityPath } from "../storage/atomic.js";

export interface EntityHint {
  root: string;
  path: string;
}

// Probe order: home-dir state (current default) then project-local .wire/.
// The active root is filtered out so a hit only ever points at a *different* location.
export function defaultAlternateRoots(currentRoot: string): string[] {
  const home = join(homedir(), ".wire", "state");
  const project = resolve(".wire");
  const cur = resolve(currentRoot);
  const candidates = [home, project];
  return candidates.filter((r) => resolve(r) !== cur);
}

export async function findEntityInAlternateRoots(
  kind: string,
  id: string,
  alternates: readonly string[],
): Promise<EntityHint | null> {
  for (const root of alternates) {
    const path = entityPath(root, kind, id);
    try {
      await access(path);
      return { root, path };
    } catch {
      // missing here, try next
    }
  }
  return null;
}

export function alternateRootHint(hint: EntityHint): string {
  return `Found at ${hint.path}; re-run with WIRE_ROOT=${hint.root}.`;
}
