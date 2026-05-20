import { createId } from "../shared/ids.js";
import type {
  ActionId,
  PolicyDecision,
} from "../shared/types.js";

import { BASELINE_RULES, evaluateRules } from "./rules.js";
import type { PolicyAction, PolicyRule } from "./rules.js";

// PolicyEngine interface

export interface PolicyEngine {
  check(actionId: ActionId, action: PolicyAction): PolicyDecision;
}

// createPolicyEngine

export function createPolicyEngine(rules?: PolicyRule[]): PolicyEngine {
  const activeRules = rules ?? BASELINE_RULES;

  return {
    check(actionId: ActionId, action: PolicyAction): PolicyDecision {
      const { result, matchedRules } = evaluateRules(action, activeRules);

      const reason =
        matchedRules.length > 0
          ? `Matched rules: ${matchedRules.join(", ")}`
          : undefined;

      const decision: PolicyDecision = {
        id: createId("policy"),
        actionId,
        result,
      };

      if (reason !== undefined) {
        decision.reason = reason;
      }

      return decision;
    },
  };
}
