// ABOUTME: Per-step screenshot artifact capture for the agent loop.

import type { ArtifactId, JsonObject, ScreenshotCapturePolicy } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { BrowserProvider } from "../browser/bridge.js";
import type { LoopState } from "./loop.js";
import { latestObservation } from "./state-helpers.js";

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

function latestTargetId(state: LoopState): string | undefined {
  const observation = latestObservation(state);
  return typeof observation?.payload.targetId === "string"
    ? observation.payload.targetId
    : undefined;
}

export async function captureStepScreenshotArtifact(
  state: LoopState,
  provider: BrowserProvider,
  policy: ScreenshotCapturePolicy = "on-observe",
  observationCountBefore = state.events.filter((event) => event.kind === "observation").length,
): Promise<void> {
  if (policy === "off") return;
  if (
    policy === "on-observe" &&
    state.events.filter((event) => event.kind === "observation").length <= observationCountBefore
  ) {
    return;
  }
  if (!provider.screenshot) return;

  let screenshot: Awaited<ReturnType<NonNullable<BrowserProvider["screenshot"]>>>;
  try {
    const targetId = latestTargetId(state);
    screenshot = await provider.screenshot({
      sessionId: state.sessionId,
      ...(targetId ? { targetId } : {}),
    });
  } catch (err) {
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "thought-summary",
      payload: {
        kind: "screenshot-capture-failed",
        step: state.stepCount,
        reason: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  const artifactId = createId("artifact") as ArtifactId;
  const metadata: JsonObject = {
    source: "step-screenshot",
    step: state.stepCount,
  };
  if (screenshot.targetId) {
    metadata.targetId = screenshot.targetId;
  }

  state.latestScreenshotBase64 = screenshot.dataBase64;
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      kind: "screenshot",
      source: "step-screenshot",
      mimeType: screenshot.mimeType,
      path: `artifacts/${artifactId}-step-${state.stepCount}.${extensionForMime(screenshot.mimeType)}`,
      contentBase64: screenshot.dataBase64,
      metadata,
    },
  });
}
