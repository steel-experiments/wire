import type {
  ArtifactId,
  BrowserSession,
  CreateSessionInput,
  JsonObject,
  LoadedSkill,
  ProposedAction,
  RunCheckpoint,
  Task,
  TraceEvent,
} from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";

import type { BrowserProvider } from "../browser/bridge.js";
import { createBrowserSession, stopBrowserSession } from "../browser/session.js";

import type { PolicyEngine } from "../policy/engine.js";

import type { LLMProvider, ChatMessage } from "../providers/llm/openai.js";

import {
  createLoopState,
  executeStep,
  finalizeRun,
  shouldStop,
  type LoopState,
  type LoopResult,
  type AgentTurnFn,
} from "./loop.js";
import { assembleSystemPrompt, assembleUserPrompt, type ContextBundle } from "./context.js";
import { createPlan, planToContext, advancePlanBy, type TaskPlan } from "./planning.js";
import { observeBrowser } from "../browser/observe.js";
import { detectAuthWall } from "../profiles/auth.js";
import { llmProposeSkill, generateSkillProposal, promoteSkill } from "../skills/promote.js";
import { findMatchingSkillDocs } from "../skills/loader.js";

// ---------------------------------------------------------------------------
// RuntimeConfig — what the runtime needs to run
// ---------------------------------------------------------------------------

export interface RuntimeConfig {
  provider: BrowserProvider;
  policyEngine: PolicyEngine;
  llmProvider?: LLMProvider;
  maxSteps: number;
  skillDir?: string;
  sessionInput?: CreateSessionInput;
  onSessionCreated?: (session: BrowserSession) => Promise<void> | void;
}

const ACTION_KINDS = new Set<ProposedAction["kind"]>([
  "observe",
  "exec",
  "request-approval",
  "branch-experiment",
  "load-skill",
  "propose-skill",
  "finish",
]);

function hostnameFromState(state: LoopState): string | undefined {
  const observation = latestObservation(state);
  const url = typeof observation?.payload.url === "string" ? observation.payload.url : undefined;
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function deriveSkillTags(task: Task): string[] {
  const words = `${task.title} ${task.objective} ${task.successCriteria.join(" ")}`.match(/[a-z0-9-]{4,}/giu) ?? [];
  const tags = new Set<string>();
  for (const word of words) {
    tags.add(word.toLowerCase());
    if (tags.size >= 12) {
      break;
    }
  }
  tags.add(task.mode);
  return [...tags];
}

function skillGuidance(skill: LoadedSkill): string {
  const preferredSections = ["Facts", "Routes", "Selectors", "Traps", "Workflow", "Notes"];
  const snippets: string[] = [];

  for (const section of preferredSections) {
    const body = skill.sections[section];
    if (body && body.trim().length > 0) {
      snippets.push(`${section}: ${body.trim().replace(/\s+/gu, " ").slice(0, 180)}`);
    }
    if (snippets.length >= 2) {
      break;
    }
  }

  if (snippets.length === 0) {
    const fallback = skill.body.replace(/\s+/gu, " ").trim();
    return fallback.slice(0, 220);
  }

  return snippets.join(" | ");
}

async function syncMatchedSkills(state: LoopState, skillDir?: string): Promise<void> {
  if (!skillDir) {
    state.loadedSkills = [];
    return;
  }

  const hostname = hostnameFromState(state);
  const tags = deriveSkillTags(state.task);
  const matched = await findMatchingSkillDocs(skillDir, hostname, tags);
  const previousIds = state.loadedSkills.map((skill) => skill.id).join(",");
  const nextIds = matched.map((skill) => skill.id).join(",");
  state.loadedSkills = matched;

  if (previousIds === nextIds) {
    return;
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "skill-load",
    payload: {
      skills: matched.map((skill) => skill.id),
      hostname: hostname ?? "",
      source: skillDir,
    },
  });
}

function estimatePlanSignals(state: LoopState): number {
  const successfulExecs = state.events.filter((event) =>
    event.kind === "code-result" && event.payload.ok === true
  ).length;
  const observations = state.events.filter((event) => event.kind === "observation").length;
  const additionalObservations = Math.max(0, observations - 1);
  return successfulExecs + additionalObservations;
}

