import type { ActionRegistry } from "./actions.js";
import { executeStep, type LoopResult, type LoopState } from "./loop.js";
import { latestObservation, reconfigureJustified } from "./state-helpers.js";
import { syncMatchedSkills } from "./skill-context.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { LoadedSkill, ProposedAction } from "../shared/types.js";
import type { RuntimeConfig } from "./runtime.js";

export interface RecoverySignals {
  policyDenied: boolean;
  authWallHit: boolean;
  antiBotRecoveryAttempted: boolean;
  maxStepsReached: boolean;
  awaitingApproval: boolean;
  blockedByPolicy: boolean;
  userCancelled: boolean;
  pendingApproval: LoopResult["pendingApproval"];
  pendingAction: LoopResult["pendingAction"];
  flushedEvents: number;
}

type FlushTraceSink = (
  state: LoopState,
  config: RuntimeConfig,
  signals: RecoverySignals,
) => Promise<void>;

function pathEvidenceFromUrl(rawUrl: unknown): string[] {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) return [];
  try {
    const url = new URL(rawUrl);
    const parts = url.pathname
      .split("/")
      .filter((part) => part.length >= 4)
      .map((part) => `/${part.toLowerCase()}`);
    return [url.hostname.toLowerCase(), url.pathname.toLowerCase(), ...parts];
  } catch {
    return [rawUrl.toLowerCase()];
  }
}

function skillDescribesRecoverableBarrier(skill: LoadedSkill, evidence: string[]): boolean {
  const text = [
    skill.sections["Known Traps"],
    skill.sections["Traps"],
    skill.sections["Workflow"],
    skill.sections["Facts"],
  ].filter((value): value is string => typeof value === "string").join("\n").toLowerCase();
  if (text.length === 0) return false;

  const mentionsBarrier = /captcha|anti-bot|bot detection|verification|verify|interstitial|challenge/u.test(text);
  if (!mentionsBarrier) return false;
  return evidence.some((item) => item.length > 0 && text.includes(item));
}

function latestObservationMatchesRecoverableSkillBarrier(state: LoopState): boolean {
  const observation = latestObservation(state);
  if (!observation) return false;
  const evidence = pathEvidenceFromUrl(observation.payload.url);
  if (evidence.length === 0) return false;
  return state.loadedSkills.some((skill) => skillDescribesRecoverableBarrier(skill, evidence));
}

export async function tryAntiBotRecovery(
  state: LoopState,
  config: RuntimeConfig,
  signals: RecoverySignals,
  actionRegistry: ActionRegistry | undefined,
  flushTraceSink: FlushTraceSink,
  isCancelled: (config: RuntimeConfig) => boolean,
): Promise<boolean> {
  if (signals.policyDenied || isCancelled(config)) return false;
  if (signals.antiBotRecoveryAttempted) return false;
  if (!latestObservationMatchesRecoverableSkillBarrier(state)) return false;
  // Gate: only recover when the current page is actually blocked. A pre-nav
  // about:blank or an already-loaded content page is not a block; proxying it
  // is wasteful for easy sites and destructive for some content sites.
  if (!reconfigureJustified(latestObservation(state))) return false;
  if (!actionRegistry?.get("reconfigure")) return false;

  signals.antiBotRecoveryAttempted = true;
  const action: ProposedAction = {
    kind: "reconfigure",
    summary: "Recover from anti-bot challenge with proxy and captcha support",
    payload: { useProxy: true, solveCaptcha: true },
  };
  const stepOpts: {
    actionRegistry: ActionRegistry;
    actionContext?: { onSessionReconfigured: NonNullable<RuntimeConfig["onSessionReconfigured"]> };
  } = { actionRegistry };
  if (config.onSessionReconfigured) {
    stepOpts.actionContext = { onSessionReconfigured: config.onSessionReconfigured };
  }

  try {
    const stepResult = await executeStep(state, action, config.provider, config.policyEngine, stepOpts);
    Object.assign(state, stepResult.state);
    signals.policyDenied = stepResult.policyDenied;
    signals.authWallHit = stepResult.authWallHit;
    if (stepResult.pendingApproval) {
      signals.awaitingApproval = true;
      signals.pendingApproval = stepResult.pendingApproval;
      signals.pendingAction = stepResult.pendingAction;
    }
    await syncMatchedSkills(state, config.skillDir);
    await flushTraceSink(state, config, signals);
    return true;
  } catch (err) {
    state.events.push({
      id: createId("event"),
      runId: state.run.id,
      ts: nowIsoUtc(),
      kind: "error",
      payload: {
        message: err instanceof Error ? err.message : String(err),
        code: "ERECONFIGURE",
      },
    });
    await flushTraceSink(state, config, signals);
    return false;
  }
}
