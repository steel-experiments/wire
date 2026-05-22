import type { TraceEvent, TraceEventKind } from "../shared/types.js";
import { createPalette, isColorSupported, type Palette } from "./colors.js";

export interface StreamRendererOptions { verbose?: boolean; color?: boolean; maxSteps?: number; out?: (line: string) => void; }

interface RendererState {
  step: number; palette: Palette; verbose: boolean; maxSteps?: number; out: (line: string) => void;
  sawObservation: boolean; lastExecSig?: string; repeatCount: number;
}

const VERBOSE_ONLY: ReadonlySet<TraceEventKind> = new Set<TraceEventKind>(["policy-check"]);

const REPEAT_SIGNATURE_LEN = 80;

export interface ConsoleSink { onEvent(event: TraceEvent): void; }

export function createConsoleTraceSink(options: StreamRendererOptions = {}): ConsoleSink {
  const verbose = options.verbose === true;
  const color = options.color ?? isColorSupported();
  const palette = createPalette(color);
  const out = options.out ?? ((line: string) => process.stdout.write(`${line}\n`));

  const state: RendererState = { step: 0, palette, verbose, out, sawObservation: false, repeatCount: 0 };
  if (options.maxSteps !== undefined) state.maxSteps = options.maxSteps;

  return {
    onEvent(event: TraceEvent): void {
      if (event.kind === "code-exec") {
        state.step += 1;
        updateRepeat(state, event);
      }

      const line = formatEvent(event, state);
      if (line !== null) out(line);
    },
  };
}

function updateRepeat(state: RendererState, event: TraceEvent): void {
  const sig = execSignature(event);
  if (sig && sig === state.lastExecSig) state.repeatCount += 1;
  else {
    state.repeatCount = 0;
    if (sig) state.lastExecSig = sig;
  }
}

function execSignature(event: TraceEvent): string | undefined {
  const code = event.payload["code"];
  if (typeof code === "string") return oneLine(code).slice(0, REPEAT_SIGNATURE_LEN);
  const methods = event.payload["methods"];
  if (Array.isArray(methods)) return `raw:${methods.join(",")}`;
  return undefined;
}