function planForState(state: LoopState): TaskPlan {
  const basePlan = createPlan(state.task);
  return advancePlanBy(basePlan, estimatePlanSignals(state));
}

// ---------------------------------------------------------------------------
// defaultAgentTurn — uses LLM if available, falls back to observe+finish
// ---------------------------------------------------------------------------

export function defaultAgentTurn(llmProvider?: LLMProvider): AgentTurnFn {
  return async (state: LoopState, provider: BrowserProvider): Promise<ProposedAction> => {
    const taskPlan = planForState(state);

    // Build a minimal context bundle from the loop state
    const observations = state.events
      .filter((e) => e.kind === "observation")
      .slice(-3)
      .map((e) => {
        const ps = e.payload.pageSummary as Record<string, unknown> | undefined;
        const texts = Array.isArray(ps?.visibleTexts) ? ps!.visibleTexts as string[] : undefined;
        return {
          url: String(e.payload.url ?? ""),
          title: String(e.payload.title ?? ""),
          forms: typeof ps?.forms === "number" ? ps.forms : 0,
          buttons: typeof ps?.buttons === "number" ? ps.buttons : 0,
          dialogs: typeof ps?.dialogs === "number" ? ps.dialogs : 0,
          visibleTexts: texts,
        };
      });

    const recentTraces = state.events.slice(-5).map((e) => {
      let summary: string;
      switch (e.kind) {
        case "code-exec":
          summary = String(e.payload.code ?? e.kind);
          break;
        case "code-result":
          summary = e.payload.ok
            ? `ok: ${String(e.payload.stdout ?? "no output")}`
            : `error: ${String(e.payload.stderr ?? "unknown")}`;
          break;
        case "observation":
          summary = `page: ${String(e.payload.url ?? "?")} title="${String(e.payload.title ?? "")}"`;
          break;
        case "error":
          summary = `${String(e.payload.code ?? "error")}: ${String(e.payload.message ?? "")}`;
          break;
        default:
          summary = String(e.payload.summary ?? e.kind);
      }
      return { kind: e.kind, summary };
    });

    const context: ContextBundle = {
      task: {
        mode: state.task.mode,
        objective: state.task.objective,
        constraints: state.task.constraints,
        successCriteria: state.task.successCriteria,
      },
      skills: state.loadedSkills.map((skill) => ({
        id: skill.id,
        scope: skill.scope,
        matchReason: skill.hostnamePatterns?.length
          ? `Matched current site and task tags`
          : "Matched task tags",
        guidance: skillGuidance(skill),
      })),
      observations,
      recentTraces,
      policyNotes: [],
      plan: planToContext(taskPlan),
    };

    // If an LLM provider is available, use it to decide the next action
    if (llmProvider) {
      const actionInstructions = [
        "Return exactly one next action as JSON.",
        'Use this shape: {"kind":"observe|exec|finish","summary":"short text","payload":{...}}.',
        'For "observe", omit payload unless you need {"targetId":"..."}',
        'For "exec", set payload.code to JavaScript that runs in the browser.',
        "Prefer direct URL patterns before brittle DOM hunting when the destination is obvious, such as /pricing or /docs.",
        "Wire auto-observes after navigation code (location.href etc). Do NOT emit a separate observe after navigating.",
        "CRITICAL: navigation alone is NOT task completion. After reaching the target page, you MUST emit a final exec that EXTRACTS the answer as a JSON object or plain text string.",
        "Example: after navigating to a pricing page, emit exec with code like `return JSON.stringify({plans: [...extracted data...]})` or use `document.querySelectorAll` to collect the data and return it.",
        "Use reusable routes, selectors, waits, and traps you discover in executable code; Wire will propose durable skill files after the run from trace evidence.",
        "Only use 'finish' after a successful exec has produced output containing the answer to the objective. Never finish after only navigation and observation.",
        "Do not wrap the JSON in prose.",
      ].join("\n");

      const systemPrompt = assembleSystemPrompt(context);
      const userPrompt = `${assembleUserPrompt(context)}\n\n${actionInstructions}`;

      const messages: ChatMessage[] = [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ];

      const response = await llmProvider.chat(messages);

      // Parse the LLM response as a proposed action
      return parseActionFromLlm(response.content, state);
    }

    // Fallback: observe the browser, then finish
    const hasRecentObservation = state.events.some(
      (e) => e.kind === "observation" && state.events.indexOf(e) === state.events.length - 1,
    );

    if (!hasRecentObservation) {
      return {
        kind: "observe",
        summary: "Observe current browser state",
      };
    }

    return {
      kind: "finish",
      summary: `Task step complete: ${state.task.objective}`,
    };
  };
}

