import type { ActionHandler } from "../../../browser/actions.js";
import type { CreateSessionInput, JsonObject, SessionConfig } from "../../../shared/types.js";
import { createId, nowIsoUtc } from "../../../shared/ids.js";
import { normalizeSteelRegion, sanitizedSessionConfig } from "./api.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readProxyConfig(value: unknown): SessionConfig["useProxy"] | undefined {
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) return undefined;

  const proxy: Exclude<SessionConfig["useProxy"], boolean | undefined> = {};
  if (isRecord(value["geolocation"]) && typeof value["geolocation"]["country"] === "string") {
    proxy.geolocation = { country: value["geolocation"]["country"] };
  }
  if (typeof value["server"] === "string") {
    proxy.server = value["server"];
  }
  return proxy.geolocation || proxy.server ? proxy : undefined;
}

export function createSteelActionHandlers(): ActionHandler[] {
  return [{
    kind: "reconfigure",
    description: 'For "reconfigure", set payload fields: useProxy (bool or approved proxy object), solveCaptcha (bool), stealth (bool), userAgent (string), region ("lax" or "iad" only), locale (string), timezone (string), viewport ({width,height}). Creates a new browser session with updated settings. Use when blocked by captcha, IP block, or anti-bot detection. Do not invent region names.',
    async execute(state, action, provider, context) {
      const requested = action.payload as JsonObject | undefined;
      const merged: SessionConfig = sanitizedSessionConfig(state.sessionConfig ?? {});

      if (requested?.useProxy !== undefined) {
        const useProxy = readProxyConfig(requested.useProxy);
        if (useProxy !== undefined) merged.useProxy = useProxy;
      }
      if (requested?.solveCaptcha !== undefined) {
        merged.solveCaptcha = Boolean(requested.solveCaptcha);
      }
      if (requested?.stealth !== undefined) {
        merged.stealth = Boolean(requested.stealth);
      }
      if (typeof requested?.userAgent === "string") {
        merged.userAgent = requested.userAgent;
      }
      if (typeof requested?.region === "string") {
        const region = normalizeSteelRegion(requested.region);
        if (region) {
          merged.region = region;
        } else {
          delete merged.region;
        }
      }
      if (typeof requested?.locale === "string") {
        merged.locale = requested.locale;
      }
      if (typeof requested?.timezone === "string") {
        merged.timezone = requested.timezone;
      }
      if (isRecord(requested?.viewport) && typeof requested.viewport["width"] === "number" && typeof requested.viewport["height"] === "number") {
        merged.viewport = { width: requested.viewport["width"], height: requested.viewport["height"] };
      }

      const oldSessionId = state.sessionId;

      const sessionInput: CreateSessionInput = { sessionConfig: merged };
      if (state.profileId) {
        sessionInput.profileId = state.profileId;
      }

      const newSession = await provider.createSession(sessionInput);
      await context?.onSessionReconfigured?.({
        oldSessionId,
        newSession,
        summary: action.summary,
      });

      try {
        await provider.stopSession(oldSessionId);
      } catch { /* best-effort */ }

      state.sessionId = newSession.id;
      state.sessionConfig = merged;
      const liveUrl = newSession.liveUrl ?? newSession.debugUrl;
      if (liveUrl) {
        state.sessionLiveUrl = liveUrl;
      }
      if (newSession.profileId) {
        state.profileId = newSession.profileId;
      }

      const { redactJsonObject } = await import("../../../shared/redact.js");
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "thought-summary",
        payload: {
          summary: action.summary,
          kind: "reconfigure",
          oldSessionId,
          newSessionId: newSession.id,
          config: redactJsonObject(merged as JsonObject),
        },
      });

      // Auto-observe new session so agent sees about:blank
      const observation = await provider.observe({ sessionId: state.sessionId });
      const { toObservationPayload } = await import("../../../browser/observe.js");
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "observation",
        payload: redactJsonObject(toObservationPayload(observation)),
      });
      if (observation.screenshotBase64) {
        state.latestScreenshotBase64 = observation.screenshotBase64;
      }

      return {};
    },
  }];
}
