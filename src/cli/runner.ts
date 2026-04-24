import type { RunId, Task } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { saveTask, loadTask } from "../storage/tasks.js";
import { saveRun } from "../storage/runs.js";
import { saveSession } from "../storage/sessions.js";
import { saveTraceEvents } from "../storage/events.js";
import {
  loadApprovalRequest,
  listApprovalRequests,
  saveApprovalRequest,
} from "../storage/approvals.js";
import {
  deleteRunCheckpoint,
  loadRunCheckpoint,
  saveRunCheckpoint,
} from "../storage/checkpoints.js";
import { resolveApproval } from "../policy/approvals.js";
import { createPolicyEngine } from "../policy/engine.js";
import { createSteelProvider } from "../providers/browser/steel.js";
import type { LLMProvider } from "../providers/llm/openai.js";
import { createOpenAIProvider } from "../providers/llm/openai.js";
import { createAnthropicProvider } from "../providers/llm/anthropic.js";
import { executeTask, resumeTask, type RuntimeConfig } from "../agent/runtime.js";

export interface RunOptions {
  objective: string;
  mode?: "task" | "investigate" | "experiment";
  profileId?: string;
  model?: string;
  maxSteps?: number;
  skillDir?: string;
}

function defaultStorageRoot(): string {
  return process.env["WIRE_ROOT"] ?? ".wire";
}

function createLlmProvider(model?: string): LLMProvider | undefined {
  if (process.env.OPENAI_API_KEY) {
    return createOpenAIProvider(model ? { model } : undefined);
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider(model ? { model } : undefined);
  }

  return undefined;
}

function createRuntimeConfig(
  options: Pick<RunOptions, "profileId" | "maxSteps" | "skillDir" | "model">,
): RuntimeConfig {
  const config: RuntimeConfig = {
    provider: createSteelProvider(),
    policyEngine: createPolicyEngine(),
    maxSteps: options.maxSteps ?? 10,
    async onSessionCreated(session) {
      await saveSession(defaultStorageRoot(), session);
    },
  };

  const llmProvider = createLlmProvider(options.model);
  if (llmProvider) {
    config.llmProvider = llmProvider;
  }
  if (options.skillDir) {
    config.skillDir = options.skillDir;
  }
  if (options.profileId) {
    config.sessionInput = { profileId: options.profileId as never };
  }

  return config;
}

async function persistExecutionArtifacts(
  root: string,
  task: Task,
  result: Awaited<ReturnType<typeof executeTask>>,
): Promise<void> {
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
      pendingAction: result.pendingAction,
      approvalRequestId: result.pendingApproval.id,
      savedAt: nowIsoUtc(),
    });
  } else {
    await deleteRunCheckpoint(root, result.run.id);
  }
}

export async function runTask(options: RunOptions): Promise<void> {
  const root = defaultStorageRoot();
  const mode = options.mode ?? "task";

  const task: Task = {
    id: createId("task"),
    title: options.objective,
    mode,
    objective: options.objective,
    constraints: [],
    successCriteria: ["Task objective achieved"],
    createdAt: nowIsoUtc(),
  };

  console.log(`Task created: ${task.id}`);
  console.log(`Objective:    ${options.objective}`);
  console.log(`Mode:         ${mode}`);
  console.log("");

  const config = createRuntimeConfig(options);
  const result = await executeTask(task, config);

  await persistExecutionArtifacts(root, task, result);

  console.log(`Run finished: ${result.run.id}`);
  console.log(`Status:       ${result.run.status}`);
  console.log(
    `Classification: ${result.run.classification?.kind ?? "unknown"} (${(((result.run.classification?.confidence) ?? 0) * 100).toFixed(0)}%)`,
  );
  if (result.run.outcomeSummary) {
    console.log(`Summary:      ${result.run.outcomeSummary}`);
  }
  if (result.pendingApproval) {
    console.log(`Approval:     ${result.pendingApproval.id} pending for run ${result.run.id}`);
  }
}

export async function approveRun(runId: RunId): Promise<void> {
  const root = defaultStorageRoot();
  const pending = (await listApprovalRequests(root, runId)).filter((request) => request.status === "pending");

  if (pending.length === 0) {
    console.log(`No pending approvals found for ${runId}.`);
    return;
  }

  for (const request of pending) {
    await saveApprovalRequest(root, resolveApproval(request, "approved"));
  }

  const checkpoint = await loadRunCheckpoint(root, runId);
  const task = await loadTask(root, checkpoint.task.id);
  const approvedRequest = await loadApprovalRequest(root, checkpoint.approvalRequestId);
  const resumed = await resumeTask(
    checkpoint,
    createRuntimeConfig({ maxSteps: 10 }),
    undefined,
  );

  await persistExecutionArtifacts(root, task, resumed);

  console.log(`Approved:     ${approvedRequest.id}`);
  console.log(`Run resumed:  ${runId}`);
  console.log(`Task:         ${task.title}`);
  console.log(`Status:       ${resumed.run.status}`);
  console.log(`Summary:      ${resumed.run.outcomeSummary ?? ""}`);
}
