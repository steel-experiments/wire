import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Error types

export class StorageError extends Error {
  constructor(
    message: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "StorageError";
  }
}

export class NotFoundError extends StorageError {
  constructor(
    public readonly entityKind: string,
    public readonly entityId: string,
  ) {
    super(`${entityKind} not found: ${entityId}`);
    this.name = "NotFoundError";
  }
}

export class CorruptError extends StorageError {
  constructor(
    public readonly filePath: string,
    reason: string,
    cause?: unknown,
  ) {
    super(`Corrupt file ${filePath}: ${reason}`, cause);
    this.name = "CorruptError";
  }
}

// Directory helpers

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export function entityDir(root: string, kind: string): string {
  return join(root, kind);
}

export function entityPath(root: string, kind: string, id: string): string {
  return join(entityDir(root, kind), `${id}.json`);
}

// Atomic write

export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  const dir = join(path, "..");
  const tmpPath = join(dir, `.tmp-${randomUUID()}`);

  try {
    await ensureDir(dir);
    await writeFile(tmpPath, JSON.stringify(data, null, 2), "utf-8");
    await rename(tmpPath, path);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try {
      await unlink(tmpPath);
    } catch {
      // Swallow cleanup errors; the original error is more important.
    }
    throw new StorageError(`Failed to write ${path}`, err);
  }
}

// Read helpers

export async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;

  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return undefined as never; // callers should use the NotFoundError path
    }
    throw new StorageError(`Failed to read ${path}`, err);
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new CorruptError(path, "invalid JSON", err);
  }
}

export async function listJsonFiles(dir: string): Promise<string[]> {
  await ensureDir(dir);

  let entries: string[];

  try {
    entries = await readdir(dir);
  } catch (err) {
    throw new StorageError(`Failed to list ${dir}`, err);
  }

  return entries.filter((name) => name.endsWith(".json")).sort();
}
