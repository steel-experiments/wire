import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { Artifact, JsonValue, RunId, TraceBlob, TraceBlobKind } from "../shared/types.js";
import { nowIsoUtc, stableJsonStringify } from "../shared/ids.js";
import { parseBoundary, traceBlobSchema } from "../shared/schemas.js";
import {
  atomicWriteJson,
  CorruptError,
  NotFoundError,
  readJsonFile,
} from "./atomic.js";

const KIND = "blobs";

export function hashTraceBlobValue(value: JsonValue): string {
  return createHash("sha256").update(stableJsonStringify(value)).digest("hex");
}

export function traceBlobPath(root: string, runId: RunId, hash: string): string {
  return join(root, KIND, runId, `${hash}.json`);
}

export async function saveTraceBlobValue(
  root: string,
  runId: RunId,
  kind: TraceBlobKind,
  value: JsonValue,
  contentType?: string,
): Promise<TraceBlob> {
  const hash = hashTraceBlobValue(value);
  const path = traceBlobPath(root, runId, hash);
  const existing = await readJsonFile(path);
  if (existing !== undefined) {
    return parseBoundary<TraceBlob>(traceBlobSchema, existing, "trace-blob");
  }

  const blob: TraceBlob = {
    hash,
    runId,
    kind,
    createdAt: nowIsoUtc(),
    size: Buffer.byteLength(stableJsonStringify(value), "utf8"),
    value,
  };
  if (contentType !== undefined) {
    blob.contentType = contentType;
  }

  await mkdir(dirname(path), { recursive: true });
  await atomicWriteJson(path, blob);
  return blob;
}

export async function loadTraceBlob(root: string, runId: RunId, hash: string): Promise<TraceBlob> {
  const path = traceBlobPath(root, runId, hash);
  const raw = await readJsonFile(path);
  if (raw === undefined) {
    throw new NotFoundError(KIND, hash);
  }

  try {
    return parseBoundary<TraceBlob>(traceBlobSchema, raw, "trace-blob");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}

export async function resolveTraceBlobRef(root: string, runId: RunId, hash: string): Promise<JsonValue> {
  return (await loadTraceBlob(root, runId, hash)).value;
}

export async function loadArtifactContent(root: string, artifact: Artifact): Promise<string | undefined> {
  const hash = typeof artifact.metadata?.contentHash === "string" ? artifact.metadata.contentHash : undefined;
  if (hash !== undefined) {
    const value = await resolveTraceBlobRef(root, artifact.runId, hash);
    return typeof value === "string" ? value : stableJsonStringify(value);
  }

  const legacy = artifact.metadata?.content;
  return typeof legacy === "string" ? legacy : undefined;
}
