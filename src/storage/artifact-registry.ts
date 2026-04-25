import type { Artifact, ArtifactId, ArtifactKind, RunId } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";

// ---------------------------------------------------------------------------
// In-memory artifact registry
// ---------------------------------------------------------------------------

export interface ArtifactRegistry {
  register(runId: RunId, kind: ArtifactKind, path: string, mimeType?: string): Artifact;
  get(id: ArtifactId): Artifact | undefined;
  list(runId?: RunId): Artifact[];
}

export function createArtifactRegistry(): ArtifactRegistry {
  const artifacts = new Map<ArtifactId, Artifact>();

  return {
    register(runId, kind, path, mimeType) {
      const artifact: Artifact = {
        id: createId("artifact"),
        runId,
        kind,
        path,
        createdAt: nowIsoUtc(),
      };
      if (mimeType) {
        artifact.mimeType = mimeType;
      }
      artifacts.set(artifact.id, artifact);
      return artifact;
    },

    get(id) {
      return artifacts.get(id);
    },

    list(runId) {
      const all = [...artifacts.values()];
      if (runId === undefined) return all;
      return all.filter((a) => a.runId === runId);
    },
  };
}
