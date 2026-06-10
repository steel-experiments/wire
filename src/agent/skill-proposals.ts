import type { JsonObject } from "../shared/types.js";
import type { LLMProvider } from "../providers/llm/types.js";
import {
  DEFAULT_SKILL_PROMOTION_POLICY,
  generateSkillProposal,
  llmProposeSkill,
  manageSkillPromotion,
} from "../skills/promote.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { LoopState } from "./loop.js";

export async function appendSkillProposalEvents(
  state: LoopState,
  skillDir?: string,
  llmProvider?: LLMProvider,
  options: { completed?: boolean } = {},
): Promise<void> {
  if (!llmProvider) return;
  if (state.events.some((event) => event.kind === "skill-proposal")) return;

  const candidate = await llmProposeSkill(state.events, state.run.id, llmProvider, options);
  if (!candidate) return;

  const payload: JsonObject = {
    skillId: candidate.skillId,
    scope: "domain",
    hostname: candidate.hostname,
    confidence: candidate.confidence,
    rationale: `Reusable browser knowledge detected for ${candidate.hostname}`,
    proposal: generateSkillProposal(candidate),
  };

  if (skillDir) {
    try {
      const result = await manageSkillPromotion(candidate, skillDir, {
        ...DEFAULT_SKILL_PROMOTION_POLICY,
        allowAutoPromote: options.completed !== false,
      });
      if (result.proposalPath) payload.proposalPath = result.proposalPath;
      if (result.activePath) payload.path = result.activePath;
      if (!result.activePath && result.proposalPath) payload.path = result.proposalPath;
      payload.promoted = result.promoted;
      payload.promotionReason = result.reason;
    } catch (err) {
      payload.writeError = err instanceof Error ? err.message : String(err);
    }
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "skill-proposal",
    payload,
  });
}