function formatEvent(event: TraceEvent, state: RendererState): string | null {
  if (!state.verbose && VERBOSE_ONLY.has(event.kind)) return null;
  const { palette: p } = state;

  switch (event.kind) {
    case "observation": {
      const url = String(event.payload["url"] ?? "");
      const title = String(event.payload["title"] ?? "");
      const host = hostnameOf(url);
      const tail = title ? ` ${p.dim(`— "${truncate(title, 60)}"`)}` : "";
      const prefix = state.sawObservation ? contPrefix(state) : initPrefix(state);
      state.sawObservation = true;
      return `${prefix} ${p.dim("◉ observe ")} ${host}${tail}`;
    }

    case "code-exec": {
      const code = formatCodeExec(event, state);
      const label = actionLabel(event);
      const repeat = state.repeatCount > 0 ? ` ${p.yellow(`↻×${state.repeatCount + 1}`)}` : "";
      return `${stepPrefix(state)} ${p.cyan(label)}${repeat} ${code}`;
    }

    case "code-result": {
      const ok = event.payload["ok"] === true;
      const ms = typeof event.payload["durationMs"] === "number" ? `${event.payload["durationMs"]}ms` : "";
      const wireDetail = formatWireEvents(event.payload["wireEvents"]);
      if (wireDetail) {
        const tag = ok ? p.green("→ ok ") : p.red("→ err");
        return `${contPrefix(state)} ${tag} ${p.dim(ms)} ${p.dim("·")} ${wireDetail}`;
      }
      const stdout = typeof event.payload["stdout"] === "string" ? event.payload["stdout"] : "";
      const stderr = typeof event.payload["stderr"] === "string" ? event.payload["stderr"] : "";
      const ret = event.payload["returnValue"];
      const detail = preferredDetail(ok, ret, stdout, stderr);
      const detailStr = detail ? ` ${p.dim("·")} ${truncate(oneLine(detail), state.verbose ? 240 : 160)}` : "";
      const tag = ok ? p.green("→ ok ") : p.red("→ err");
      return `${contPrefix(state)} ${tag} ${p.dim(ms)}${detailStr}`;
    }

    case "thought-summary": {
      const kind = typeof event.payload["kind"] === "string" ? event.payload["kind"] : "";
      const summary = typeof event.payload["summary"] === "string" ? event.payload["summary"] : typeof event.payload["reason"] === "string" ? event.payload["reason"] : "";
      if (kind === "finish") return `${donePrefix(state)} ${p.bold(p.green("✓ finish  "))} ${truncate(summary, 200)}`;
      return `${donePrefix(state)} ${p.dim("◇ stop    ")} ${p.dim(truncate(summary, 200))}`;
    }

    case "policy-check": {
      const result = String(event.payload["result"] ?? "");
      const kind = String(event.payload["policyKind"] ?? event.payload["actionKind"] ?? "");
      const tag = result === "deny" ? p.red("⛔ deny    ") : result === "require-approval" ? p.yellow("⚠ approve ") : p.dim("· allow   ");
      return `${contPrefix(state)} ${tag} ${p.dim(kind)}`;
    }

    case "contract-check": return formatContractCheck(event, state);

    case "artifact-review": return formatArtifactReview(event, state);

    case "approval-request": return `${contPrefix(state)} ${p.yellow("⚠ approval")} ${truncate(String(event.payload["summary"] ?? ""), 120)}`;

    case "skill-load": {
      const labels = Array.isArray(event.payload["labels"]) ? event.payload["labels"] : [];
      const ids = Array.isArray(event.payload["skills"]) ? event.payload["skills"] : [];
      const display = labels.length > 0 ? labels : ids;
      if (display.length === 0) return null;
      const headLimit = state.verbose ? display.length : 4;
      const head = display.slice(0, headLimit).join(", ");
      const more = display.length > headLimit ? ` (+${display.length - headLimit} more)` : "";
      return `${contPrefix(state)} ${p.dim(`▸ skills   ${display.length}: ${head}${more}`)}`;
    }

    case "skill-proposal": {
      const skillId = String(event.payload["skillId"] ?? "");
      const promoted = event.payload["promoted"] === true;
      const tag = promoted ? p.magenta("✦ skill   ") : p.dim("✦ skill   ");
      const note = promoted ? "promoted" : "proposed";
      return `${donePrefix(state)} ${tag} ${note} ${p.dim(skillId)}`;
    }

    case "error": {
      const code = String(event.payload["code"] ?? "");
      return `${contPrefix(state)} ${p.bold(p.red("✗ error   "))} ${code ? p.dim(`[${code}] `) : ""}${truncate(String(event.payload["message"] ?? "unknown error"), 200)}`;
    }

    case "artifact": {
      if (!state.verbose) return null;
      const kind = String(event.payload["kind"] ?? "");
      const path = String(event.payload["path"] ?? "");
      return `${contPrefix(state)} ${p.dim(`▤ artifact ${kind} ${path}`)}`;
    }

    default: return null;
  }
}

function formatArtifactReview(event: TraceEvent, state: RendererState): string {
  const p = state.palette;
  if (event.payload["passed"] === true) {
    const skipped = event.payload["skipped"] === true ? " skipped" : "passed";
    return `${donePrefix(state)} ${p.bold(p.green("✓ review  "))} ${skipped}`;
  }
  const problems = Array.isArray(event.payload["problems"])
    ? event.payload["problems"].map(String).filter((item) => item.length > 0)
    : ["quality issue"];
  const detail = problems.slice(0, state.verbose ? 6 : 3).join("; ");
  return `${checkPrefix(state)} ${p.bold(p.red("✗ review  "))} ${truncate(detail, state.verbose ? 300 : 180)}`;
}

function formatContractCheck(event: TraceEvent, state: RendererState): string {
  const p = state.palette;
  if (event.payload["phase"] === "created") {
    const summary = String(event.payload["summary"] ?? "no extra completion contract");
    if (!state.verbose) {
      return `${initPrefix(state)} ${p.yellow("⛳ contract")} ${truncate(summary, 160)}`;
    }
    const contract = event.payload["contract"];
    const detail = typeof contract === "object" && contract !== null
      ? stringifyReturn(contract)
      : summary;
    return `${initPrefix(state)} ${p.yellow("⛳ contract")} ${truncate(detail, 300)}`;
  }

  if (event.payload["passed"] === true) {
    return `${donePrefix(state)} ${p.bold(p.green("✓ contract"))} passed`;
  }

  const missing = Array.isArray(event.payload["missing"])
    ? event.payload["missing"].map(String).filter((item) => item.length > 0)
    : ["missing evidence"];
  const detail = missing.slice(0, state.verbose ? 6 : 3).join("; ");
  return `${checkPrefix(state)} ${p.bold(p.red("✗ contract"))} ${truncate(detail, state.verbose ? 300 : 180)}`;
}

