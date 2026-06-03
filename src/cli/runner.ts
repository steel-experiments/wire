import type { ActionId, Artifact, ComparisonDimension, ExperimentBundle, PolicyDecision, Run, RunClassification, RunId, Task, TaskId, TraceEvent } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { saveTask, loadTask } from "../storage/tasks.js";
import { saveExperimentBundle, saveHypothesis, saveRun } from "../storage/runs.js";
import { saveSession } from "../storage/sessions.js";
import { saveTraceEvents } from "../storage/events.js";
import { saveArtifact } from "../storage/artifacts.js";
import { saveTraceBlobValue } from "../storage/blobs.js";
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
import { isExpired, resolveApproval } from "../policy/approvals.js";
import { stopBrowserSession } from "../browser/session.js";
import type { BrowserProvider } from "../browser/bridge.js";
import { createPolicyEngine, type PolicyEngine } from "../policy/engine.js";
import type { PolicyAction } from "../policy/rules.js";
import { createSteelProvider, createSteelActionHandlers } from "../providers/browser/steel.js";
import type { LLMProvider } from "../providers/llm/openai.js";
import { createOpenAIProvider } from "../providers/llm/openai.js";
import { createAnthropicProvider } from "../providers/llm/anthropic.js";
import { executeTask, resumeTask, type RuntimeConfig } from "../agent/runtime.js";
import { shouldBranch } from "../agent/branching.js";
import { createHypothesis } from "../experiments/hypotheses.js";
import { buildExperimentSummary, formatExperimentSummary } from "../experiments/summaries.js";
import type { LlmProvider } from "./config.js";
import type { SessionConfig } from "../shared/types.js";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createConsoleTraceSink } from "../ui/stream.js";
import { defaultSkillDir, defaultStorageRoot } from "../shared/paths.js";

// Result types

export interface RunResult {
  taskId: TaskId;
  runId: RunId;
  status: string;
  classification?: string | undefined;
  confidence?: number | undefined;
  result?: string | undefined;
  summary?: string | undefined;
  debugUrl?: string | undefined;
  artifacts?: ArtifactSummary[] | undefined;
  approval?: { id: string; runId: RunId } | undefined;
  branches?: number | undefined;
  experimentId?: string | undefined;
}

export interface ArtifactSummary {
  id: string;
  filename?: string;
  kind: string;
  mimeType?: string;
  path: string;
}

export interface ApproveResult {
  approved: boolean;
  approvalId: string;
  runId: RunId;
  status: string;
  result?: string | undefined;
  artifacts?: ArtifactSummary[] | undefined;
}

// Run options

export interface RunOptions {
  objective: string;
  mode?: "task" | "investigate" | "experiment";
  profileId?: string;
  provider?: LlmProvider;
  model?: string;
  maxSteps?: number;
  skillDir?: string;
  sessionConfig?: SessionConfig;
  json?: boolean;
  yes?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  color?: boolean;
  keepSessionOpen?: boolean;
  traceLlmMessages?: boolean;
  criticalPointReview?: boolean;
}

// Auto-approving policy decorator (--yes mode)

function autoApprovingEngine(inner: PolicyEngine): PolicyEngine {
  return {
    check(actionId: ActionId, action: PolicyAction): PolicyDecision {
      const d = inner.check(actionId, action);
      return d.result === "require-approval" ? { ...d, result: "allow" as const } : d;
    },
  };
}

// Helpers

/**
 * Resolve the skills directory in priority order:
 *   1. explicit --skill-dir option
 *   2. $WIRE_SKILLS env var (use this when wire is spawned from an arbitrary cwd)
 *   3. ~/.wire/skills by default
 *
 * Exported so we can test the precedence and so external embedders can call
 * it before constructing a RuntimeConfig.
 */
export function resolveSkillDir(
  explicit?: string,
  env: { WIRE_SKILLS?: string } = process.env as { WIRE_SKILLS?: string },
): string {
  if (explicit !== undefined && explicit.length > 0) return explicit;
  if (env.WIRE_SKILLS !== undefined && env.WIRE_SKILLS.length > 0) return env.WIRE_SKILLS;
  return defaultSkillDir();
}

function inferProviderFromModel(model?: string): LlmProvider | undefined {
  if (!model) {
    return undefined;
  }

  if (/^(gpt-|o[1-9]|o\d|chatgpt-)/u.test(model)) {
    return "openai";
  }

  if (/^claude-/u.test(model)) {
    return "anthropic";
  }

  return undefined;
}