// ---------------------------------------------------------------------------
// parseActionFromLlm — extract a ProposedAction from LLM text output
// ---------------------------------------------------------------------------

function parseActionFromLlm(content: string, state: LoopState): ProposedAction {
  // Try to find a JSON action block in the response
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/u);
  const candidates = [
    jsonMatch?.[1],
    content.trim(),
    extractFirstJsonObject(content),
  ];

  for (const candidate of candidates) {
    if (!candidate) {
      continue;
    }

    const parsed = tryParseAction(candidate);
    if (parsed) {
      return parsed;
    }
  }

  const hasObservation = state.events.some((event) => event.kind === "observation");

  // Bias toward gathering evidence instead of silently finishing on malformed output.
  if (!hasObservation) {
    return {
      kind: "observe",
      summary: "Observe current browser state",
    };
  }

  return {
    kind: "finish",
    summary: `Model returned an invalid action payload: ${content.slice(0, 400)}`,
  };
}

function tryParseAction(content: string): ProposedAction | undefined {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (
      typeof parsed.kind === "string" &&
      ACTION_KINDS.has(parsed.kind as ProposedAction["kind"]) &&
      typeof parsed.summary === "string"
    ) {
      const action: ProposedAction = {
        kind: parsed.kind as ProposedAction["kind"],
        summary: parsed.summary,
      };
      if (parsed.payload && typeof parsed.payload === "object" && parsed.payload !== null) {
        action.payload = parsed.payload as JsonObject;
      }
      return action;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractFirstJsonObject(content: string): string | undefined {
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }
  return content.slice(start, end + 1);
}

function latestObservation(state: LoopState): TraceEvent | undefined {
  return [...state.events].reverse().find((event) => event.kind === "observation");
}

function latestError(state: LoopState): TraceEvent | undefined {
  return [...state.events].reverse().find((event) => event.kind === "error");
}

function hasRecordedTaskArtifact(state: LoopState): boolean {
  return state.events.some((event) =>
    event.kind === "artifact" &&
    typeof event.payload.kind === "string" &&
    typeof event.payload.content === "string" &&
    event.payload.content.trim().length > 0
  );
}

function latestCodeResult(state: LoopState): TraceEvent | undefined {
  return [...state.events].reverse().find((event) => event.kind === "code-result");
}

function hasExtractedTaskResult(state: LoopState): boolean {
  const result = latestCodeResult(state);
  if (!result || result.payload.ok !== true) {
    return false;
  }

  return (
    (typeof result.payload.stdout === "string" && result.payload.stdout.trim().length > 0) ||
    result.payload.returnValue !== undefined
  );
}

function hasAttemptedSyntheticExtraction(state: LoopState): boolean {
  return state.events.some((event) =>
    event.kind === "code-exec" &&
    typeof event.payload.code === "string" &&
    event.payload.code.includes("wire:extract-result")
  );
}

function buildSyntheticExtractionAction(): ProposedAction {
  const code = `(() => {
  /* wire:extract-result */
  const clean = (value) => value.replace(/\\s+/g, " ").trim();
  const visibleText = (value) => {
    if (!value) return "";
    return clean(value);
  };
  const priceRegex = /(?:US\\$|\\$|EUR\\s?|GBP\\s?|CAD\\s?)\\s?\\d[\\d,]*(?:\\.\\d{2})?/g;
  const cardSelectors = [
    '[data-testid*="property-card"]',
    '[data-testid*="search-result"]',
    '[data-testid*="card"]',
    'article',
    'li',
    'div'
  ];
  const cards = [];
  const seen = new Set();
  for (const selector of cardSelectors) {
    for (const node of Array.from(document.querySelectorAll(selector))) {
      if (!(node instanceof HTMLElement)) continue;
      const text = visibleText(node.innerText || node.textContent || "");
      if (text.length < 40) continue;
      const link = node.querySelector('a[href]');
      const titleNode = node.querySelector('h1, h2, h3, [data-testid*="title"], strong, b') || link;
      const title = visibleText(titleNode?.textContent || "");
      if (!title) continue;
      const href = link instanceof HTMLAnchorElement ? link.href : undefined;
      const prices = Array.from(new Set(text.match(priceRegex) || [])).slice(0, 3);
      const key = [title, href || "", prices.join("|")].join("::");
      if (seen.has(key)) continue;
      seen.add(key);
      cards.push({
        title,
        href,
        prices,
        snippet: text.slice(0, 280),
      });
      if (cards.length >= 10) break;
    }
    if (cards.length >= 10) break;
  }
  const tables = Array.from(document.querySelectorAll('table')).slice(0, 3).map((table) => {
    const rows = Array.from(table.querySelectorAll('tr')).slice(0, 8).map((row) =>
      Array.from(row.querySelectorAll('th,td')).map((cell) => visibleText(cell.textContent || "")).filter(Boolean)
    ).filter((row) => row.length > 0);
    return rows;
  }).filter((rows) => rows.length > 0);
  const headings = Array.from(document.querySelectorAll('h1,h2,h3')).map((el) => visibleText(el.textContent || "")).filter(Boolean).slice(0, 10);
  return {
    objective: "Extract final task result from the current page",
    title: document.title,
    url: location.href,
    headings,
    cards,
    tables,
  };
})()`;

  return {
    kind: "exec",
    summary: "Extract final task result from the current page",
    payload: { code },
  };
}

function appendExtractedResultArtifact(state: LoopState): void {
  const result = latestCodeResult(state);
  if (!result || result.payload.ok !== true) {
    return;
  }

  const artifactId = createId("artifact") as ArtifactId;
  let kind: "json-output" | "note" = "note";
  let mimeType = "text/plain";
  let extension = "txt";
  let content: string | undefined;

  if (result.payload.returnValue !== undefined) {
    kind = "json-output";
    mimeType = "application/json";
    extension = "json";
    content = JSON.stringify(result.payload.returnValue, null, 2);
  } else if (typeof result.payload.stdout === "string" && result.payload.stdout.trim().length > 0) {
    const stdout = result.payload.stdout.trim();
    try {
      const parsed = JSON.parse(stdout) as unknown;
      if (parsed !== null && typeof parsed === "object") {
        kind = "json-output";
        mimeType = "application/json";
        extension = "json";
        content = JSON.stringify(parsed, null, 2);
      } else {
        content = stdout;
      }
    } catch {
      content = stdout;
    }
  }

  if (!content) {
    return;
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      kind,
      mimeType,
      path: `artifacts/${artifactId}.${extension}`,
      content,
    },
  });
}

