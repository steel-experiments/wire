import { lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

/**
 * Validate every already-existing component before recursive creation can
 * follow a redirected ownership boundary. The first absent component ends the
 * walk because none of its descendants can exist yet.
 */
export async function assertExistingDirectoryChain(path: string, label: string): Promise<void> {
  const absolute = resolve(path);
  const chain: string[] = [];
  let current = absolute;
  while (true) {
    chain.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  for (const component of chain.reverse()) {
    let info;
    try {
      info = await lstat(component);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} is not a real directory because it has a symlinked ancestor: ${component}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`${label} is not a real directory: ${component}`);
    }
  }
}
