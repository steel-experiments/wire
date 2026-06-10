import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Artifact, Task, TraceEvent } from "../shared/types.js";
import { nowIsoUtc } from "../shared/ids.js";
import { saveTask } from "../storage/tasks.js";
import { saveRun } from "../storage/runs.js";
import { saveTraceEvents } from "../storage/events.js";
import { saveArtifact } from "../storage/artifacts.js";
import { saveTraceBlobValue } from "../storage/blobs.js";
import { saveApprovalRequest } from "../storage/approvals.js";
import { deleteRunCheckpoint, saveRunCheckpoint } from "../storage/checkpoints.js";
import type { executeTask } from "../agent/runtime.js";

export interface ArtifactSummary {
  id: string;
  filename?: string;
  kind: string;
  mimeType?: string;
  path: string;
}

export function artifactSummaries(artifacts: Artifact[]): ArtifactSummary[] | undefined {
  if (artifacts.length === 0) {
    return undefined;
  }

  return artifacts.map((artifact) => {
    const summary: ArtifactSummary = {
      id: artifact.id,
      kind: artifact.kind,
      path: artifact.path,
    };
    if (typeof artifact.metadata?.filename === "string") {
      summary.filename = artifact.metadata.filename;
    }
    if (artifact.mimeType !== undefined) {
      summary.mimeType = artifact.mimeType;
    }
    return summary;
  });
}

export function printArtifacts(artifacts: Artifact[]): void {
  const summaries = artifactSummaries(artifacts);
  if (!summaries) return;
  console.log("Artifacts:");
  for (const artifact of summaries) {
    const filename = artifact.filename ? `${artifact.filename}: ` : "";
    const mime = artifact.mimeType ? ` (${artifact.mimeType})` : "";
    console.log(`  - ${filename}${artifact.path}${mime}`);
  }
}

type ExecutionResult = Awaited<ReturnType<typeof executeTask>>;

export async function persistExecutionArtifacts(
  root: string,
  task: Task,
  result: ExecutionResult,
): Promise<Artifact[]> {
  const artifacts = await persistTraceArtifacts(root, result.events);
  await saveTask(root, task);
  await saveRun(root, result.run);
  await saveTraceEvents(root, result.events);

  if (result.pendingApproval && result.pendingAction) {
    await saveApprovalRequest(root, result.pendingApproval);
    await saveRunCheckpoint(root, {
      runId: result.run.id,
      task,
      run: result.run,
      sessionId: result.sessionId,
      events: result.events,
      stepCount: result.stepCount,
      startedAt: result.startedAt,
      helperSource: result.helperSource,
      helperVersion: result.helperVersion,
      reviewFailureCount: result.reviewFailureCount,
      pendingAction: result.pendingAction,
      approvalRequestId: result.pendingApproval.id,
      savedAt: nowIsoUtc(),
    });
  } else {
    await deleteRunCheckpoint(root, result.run.id);
  }

  return artifacts;
}

export async function persistTraceArtifacts(root: string, events: TraceEvent[]): Promise<Artifact[]> {
  const artifacts: Artifact[] = [];

  for (const event of events) {
    if (event.kind !== "artifact") {
      continue;
    }
    const artifactId = typeof event.payload.artifactId === "string" ? event.payload.artifactId : undefined;
    const kind = typeof event.payload.kind === "string" ? event.payload.kind : undefined;
    const path = typeof event.payload.path === "string" ? event.payload.path : undefined;
    const createdAt = typeof event.payload.createdAt === "string" ? event.payload.createdAt : event.ts;
    const mimeType = typeof event.payload.mimeType === "string" ? event.payload.mimeType : undefined;

    if (!artifactId || !kind || !path) {
      continue;
    }

    const absolutePath = resolve(root, path);
    const content = typeof event.payload.content === "string" ? event.payload.content : undefined;
    const contentBase64 = typeof event.payload.contentBase64 === "string" ? event.payload.contentBase64 : undefined;
    if (content !== undefined) {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
    } else if (contentBase64 !== undefined) {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, Buffer.from(contentBase64, "base64"));
    }

    const artifact: Artifact = {
      id: artifactId as Artifact["id"],
      runId: event.runId,
      kind: kind as Artifact["kind"],
      path: absolutePath,
      createdAt,
    };
    if (mimeType !== undefined) {
      artifact.mimeType = mimeType;
    }
    artifact.metadata = {
      source: "trace-artifact",
    };
    if (typeof event.payload.filename === "string") {
      artifact.metadata.filename = event.payload.filename;
    }
    if (event.payload.metadata && typeof event.payload.metadata === "object" && !Array.isArray(event.payload.metadata)) {
      artifact.metadata = {
        ...artifact.metadata,
        ...(event.payload.metadata as Artifact["metadata"]),
      };
    }
    if (content !== undefined) {
      const blob = await saveTraceBlobValue(root, event.runId, "artifact-content", content, mimeType);
      artifact.metadata.contentHash = blob.hash;
      artifact.metadata.contentSize = Buffer.byteLength(content, "utf8");
      artifact.metadata.contentPreview = content.length > 500 ? `${content.slice(0, 500)}...` : content;
    } else if (contentBase64 !== undefined) {
      const bytes = Buffer.from(contentBase64, "base64");
      const blob = await saveTraceBlobValue(root, event.runId, "artifact-content", contentBase64, mimeType);
      artifact.metadata.contentHash = blob.hash;
      artifact.metadata.contentSize = bytes.byteLength;
      artifact.metadata.contentEncoding = "base64";
    }

    await saveArtifact(root, artifact);
    artifacts.push(artifact);
  }

  return artifacts;
}