function appendTaskNoteArtifact(state: LoopState, summary: string): void {
  const artifactId = createId("artifact") as ArtifactId;
  const observation = latestObservation(state);
  const lines = [summary.trim()];

  if (observation) {
    const title = typeof observation.payload.title === "string" ? observation.payload.title : undefined;
    const url = typeof observation.payload.url === "string" ? observation.payload.url : undefined;
    if (title) {
      lines.push(`Title: ${title}`);
    }
    if (url) {
      lines.push(`URL: ${url}`);
    }
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "artifact",
    payload: {
      artifactId,
      kind: "note",
      mimeType: "text/plain",
      path: `artifacts/${artifactId}.txt`,
      content: lines.join("\n"),
    },
  });
}

function hasMeaningfulProgress(state: LoopState): boolean {
  const observations = state.events.filter((event) => event.kind === "observation");
  const codeExecs = state.events.filter((event) => event.kind === "code-exec");
  return observations.length > 1 || codeExecs.length > 0;
}

function buildFailureSummary(state: LoopState): string | undefined {
  if (!hasMeaningfulProgress(state)) {
    return undefined;
  }

  const observation = latestObservation(state);
  const error = latestError(state);
  const parts: string[] = [];

  if (observation) {
    const title = typeof observation.payload.title === "string" ? observation.payload.title : undefined;
    const url = typeof observation.payload.url === "string" ? observation.payload.url : undefined;
    if (title && url) {
      parts.push(`Reached ${title} at ${url}`);
    } else if (url) {
      parts.push(`Reached ${url}`);
    }
  }

  if (error && typeof error.payload.message === "string") {
    parts.push(`Run stopped with error: ${error.payload.message}`);
  }

  return parts.length > 0 ? parts.join("\n") : undefined;
}

