// ABOUTME: Observation recording for the agent loop — captures browser state
// ABOUTME: as redacted trace events and annotates tab drift between captures.

import type { JsonObject, SessionId } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { redactJsonObject } from "../shared/redact.js";
import type { BrowserProvider } from "../browser/bridge.js";
import { observeBrowser, toObservationPayload } from "../browser/observe.js";
import { detectAuthWall } from "../profiles/auth.js";
import type { LoopState } from "./loop.js";

type TabSnapshot = { id: string; url: string; title: string };

function latestObservationPayload(state: LoopState): JsonObject | undefined {
  return [...state.events].reverse().find((e) => e.kind === "observation")?.payload;
}

function tabsFromPayload(payload: JsonObject | undefined): TabSnapshot[] {
  const raw = payload?.tabs;
  if (!Array.isArray(raw)) return [];
  const tabs: TabSnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const tab = item as JsonObject;
    if (typeof tab.id !== "string") continue;
    tabs.push({
      id: tab.id,
      url: typeof tab.url === "string" ? tab.url : "",
      title: typeof tab.title === "string" ? tab.title : "",
    });
  }
  return tabs;
}

function buildTabDrift(previous: JsonObject | undefined, current: JsonObject): JsonObject | undefined {
  if (!previous) return undefined;
  const previousTargetId = typeof previous.targetId === "string" ? previous.targetId : "";
  const currentTargetId = typeof current.targetId === "string" ? current.targetId : "";
  const previousTabs = tabsFromPayload(previous);
  const currentTabs = tabsFromPayload(current);
  const previousById = new Map(previousTabs.map((tab) => [tab.id, tab]));
  const currentById = new Map(currentTabs.map((tab) => [tab.id, tab]));
  const newTabs = currentTabs.filter((tab) => !previousById.has(tab.id));
  const closedTabs = previousTabs.filter((tab) => !currentById.has(tab.id));
  const targetChanged = !!previousTargetId && !!currentTargetId && previousTargetId !== currentTargetId;
  const countChanged = previousTabs.length !== currentTabs.length;
  if (!targetChanged && !countChanged && newTabs.length === 0 && closedTabs.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  if (targetChanged) parts.push(`selected tab changed ${previousTargetId} -> ${currentTargetId}`);
  if (countChanged) parts.push(`tab count ${previousTabs.length} -> ${currentTabs.length}`);
  if (newTabs.length > 0) parts.push(`new tab: ${newTabs.map((t) => t.url || t.title || t.id).join(", ")}`);
  if (closedTabs.length > 0) parts.push(`closed tab: ${closedTabs.map((t) => t.url || t.title || t.id).join(", ")}`);
  return {
    previousTargetId,
    currentTargetId,
    previousTabCount: previousTabs.length,
    currentTabCount: currentTabs.length,
    targetChanged,
    newTabs: newTabs as unknown as import("../shared/types.js").JsonValue,
    closedTabs: closedTabs as unknown as import("../shared/types.js").JsonValue,
    message: `Tab drift detected: ${parts.join("; ")}`,
  };
}

export function withTabDrift(state: LoopState, payload: JsonObject): JsonObject {
  const tabDrift = buildTabDrift(latestObservationPayload(state), payload);
  if (!tabDrift) return payload;
  return { ...payload, tabDrift };
}

export async function observeAndRecord(
  state: LoopState,
  provider: BrowserProvider,
  options: { targetId?: string; includeScreenshotArtifactId?: boolean; includePageSketch?: boolean } = {},
): Promise<{ authWallHit: boolean }> {
  const observeOptions: { provider: BrowserProvider; sessionId: SessionId; targetId?: string; includePageSketch?: boolean } = {
    provider,
    sessionId: state.sessionId,
  };
  if (options.targetId) observeOptions.targetId = options.targetId;
  if (options.includePageSketch !== undefined) {
    observeOptions.includePageSketch = options.includePageSketch;
  }
  const observation = await observeBrowser(observeOptions);
  const payloadOptions: { includeScreenshotArtifactId?: boolean } = {};
  if (options.includeScreenshotArtifactId !== undefined) {
    payloadOptions.includeScreenshotArtifactId = options.includeScreenshotArtifactId;
  }
  const payload = withTabDrift(
    state,
    toObservationPayload(observation, payloadOptions),
  );
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "observation",
    payload: redactJsonObject(payload),
  });
  if (observation.screenshotBase64) {
    state.latestScreenshotBase64 = observation.screenshotBase64;
  }
  return { authWallHit: detectAuthWall(observation).detected };
}
