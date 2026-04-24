import type { ApprovalId, ApprovalRequest, RunId } from "../shared/types.js";
import { approvalRequestSchema, parseBoundary } from "../shared/schemas.js";
import {
  atomicWriteJson,
  CorruptError,
  entityDir,
  entityPath,
  listJsonFiles,
  NotFoundError,
  readJsonFile,
} from "./atomic.js";

const KIND = "approvals";

function approvalFilePath(root: string, id: ApprovalId): string {
  return entityPath(root, KIND, id);
}

export async function saveApprovalRequest(root: string, request: ApprovalRequest): Promise<void> {
  await atomicWriteJson(approvalFilePath(root, request.id), request);
}

export async function loadApprovalRequest(root: string, id: ApprovalId): Promise<ApprovalRequest> {
  const path = approvalFilePath(root, id);
  const raw = await readJsonFile(path);

  if (raw === undefined) {
    throw new NotFoundError(KIND, id);
  }

  try {
    return parseBoundary<ApprovalRequest>(approvalRequestSchema, raw, "approval-request");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}

export async function listApprovalRequests(root: string, runId?: RunId): Promise<ApprovalRequest[]> {
  const dir = entityDir(root, KIND);
  const files = await listJsonFiles(dir);
  const requests: ApprovalRequest[] = [];

  for (const name of files) {
    const id = name.replace(/\.json$/u, "") as ApprovalId;
    const path = entityPath(root, KIND, id);

    let raw: unknown;
    try {
      raw = await readJsonFile(path);
    } catch {
      continue;
    }

    let request: ApprovalRequest;
    try {
      request = parseBoundary<ApprovalRequest>(approvalRequestSchema, raw, "approval-request");
    } catch {
      continue;
    }

    if (runId === undefined || request.runId === runId) {
      requests.push(request);
    }
  }

  return requests.sort((lhs, rhs) => {
    const left = lhs.expiresAt ?? "";
    const right = rhs.expiresAt ?? "";
    return left.localeCompare(right);
  });
}