function isRecoverableStepError(message: string): boolean {
  return /Target not found|timeout|network|ECONN|ETIMEDOUT|ENOTFOUND|fetch|Execution context was destroyed|Cannot find context/i
    .test(message);
}

async function appendSkillProposalEvents(
  state: LoopState,
  skillDir?: string,
  llmProvider?: LLMProvider,
): Promise<void> {
  if (!llmProvider) return;

  const alreadyProposed = state.events.some((event) => event.kind === "skill-proposal");
  if (alreadyProposed) {
    return;
  }

  const candidate = await llmProposeSkill(state.events, state.run.id, llmProvider);
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
      payload.path = await promoteSkill(candidate, skillDir);
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

// ---------------------------------------------------------------------------
// executeTask — run an agent loop to completion
// ---------------------------------------------------------------------------

export async function executeTask(
  task: Task,
  config: RuntimeConfig,
  agentTurn?: AgentTurnFn,
): Promise<LoopResult> {
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider);

  // Create a browser session for this task
  const session = await createBrowserSession(config.provider, config.sessionInput);
  await config.onSessionCreated?.(session);

  return executeWithState(task, config, turn, session);
}

export async function resumeTask(
  checkpoint: RunCheckpoint,
  config: RuntimeConfig,
  agentTurn?: AgentTurnFn,
): Promise<LoopResult> {
  const turn = agentTurn ?? defaultAgentTurn(config.llmProvider);
  const state: LoopState = {
    task: checkpoint.task,
    run: checkpoint.run,
    sessionId: checkpoint.sessionId,
    loadedSkills: [],
    events: checkpoint.events,
    stepCount: checkpoint.stepCount,
    startedAt: checkpoint.startedAt,
  };

  return executeWithState(checkpoint.task, config, turn, undefined, state, checkpoint.pendingAction);
}

