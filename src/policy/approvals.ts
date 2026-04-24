import { createId, nowIsoUtc } from "../shared/ids.js";
import type {
  ActionId,
  ApprovalId,
  ApprovalRequest,
  ApprovalStatus,
  RunId,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

// ---------------------------------------------------------------------------
// createApprovalRequest
// ---------------------------------------------------------------------------

export function createApprovalRequest(
  runId: RunId,
  actionId: ActionId,
  summary: string,
  consequences: string[],
): ApprovalRequest {
  const expiresAt = nowIsoUtc(new Date(Date.now() + DEFAULT_TTL_MS));

  return {
    id: createId("approval"),
    runId,
    actionId,
    summary,
    consequences,
    expiresAt,
    status: "pending",
  };
}

// ---------------------------------------------------------------------------
// isExpired
// ---------------------------------------------------------------------------

export function isExpired(request: ApprovalRequest): boolean {
  if (request.status === "approved" || request.status === "rejected") {
    return false;
  }

  if (request.expiresAt === undefined) {
    return false;
  }

  return Date.now() > Date.parse(request.expiresAt);
}

// ---------------------------------------------------------------------------
// resolveApproval
// ---------------------------------------------------------------------------

export function resolveApproval(
  request: ApprovalRequest,
  decision: "approved" | "rejected",
): ApprovalRequest {
  return {
    ...request,
    status: decision,
  };
}
