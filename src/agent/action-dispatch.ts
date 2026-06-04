import type { BrowserProvider } from "../browser/bridge.js";
import { execRaw } from "../browser/raw.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { redactJsonObject } from "../shared/redact.js";
import type { JsonObject, JsonValue, SessionId } from "../shared/types.js";
import type { LoopState } from "./loop.js";

export const MAX_CDP_BATCH_COMMANDS = 80;

const NAVIGATION_CDP_METHODS = new Set(["Page.navigate", "Page.reload", "Page.navigateToHistoryEntry"]);
const INPUT_CDP_METHODS = new Set([
  "Input.dispatchMouseEvent",
  "Input.dispatchKeyEvent",
  "Input.dispatchTouchEvent",
  "Input.dispatchDragEvent",
  "Input.insertText",
]);

export function commandsIncludeNavigation(
  commands: ReadonlyArray<{ method?: unknown }>,
): boolean {
  return commands.some((command) => typeof command?.method === "string" && NAVIGATION_CDP_METHODS.has(command.method));
}

export function commandsIncludeInput(commands: ReadonlyArray<{ method?: unknown }>): boolean {
  return commands.some((command) => typeof command?.method === "string" && INPUT_CDP_METHODS.has(command.method));
}

export function isLikelyInteractionCode(code: string): boolean {
  return /\b(clickVisibleText|fillByLabel|dispatchEvent|MouseEvent|KeyboardEvent|PointerEvent|window\.open)\b|\.click\s*\(|\.submit\s*\(/u.test(code);
}

function summarizeRawCommand(cmd: { method: string; params?: JsonObject }): string {
  const p = cmd.params ?? {};
  if (cmd.method === "Input.dispatchMouseEvent") {
    const type = typeof p.type === "string" ? p.type : "mouse";
    const x = typeof p.x === "number" ? p.x : "?";
    const y = typeof p.y === "number" ? p.y : "?";
    const button = typeof p.button === "string" && p.button !== "none" ? ` ${p.button}` : "";
    return `${cmd.method} ${type}${button} @ ${x},${y}`;
  }
  if (cmd.method === "Input.dispatchKeyEvent") {
    const key = typeof p.key === "string" ? p.key : typeof p.code === "string" ? p.code : "key";
    const type = typeof p.type === "string" ? p.type : "dispatch";
    return `${cmd.method} ${type} ${key}`;
  }
  if (cmd.method === "Page.navigate") {
    const url = typeof p.url === "string" ? redactJsonObject({ url: p.url }).url : undefined;
    return url ? `${cmd.method} ${url}` : cmd.method;
  }
  return cmd.method;
}

function summarizeRawCommands(commands: Array<{ method: string; params?: JsonObject }>): string[] {
  return commands.slice(0, 6).map(summarizeRawCommand);
}

export function collectCdpMethods(payload: Record<string, unknown> | undefined): string[] {
  const methods: string[] = [];
  const single = payload?.method;
  if (typeof single === "string") methods.push(single);
  const batch = payload?.commands;
  if (Array.isArray(batch)) {
    for (const cmd of batch) {
      const m = (cmd as { method?: unknown })?.method;
      if (typeof m === "string") methods.push(m);
    }
  }
  return methods;
}

export function wireActionsSignal(returnValue: unknown): boolean {
  if (returnValue === undefined) return false;
  try {
    const parsed = typeof returnValue === "string"
      ? JSON.parse(returnValue)
      : returnValue;
    return Array.isArray(parsed?.wireActions) &&
      (commandsIncludeNavigation(parsed.wireActions) || commandsIncludeInput(parsed.wireActions));
  } catch {
    return false;
  }
}

function wireActionCommands(returnValue: unknown): {
  commands: Array<{ method: string; params?: JsonObject }>;
  requested: number;
} | undefined {
  if (returnValue === undefined) return undefined;
  try {
    const parsed = typeof returnValue === "string"
      ? JSON.parse(returnValue)
      : returnValue;
    if (!parsed || !Array.isArray(parsed.wireActions)) return undefined;
    const commands = parsed.wireActions.filter(
      (action: unknown) => typeof (action as Record<string, unknown>)?.method === "string" &&
        (action as Record<string, unknown>).method !== "Runtime.evaluate",
    ).slice(0, MAX_CDP_BATCH_COMMANDS) as Array<{ method: string; params?: JsonObject }>;
    return { commands, requested: parsed.wireActions.length };
  } catch {
    return undefined;
  }
}

async function executeCdpCommands(
  provider: BrowserProvider,
  sessionId: SessionId,
  commands: Array<{ method: string; params?: JsonObject }>,
  options: { batchSingleCommand?: boolean } = {},
): Promise<{ ok: boolean; returnValue: unknown }> {
  const steelProvider = provider as unknown as {
    rawBatch?(sessionId: SessionId, commands: Array<{ method: string; params?: Record<string, unknown> }>): Promise<unknown>;
  };
  if ((commands.length > 1 || options.batchSingleCommand) && steelProvider.rawBatch) {
    try {
      return { ok: true, returnValue: await steelProvider.rawBatch(sessionId, commands) };
    } catch (err) {
      return { ok: false, returnValue: err instanceof Error ? err.message : String(err) };
    }
  }

  let lastResult: unknown;
  for (const cmd of commands) {
    try {
      const rawOpts: { provider: BrowserProvider; sessionId: SessionId; method: string; params?: JsonObject } = {
        provider,
        sessionId,
        method: cmd.method,
      };
      if (cmd.params) rawOpts.params = cmd.params;
      lastResult = await execRaw(rawOpts);
    } catch (err) {
      return { ok: false, returnValue: err instanceof Error ? err.message : String(err) };
    }
  }
  return { ok: true, returnValue: lastResult };
}

export async function executeWireActionsEnvelope(
  state: LoopState,
  provider: BrowserProvider,
  returnValue: unknown,
): Promise<void> {
  const envelope = wireActionCommands(returnValue);
  if (!envelope || envelope.commands.length === 0) return;

  const cdpStart = Date.now();
  const result = await executeCdpCommands(provider, state.sessionId, envelope.commands, {
    batchSingleCommand: true,
  });
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "code-result",
    payload: {
      ok: result.ok,
      durationMs: Date.now() - cdpStart,
      source: "wireActions",
      commandsExecuted: envelope.commands.length,
      commandsRequested: envelope.requested,
      truncated: envelope.requested > envelope.commands.length,
      returnValue: result.returnValue as JsonValue,
    },
  });
}

export async function executeRawActionCommands(
  state: LoopState,
  provider: BrowserProvider,
  commands: Array<{ method: string; params?: JsonObject }>,
): Promise<{ ok: boolean; commandsToRun: Array<{ method: string; params?: JsonObject }> }> {
  const commandsRequested = commands.length;
  const commandsToRun = commands.slice(0, MAX_CDP_BATCH_COMMANDS);
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "code-exec",
    payload: redactJsonObject({
      rawCommands: commandsToRun.length,
      methods: commandsToRun.map((command) => command.method),
      summaries: summarizeRawCommands(commandsToRun),
    }),
  });

  const startedAt = Date.now();
  const result = await executeCdpCommands(provider, state.sessionId, commandsToRun);
  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "code-result",
    payload: {
      ok: result.ok,
      durationMs: Date.now() - startedAt,
      source: "raw",
      commandsRequested,
      truncated: commandsRequested > commandsToRun.length,
      ...(result.ok ? { commandsExecuted: commandsToRun.length } : {}),
      returnValue: result.returnValue as JsonValue,
    },
  });

  return { ok: result.ok, commandsToRun };
}
