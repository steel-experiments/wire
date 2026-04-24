import { unlink } from "node:fs/promises";

import type { RunCheckpoint, RunId } from "../shared/types.js";
import { parseBoundary, runCheckpointSchema } from "../shared/schemas.js";
import {
  atomicWriteJson,
  CorruptError,
  entityPath,
  NotFoundError,
  readJsonFile,
  StorageError,
} from "./atomic.js";

const KIND = "checkpoints";

function checkpointFilePath(root: string, runId: RunId): string {
  return entityPath(root, KIND, runId);
}

export async function saveRunCheckpoint(root: string, checkpoint: RunCheckpoint): Promise<void> {
  await atomicWriteJson(checkpointFilePath(root, checkpoint.runId), checkpoint);
}

export async function loadRunCheckpoint(root: string, runId: RunId): Promise<RunCheckpoint> {
  const path = checkpointFilePath(root, runId);
  const raw = await readJsonFile(path);

  if (raw === undefined) {
    throw new NotFoundError(KIND, runId);
  }

  try {
    return parseBoundary<RunCheckpoint>(runCheckpointSchema, raw, "run-checkpoint");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}

export async function deleteRunCheckpoint(root: string, runId: RunId): Promise<void> {
  const path = checkpointFilePath(root, runId);

  try {
    await unlink(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return;
    }
    throw new StorageError(`Failed to delete ${path}`, err);
  }
}