function preferredDetail(ok: boolean, ret: unknown, stdout: string, stderr: string): string {
  if (ok) {
    if (ret !== undefined) return stringifyReturn(ret);
    return stdout || stderr;
  }
  if (stderr) return stderr;
  if (ret !== undefined) return stringifyReturn(ret);
  return stdout;
}

function formatWireEvents(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const first = value.find((event) => event && typeof event === "object" && !Array.isArray(event)) as Record<string, unknown> | undefined;
  if (!first || first.action !== "click") return undefined;
  const target = first.target && typeof first.target === "object" && !Array.isArray(first.target)
    ? first.target as Record<string, unknown>
    : {};
  const tag = typeof target.tag === "string" ? target.tag : "target";
  const text = typeof target.text === "string" && target.text.length > 0 ? ` "${truncate(target.text, 40)}"` : "";
  const x = typeof first.x === "number" ? Math.round(first.x) : "?";
  const y = typeof first.y === "number" ? Math.round(first.y) : "?";
  const more = value.length > 1 ? ` (+${value.length - 1} more)` : "";
  return `● wire.click ${tag}${text} @ ${x},${y}${more}`;
}

function actionLabel(event: TraceEvent): string {
  if (event.payload["rawCommands"]) return "⚙ raw     ";
  const code = typeof event.payload["code"] === "string" ? event.payload["code"] : "";
  if (/\bwire\.click\s*\(/u.test(code)) return "● interact";
  if (/location\.(href|assign|replace)|Page\.navigate|window\.open/u.test(code)) return "↪ navigate";
  if (/\.click\(|dispatchEvent|Input\.dispatch|KeyboardEvent|MouseEvent|fillByLabel|clickVisibleText/u.test(code)) return "● interact";
  if (/querySelector|innerText|textContent|getAttribute|extract|return document/u.test(code)) return "◆ inspect ";
  return "⚙ exec    ";
}

function formatCodeExec(event: TraceEvent, state: RendererState): string {
  const code = event.payload["code"];
  if (typeof code === "string") return truncate(oneLine(code), state.verbose ? 200 : 90);
  if (!event.payload["rawCommands"]) return "(no code)";
  const summaries = event.payload["summaries"];
  const methods = event.payload["methods"];
  const list = Array.isArray(summaries) && summaries.length > 0 ? summaries : methods;
  const detail = Array.isArray(list) ? list.map(String).join("; ") : String(list ?? "");
  return `raw[${String(event.payload["rawCommands"])}] ${truncate(detail, state.verbose ? 220 : 110)}`;
}

function stepPrefix(state: RendererState): string {
  const total = state.maxSteps ? `/${state.maxSteps}` : "";
  const label = `[${String(state.step).padStart(2, " ")}${total}]`;
  if (state.maxSteps) {
    const pct = state.step / state.maxSteps;
    if (pct >= 1) return state.palette.red(label);
    if (pct >= 0.8) return state.palette.yellow(label);
  }
  return state.palette.dim(label);
}

function contPrefix(state: RendererState): string {
  return " ".repeat(state.maxSteps ? 8 : 6);
}

function donePrefix(state: RendererState): string { return state.palette.dim(state.maxSteps ? "[done  ]" : "[done]"); }
function checkPrefix(state: RendererState): string { return state.palette.dim(state.maxSteps ? "[check ]" : "[check]"); }
function initPrefix(state: RendererState): string { return state.palette.dim(state.maxSteps ? "[init  ]" : "[init]"); }
function truncate(s: string, max: number): string { return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1))}…`; }
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function stringifyReturn(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function oneLine(s: string): string { return s.replace(/\s+/gu, " ").trim(); }