export function resolveProviderSelection(provider?: LlmProvider, model?: string): LlmProvider | undefined {
  const inferred = inferProviderFromModel(model);
  if (provider && inferred && provider !== inferred) {
    throw new Error(`Model "${model}" does not match provider "${provider}".`);
  }

  if (provider) {
    return provider;
  }

  if (inferred) {
    return inferred;
  }

  const hasOpenAi = Boolean(process.env.OPENAI_API_KEY);
  const hasAnthropic = Boolean(process.env.ANTHROPIC_API_KEY);

  if (hasOpenAi && !hasAnthropic) {
    return "openai";
  }

  if (hasAnthropic && !hasOpenAi) {
    return "anthropic";
  }

  if (hasOpenAi && hasAnthropic) {
    throw new Error("Multiple LLM providers are configured. Set `llm.provider`, `WIRE_PROVIDER`, or `--provider`.");
  }

  return undefined;
}

function createLlmProvider(provider?: LlmProvider, model?: string): LLMProvider | undefined {
  const selectedProvider = resolveProviderSelection(provider, model);
  if (selectedProvider === "openai") {
    return createOpenAIProvider(model ? { model } : undefined);
  }

  if (selectedProvider === "anthropic") {
    return createAnthropicProvider(model ? { model } : undefined);
  }

  return undefined;
}

function defaultMaxSteps(mode: "task" | "investigate" | "experiment"): number {
  switch (mode) {
    case "investigate": return 20;
    case "experiment": return 25;
    default: return 30;
  }
}

/** Resolve whether critical-point review runs. An explicit choice (CLI flag)
 *  always wins; otherwise it is on by default in every mode. `mode` is kept in
 *  the signature so callers can opt a mode out later without a signature churn. */
export function resolveCriticalPointReview(
  _mode: "task" | "investigate" | "experiment" | undefined,
  explicit: boolean | undefined,
): boolean {
  if (explicit !== undefined) return explicit;
  return true;
}

function createRuntimeConfig(
  options: Pick<RunOptions, "profileId" | "maxSteps" | "skillDir" | "sessionConfig" | "provider" | "model" | "yes" | "json" | "mode" | "verbose" | "quiet" | "color" | "keepSessionOpen" | "traceLlmMessages" | "criticalPointReview">,
): RuntimeConfig {
  let policyEngine: PolicyEngine = createPolicyEngine();
  if (options.yes) {
    policyEngine = autoApprovingEngine(policyEngine);
  }

  const isJson = options.json === true;
  const maxSteps = options.maxSteps ?? defaultMaxSteps(options.mode ?? "task");

  const config: RuntimeConfig = {
    provider: createSteelProvider(),
    actionHandlers: createSteelActionHandlers(),
    policyEngine,
    maxSteps,
    async onSessionCreated(session) {
      const url = session.debugUrl ?? session.liveUrl;
      if (!isJson && url) {
        console.log(`Debug URL:    ${url}`);
        console.log("");
      }
      await saveSession(defaultStorageRoot(), session);
    },
    async onSessionReconfigured({ oldSessionId, newSession, summary }) {
      const url = newSession.debugUrl ?? newSession.liveUrl;
      if (!isJson) {
        console.log(`Session reconfigured: ${summary}`);
        console.log(`Old session: ${oldSessionId}`);
        console.log(`New session: ${newSession.id}`);
        if (url) {
          console.log(`Debug URL:    ${url}`);
        }
        console.log("");
      }
      await saveSession(defaultStorageRoot(), newSession);
    },
  };
  if (options.keepSessionOpen) config.keepSessionOpen = true;
  // Critical-point review is the strongest anti-laziness check (judge each
  // objective sub-point separately). On by default in every mode; opt out with
  // --no-critical-points.
  if (resolveCriticalPointReview(options.mode, options.criticalPointReview)) {
    config.criticalPointReview = true;
  }
  if (options.traceLlmMessages === true || process.env.WIRE_TRACE_LLM_MESSAGES === "1") {
    config.traceLlmMessages = true;
    config.saveTraceBlob = async (runId, kind, value, contentType) => {
      const blob = await saveTraceBlobValue(defaultStorageRoot(), runId, kind, value, contentType);
      return { hash: blob.hash, size: blob.size, kind: blob.kind };
    };
  }

  if (!isJson && options.quiet !== true) {
    const sinkOpts: Parameters<typeof createConsoleTraceSink>[0] = { maxSteps };
    if (options.verbose !== undefined) sinkOpts.verbose = options.verbose;
    if (options.color !== undefined) sinkOpts.color = options.color;
    const consoleSink = createConsoleTraceSink(sinkOpts);
    config.traceSink = { onEvent: (event) => consoleSink.onEvent(event) };
  }

  const llmProvider = createLlmProvider(options.provider, options.model);
  if (llmProvider) {
    config.llmProvider = llmProvider;
  }
  config.skillDir = resolveSkillDir(options.skillDir);
  config.sessionInput = { timeoutMinutes: Math.max(15, Math.ceil(maxSteps * 30 / 60)) };
  if (options.profileId || options.sessionConfig) {
    if (options.profileId) config.sessionInput.profileId = options.profileId as never;
    if (options.sessionConfig) config.sessionInput.sessionConfig = options.sessionConfig;
  }

  return config;
}

