import type { Artifact, ArtifactId, RunId } from "../shared/types.js";
import { artifactSchema, parseBoundary } from "../shared/schemas.js";
import {
  atomicWriteJson,
  CorruptError,
  entityDir,
  entityPath,
  listJsonFiles,
  NotFoundError,
  readJsonFile,
} from "./atomic.js";

const KIND = "artifacts";

function artifactFilePath(root: string, id: ArtifactId): string {
  return entityPath(root, KIND, id);
}

/**
 * Persist an artifact record. Artifacts are immutable once saved; calling
 * saveArtifact for an existing id overwrites the metadata file (the on-disk
 * artifact at `artifact.path` is the caller's responsibility).
 */
export async function saveArtifact(root: string, artifact: Artifact): Promise<void> {
  await atomicWriteJson(artifactFilePath(root, artifact.id), artifact);
}

export async function loadArtifact(root: string, artifactId: ArtifactId): Promise<Artifact> {
  const path = artifactFilePath(root, artifactId);

  const raw = await readJsonFile(path);
  if (raw === undefined) {
    throw new NotFoundError(KIND, artifactId);
  }

  try {
    return parseBoundary<Artifact>(artifactSchema, raw, "artifact");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}

export async function listArtifacts(root: string, runId?: RunId): Promise<Artifact[]> {
  const dir = entityDir(root, KIND);
  const files = await listJsonFiles(dir);

  const artifacts: Artifact[] = [];

  for (const name of files) {
    const id = name.replace(/\.json$/u, "") as ArtifactId;
    const path = entityPath(root, KIND, id);

    let raw: unknown;
    try {
      raw = await readJsonFile(path);
    } catch {
      continue;
    }

    let artifact: Artifact;
    try {
      artifact = parseBoundary<Artifact>(artifactSchema, raw, "artifact");
    } catch {
      continue;
    }

    if (runId === undefined || artifact.runId === runId) {
      artifacts.push(artifact);
    }
  }

  return artifacts;
}