async function executeWithState(
  task: Task,
  config: RuntimeConfig,
  turn: AgentTurnFn,
  session?: BrowserSession,
  initialState?: LoopState,
  approvedPendingAction?: ProposedAction,
): Promise<LoopResult> {
  let state = initialState ?? createLoopState(task, session!.id);
  let consecutiveRecoverableErrors = 0;

  // Track stop signal sources across steps
  let policyDenied = false;
  let authWallHit = false;
  let awaitingApproval = false;
  let pendingApproval: LoopResult["pendingApproval"];
  let pendingAction: LoopResult["pendingAction"];

  try {
    if (approvedPendingAction) {
      const resumedStep = await executeStep(
        state,
        approvedPendingAction,
        config.provider,
        config.policyEngine,
        { skipPolicyCheck: true },
      );
      state = resumedStep.state;
      authWallHit = resumedStep.authWallHit;
      await syncMatchedSkills(state, config.skillDir);
    } else if (!initialState) {
      // Fresh start: observe the current browser state before the first agent turn.
      // SPECS §19.1 step 5, §28 — "observation before first action".
      // This is setup, not an agent step — do not count against the step budget.
      const observation = await observeBrowser({
        provider: config.provider,
        sessionId: state.sessionId,
      });
      const obsPayload: JsonObject = {
        url: observation.url,
        title: observation.title,
      };
      if (observation.targetId) obsPayload.targetId = observation.targetId;
      if (observation.tabs.length > 0) obsPayload.tabs = observation.tabs;
      if (observation.focusedElement) obsPayload.focusedElement = observation.focusedElement as unknown as JsonObject;
      if (observation.pageSummary) obsPayload.pageSummary = observation.pageSummary as unknown as JsonObject;

      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "observation",
        payload: obsPayload,
      } as TraceEvent);
      authWallHit = detectAuthWall(observation).detected;
      await syncMatchedSkills(state, config.skillDir);
    } else {
      await syncMatchedSkills(state, config.skillDir);
    }

    while (true) {
      // Check stopping conditions
      const stopResult = shouldStop(state, {
        maxSteps: config.maxSteps,
        budgetExhausted: false,
        policyDenied,
        authWallHit,
        userCancelled: false,
      });

      if (stopResult.stop) {
        // Record the stop reason as a trace event
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: new Date().toISOString(),
          kind: "thought-summary",
          payload: { reason: stopResult.reason ?? "Unknown stop condition" },
        });
        break;
      }

      let action: ProposedAction;
      try {
        action = await turn(state, config.provider);
      } catch (err) {
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: new Date().toISOString(),
          kind: "error",
          payload: { message: (err as Error).message, code: "EAGENT" },
        });
        break;
      }

      // If the agent wants to finish, record and break
      if (action.kind === "finish") {
        if (
          task.mode === "task" &&
          !hasExtractedTaskResult(state) &&
          !hasRecordedTaskArtifact(state) &&
          !hasAttemptedSyntheticExtraction(state) &&
          state.stepCount < config.maxSteps
        ) {
          action = buildSyntheticExtractionAction();
        } else if (task.mode === "task") {
          if (hasExtractedTaskResult(state) && !hasRecordedTaskArtifact(state)) {
            appendExtractedResultArtifact(state);
          } else if (!hasRecordedTaskArtifact(state)) {
            appendTaskNoteArtifact(state, action.summary);
          }
          state.events.push({
            id: createId("event"),
            runId: state.run.id,
            ts: new Date().toISOString(),
            kind: "thought-summary",
            payload: { summary: action.summary, kind: "finish" },
          });
          break;
        } else {
          state.events.push({
            id: createId("event"),
            runId: state.run.id,
            ts: new Date().toISOString(),
            kind: "thought-summary",
            payload: { summary: action.summary, kind: "finish" },
          });
          break;
        }
      }

      // Execute the step
      try {
        const stepResult = await executeStep(state, action, config.provider, config.policyEngine);
        state = stepResult.state;
        policyDenied = stepResult.policyDenied;
        authWallHit = stepResult.authWallHit;
        consecutiveRecoverableErrors = 0;
        await syncMatchedSkills(state, config.skillDir);

        if (
          task.mode === "task" &&
          action.kind === "exec" &&
          typeof action.payload?.code === "string" &&
          action.payload.code.includes("wire:extract-result")
        ) {
          appendExtractedResultArtifact(state);
        }

        if (stepResult.pendingApproval) {
          awaitingApproval = true;
          pendingApproval = stepResult.pendingApproval;
          pendingAction = stepResult.pendingAction;
          break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = /network|timeout|ECONN|ETIMEDOUT|ENOTFOUND|fetch/iu.test(message)
          ? "ENETWORK"
          : "EEXEC";
        state.events.push({
          id: createId("event"),
          runId: state.run.id,
          ts: new Date().toISOString(),
          kind: "error",
          payload: { message, code },
        });
        state.stepCount++;

        if (isRecoverableStepError(message)) {
          consecutiveRecoverableErrors++;
          const budgetRemaining = state.stepCount < config.maxSteps;
          if (budgetRemaining && consecutiveRecoverableErrors < 3) {
            continue;
          }
        }

        break;
      }
    }
  } finally {
    // Always clean up the browser session
    if (!awaitingApproval) {
      try {
        await stopBrowserSession(config.provider, state.sessionId);
      } catch {
        // Best-effort cleanup — don't mask the real result
      }
    }
  }

  const finalizeOptions = {
    authWallHit,
    policyDenied,
    budgetExhausted: false,
    awaitingApproval,
  } as const;

  if (pendingApproval) {
    const approvalOptions: {
      authWallHit: boolean;
      policyDenied: boolean;
      budgetExhausted: false;
      awaitingApproval: boolean;
      pendingApproval: NonNullable<typeof pendingApproval>;
      pendingAction?: ProposedAction;
    } = {
      ...finalizeOptions,
      pendingApproval,
    };
    if (pendingAction) {
      approvalOptions.pendingAction = pendingAction;
    }
    return finalizeRun(state, approvalOptions);
  }

  if (
    task.mode === "task" &&
    !hasRecordedTaskArtifact(state)
  ) {
    const failureSummary = buildFailureSummary(state);
    if (failureSummary) {
      appendTaskNoteArtifact(state, failureSummary);
    }
  }

  await appendSkillProposalEvents(state, config.skillDir, config.llmProvider);

  return finalizeRun(state, finalizeOptions);
}

// Re-export planning types for convenience
export { type TaskPlan, createPlan, advanceStep, isPlanComplete, planToContext } from "./planning.js";