function fallbackClassification(): RunClassification {
  return { kind: "ambiguous", confidence: 0.3, notes: ["No classification returned"] };
}

function artifactSummaries(artifacts: Artifact[]): ArtifactSummary[] | undefined {
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

function printArtifacts(artifacts: Artifact[]): void {
  const summaries = artifactSummaries(artifacts);
  if (!summaries) {
    return;
  }

  console.log("Artifacts:");
  for (const artifact of summaries) {
    const filename = artifact.filename ? `${artifact.filename}: ` : "";
    const mime = artifact.mimeType ? ` (${artifact.mimeType})` : "";
    console.log(`  - ${filename}${artifact.path}${mime}`);
  }
}

export function createExperimentBundleFromRuns(
  taskId: Task["id"],
  runs: Run[],
  hypothesis = createHypothesis(
    taskId,
    "Current strategy can satisfy the objective",
    "Autogenerated from experiment-mode branching",
  ),
): ExperimentBundle {
  const comparisons = [];
  for (let i = 1; i < runs.length; i++) {
    comparisons.push({
      id: createId("comparison"),
      lhsRunId: runs[i - 1]!.id,
      rhsRunId: runs[i]!.id,
      dimensions: ["latency", "path", "artifacts", "outcome"] as ComparisonDimension[],
    });
  }

  const bundle: ExperimentBundle = {
    id: createId("experiment"),
    taskId,
    hypotheses: [hypothesis],
    runIds: runs.map((run) => run.id),
    comparisons,
  };
  bundle.summary = buildExperimentSummary(bundle, runs);

  return bundle;
}

// Artifact persistence

async function persistExecutionArtifacts(
  root: string,
  task: Task,
  result: Awaited<ReturnType<typeof executeTask>>,
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

async function persistTraceArtifacts(root: string, events: TraceEvent[]): Promise<Artifact[]> {
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
    if (content !== undefined) {
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
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

    if (content !== undefined) {
      const blob = await saveTraceBlobValue(root, event.runId, "artifact-content", content, mimeType);
      artifact.metadata.contentHash = blob.hash;
      artifact.metadata.contentSize = Buffer.byteLength(content, "utf8");
      artifact.metadata.contentPreview = content.length > 500 ? `${content.slice(0, 500)}...` : content;
    }

    await saveArtifact(root, artifact);
    artifacts.push(artifact);
  }

  return artifacts;
}

// Release Steel sessions abandoned at an approval gate past their expiresAt.
// Awaiting-approval runs keep the browser session alive for resume; if the
// human never approves, the session would leak without this sweep.
export async function reapExpiredApprovals(
  root: string,
  provider: BrowserProvider,
  log?: (msg: string) => void,
): Promise<number> {
  const approvals = await listApprovalRequests(root).catch(() => []);
  let reaped = 0;
  for (const req of approvals) {
    if (req.status !== "pending" || !isExpired(req)) continue;
    const checkpoint = await loadRunCheckpoint(root, req.runId).catch(() => undefined);
    if (checkpoint) {
      await stopBrowserSession(provider, checkpoint.sessionId).catch(() => {});
      await deleteRunCheckpoint(root, req.runId);
    }
    await saveApprovalRequest(root, { ...req, status: "expired" });
    reaped += 1;
    log?.(`Released expired approval ${req.id} (run ${req.runId}${checkpoint ? `, session ${checkpoint.sessionId}` : ""}).`);
  }
  return reaped;
}

// runTask — returns RunResult

export async function runTask(options: RunOptions): Promise<RunResult> {
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

  const isJson = options.json === true;
  const config = createRuntimeConfig(options);

  await reapExpiredApprovals(
    root,
    config.provider,
    isJson ? undefined : (msg) => console.log(msg),
  );

  if (!isJson) {
    console.log(`Task created: ${task.id}`);
    console.log(`Objective:    ${options.objective}`);
    console.log(`Mode:         ${mode}`);
    if (config.llmProvider) {
      const effort = config.llmProvider.reasoningEffort;
      console.log(`Model:        ${config.llmProvider.model}${effort ? ` / ${effort}` : ""}`);
    }
    console.log("");
  }

  const result = await executeTask(task, config);
  const artifacts = await persistExecutionArtifacts(root, task, result);

  const runResults = [result];
  const runs = [result.run];
  let latestArtifacts = artifacts;

  if (mode === "experiment") {
    const maxRuns = task.budget?.maxRuns ?? 3;
    const hypothesis = createHypothesis(
      task.id,
      "Current strategy can satisfy the objective",
      "Autogenerated from experiment-mode branching",
    );
    await saveHypothesis(root, hypothesis);

    result.run.hypothesisId = hypothesis.id;
    await saveRun(root, result.run);

    let parentRun = result.run;
    let lastClassification = result.run.classification ?? fallbackClassification();
    let runCount = 1;

    while (runCount < maxRuns) {
      const decision = shouldBranch(lastClassification, runCount, maxRuns);
      if (!decision.shouldBranch) {
        break;
      }

      // A branch run shares the parent's objective and contract but carries a
      // directive that steers it onto a different path — otherwise branching is
      // just replication. branchDirective is excluded from the contract, so
      // siblings are still graded identically.
      const branchTask: Task = decision.directive
        ? { ...task, branchDirective: decision.directive }
        : task;
      const branch = await executeTask(branchTask, config);
      branch.run.parentRunId = parentRun.id;
      branch.run.branchLabel = decision.branchLabel ?? `branch-${runCount}`;
      branch.run.hypothesisId = hypothesis.id;

      latestArtifacts = await persistExecutionArtifacts(root, task, branch);
      runResults.push(branch);
      runs.push(branch.run);
      parentRun = branch.run;
      lastClassification = branch.run.classification ?? fallbackClassification();
      runCount += 1;
    }
    const bundle = createExperimentBundleFromRuns(task.id, runs, hypothesis);
    await saveExperimentBundle(root, bundle);

    const last = runResults[runResults.length - 1]!;

    if (!isJson) {
      console.log(`Run finished: ${last.run.id}`);
      console.log(`Status:       ${last.run.status}`);
      console.log(
        `Classification: ${last.run.classification?.kind ?? "unknown"} (${(((last.run.classification?.confidence) ?? 0) * 100).toFixed(0)}%)`,
      );
      if (last.run.result) {
        console.log(`Result:       ${last.run.result}`);
      }
      if (last.run.outcomeSummary) {
        console.log(`Summary:      ${last.run.outcomeSummary}`);
      }
      printArtifacts(latestArtifacts);
      console.log(`Branches:     ${runResults.length}`);
      console.log(`Experiment:   ${bundle.id}`);
      if (bundle.summary) {
        console.log("");
        console.log(formatExperimentSummary(bundle.summary));
      }
    }

    return {
      taskId: task.id,
      runId: last.run.id,
      status: last.run.status,
      classification: last.run.classification?.kind ?? "unknown",
      confidence: last.run.classification?.confidence ?? 0,
      result: last.run.result,
      summary: last.run.outcomeSummary,
      debugUrl: last.sessionLiveUrl,
      artifacts: artifactSummaries(latestArtifacts),
      branches: runResults.length,
      experimentId: bundle.id,
    };
  }

  if (!isJson) {
    console.log(`Run finished: ${result.run.id}`);
    console.log(`Status:       ${result.run.status}`);
    console.log(
      `Classification: ${result.run.classification?.kind ?? "unknown"} (${(((result.run.classification?.confidence) ?? 0) * 100).toFixed(0)}%)`,
    );
    if (result.run.result) {
      console.log(`Result:       ${result.run.result}`);
    }
    if (result.run.outcomeSummary) {
      console.log(`Summary:      ${result.run.outcomeSummary}`);
    }
    printArtifacts(artifacts);
    if (result.pendingApproval) {
      console.log(`Approval:     ${result.pendingApproval.id} pending for run ${result.run.id}`);
    }
  }

  return {
    taskId: task.id,
    runId: result.run.id,
    status: result.run.status,
    classification: result.run.classification?.kind ?? "unknown",
    confidence: result.run.classification?.confidence ?? 0,
    result: result.run.result,
    summary: result.run.outcomeSummary,
    debugUrl: result.sessionLiveUrl,
    artifacts: artifactSummaries(artifacts),
    approval: result.pendingApproval
      ? { id: result.pendingApproval.id, runId: result.run.id }
      : undefined,
  };
}

function renderProposedAction(request: import("../shared/types.js").ApprovalRequest): void {
  console.log(`Approval:     ${request.id}`);
  console.log(`Summary:      ${request.summary}`);
  const detail = request.proposedAction;
  if (!detail) {
    console.log("");
    return;
  }
  const kindLabel = detail.riskKind ? `${detail.kind} (risk: ${detail.riskKind})` : detail.kind;
  console.log(`Action kind:  ${kindLabel}`);
  if (detail.reason) console.log(`Policy:       ${detail.reason}`);
  if (detail.cdpMethods?.length) console.log(`CDP methods:  ${detail.cdpMethods.join(", ")}`);
  if (detail.codeExcerpt) {
    console.log("Proposed code:");
    for (const line of detail.codeExcerpt.split("\n")) console.log(`  ${line}`);
    if (detail.truncated) console.log("  … (truncated)");
  }
  console.log("");
}

// approveRun — returns ApproveResult

export async function approveRun(runId: RunId, jsonOutput?: boolean): Promise<ApproveResult> {
  const root = defaultStorageRoot();
  const pending = (await listApprovalRequests(root, runId)).filter((request) => request.status === "pending");

  if (pending.length === 0) {
    if (!jsonOutput) {
      console.log(`No pending approvals found for ${runId}.`);
    }
    return { approved: false, approvalId: "", runId, status: "no-pending" };
  }

  // Check if any approval has expired
  for (const request of pending) {
    if (request.expiresAt && new Date(request.expiresAt) < new Date()) {
      if (!jsonOutput) {
        console.error(`Approval ${request.id} has expired.`);
      }
      process.exitCode = 1;
      return { approved: false, approvalId: request.id, runId, status: "expired" };
    }
  }

  if (!jsonOutput) {
    for (const request of pending) {
      renderProposedAction(request);
    }
  }

  for (const request of pending) {
    await saveApprovalRequest(root, resolveApproval(request, "approved"));
  }

  const checkpoint = await loadRunCheckpoint(root, runId);

  // Validate the checkpoint still exists and is for the correct run
  if (checkpoint.runId !== runId) {
    if (!jsonOutput) {
      console.error(`Checkpoint run ID mismatch: expected ${runId}, got ${checkpoint.runId}.`);
    }
    process.exitCode = 1;
    return { approved: false, approvalId: "", runId, status: "checkpoint-mismatch" };
  }

  const task = await loadTask(root, checkpoint.task.id);
  const approvedRequest = await loadApprovalRequest(root, checkpoint.approvalRequestId);

  if (approvedRequest.status === "expired") {
    if (!jsonOutput) {
      console.error(`Approval ${approvedRequest.id} has expired.`);
    }
    process.exitCode = 1;
    return { approved: false, approvalId: approvedRequest.id, runId, status: "expired" };
  }

  const resumed = await resumeTask(
    checkpoint,
    createRuntimeConfig({ maxSteps: 15, mode: checkpoint.task.mode }),
    undefined,
  );

  const artifacts = await persistExecutionArtifacts(root, task, resumed);

  if (!jsonOutput) {
    console.log(`Approved:     ${approvedRequest.id}`);
    console.log(`Run resumed:  ${runId}`);
    console.log(`Task:         ${task.title}`);
    console.log(`Status:       ${resumed.run.status}`);
    if (resumed.run.result) {
      console.log(`Result:       ${resumed.run.result}`);
    }
    console.log(`Summary:      ${resumed.run.outcomeSummary ?? ""}`);
    printArtifacts(artifacts);
  }

  return {
    approved: true,
    approvalId: approvedRequest.id,
    runId,
    status: resumed.run.status,
    result: resumed.run.result,
    artifacts: artifactSummaries(artifacts),
  };
}
