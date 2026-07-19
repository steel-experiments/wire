// ABOUTME: Cross-agent comparison harness — runs the same web tasks through 4 arms
// ABOUTME: (Wire, Claude Code +browser-skill, Claude Code +wire-CLI, Claude Code bare) and scores them with one shared blind LLM judge.

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile, appendFile, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { judgeWithGemini, type GeminiJudgeResult } from "./gemini-judge.ts";

// ---- Types -----------------------------------------------------------------

interface SuiteTask {
  id: string;
  objective: string;
  maxSteps: number;
}

interface ArmConfig {
  /** Claude model for the Claude Code arms. */
  ccModel: string;
  /** Wire provider/model. */
  wireProvider?: string;
  wireModel?: string;
  /** Name of the browser skill the +skill arm should lean on. */
  skillName: string;
  /** Per-arm wall-clock timeout (ms). */
  timeoutMs: number;
}

interface ArmOutcome {
  /** Final answer text the arm produced (fed to the judge). */
  answer: string;
  /** True wall-clock measured by this harness — the fair cross-arm latency. */
  wallMs: number;
  /** Whether the subprocess exited cleanly and produced an answer. */
  ok: boolean;
  /** Free-form per-arm native metrics (cost, turns, classification, ...). */
  native: Record<string, unknown>;
  /** Captured stderr/notes for debugging. */
  note?: string;
}

interface ResultRecord {
  task: string;
  objective: string;
  arm: string;
  rep: number;
  ok: boolean;
  wallMs: number;
  judgeScore: number | null;
  success: boolean;
  answer: string;
  native: Record<string, unknown>;
  note?: string;
}

// ---- Shell helper ----------------------------------------------------------

interface ShResult { stdout: string; stderr: string; code: number | null; timedOut: boolean; ms: number; }

function sh(cmd: string, args: string[], opts: { timeoutMs: number; cwd?: string }): Promise<ShResult> {
  return new Promise((res) => {
    const startedAt = process.hrtime.bigint();
    const child = spawn(cmd, args, { cwd: opts.cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, opts.timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      res({ stdout, stderr, code, timedOut, ms });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      res({ stdout, stderr: stderr + String(err), code: null, timedOut, ms });
    });
  });
}

/** Pull the last balanced JSON object out of a noisy stdout stream. */
function lastJsonObject(text: string): any | null {
  let depth = 0;
  let end = -1;
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "}") { if (depth === 0) end = i; depth++; }
    else if (ch === "{") {
      depth--;
      if (depth === 0 && end !== -1) {
        const slice = text.slice(i, end + 1);
        try { return JSON.parse(slice); } catch { end = -1; depth = 0; }
      }
    }
  }
  return null;
}

// ---- Arms ------------------------------------------------------------------

const WIRE_DIR = resolve(fileURLToPath(import.meta.url), "../../..");

async function runWire(task: SuiteTask, cfg: ArmConfig): Promise<ArmOutcome> {
  const args = [task.objective, "--json", "--quiet", "--max-steps", String(task.maxSteps)];
  if (cfg.wireProvider) args.push("--provider", cfg.wireProvider);
  if (cfg.wireModel) args.push("--model", cfg.wireModel);
  const r = await sh("wire", args, { timeoutMs: cfg.timeoutMs, cwd: WIRE_DIR });
  const env = lastJsonObject(r.stdout);
  const data = env?.data ?? {};
  const answer = typeof data.result === "string" ? data.result : "";
  return {
    answer,
    wallMs: r.ms,
    ok: !r.timedOut && !!answer,
    native: {
      runId: env?.run_id ?? data.runId ?? null,
      status: data.status ?? null,
      classification: data.classification ?? null,
      confidence: data.confidence ?? null,
      summary: data.summary ?? null,
      provider: cfg.wireProvider ?? process.env.WIRE_PROVIDER ?? null,
      model: cfg.wireModel ?? process.env.WIRE_MODEL ?? null,
      // Wire does not surface token cost on the run envelope; left null on purpose.
      costUsd: null,
    },
    note: r.timedOut ? "TIMEOUT" : (answer ? undefined : (r.stderr || "no answer").slice(0, 400)),
  };
}

/**
 * Run `claude -p` and normalise its JSON result. Each call runs in a throwaway
 * temp dir so Claude cannot read the wire repo or pick up its AGENTS.md/CLAUDE.md
 * as project instructions — every arm and every run starts from an identical,
 * empty filesystem context. Auth is user-global (~/.claude), so a fresh cwd does
 * not affect login.
 */
async function runClaude(prompt: string, cfg: ArmConfig, extra: string[]): Promise<ArmOutcome> {
  const workdir = await mkdtemp(join(tmpdir(), "wire-cmp-"));
  try {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--model", cfg.ccModel,
      "--dangerously-skip-permissions",
      ...extra,
    ];
    const r = await sh("claude", args, { timeoutMs: cfg.timeoutMs, cwd: workdir });
    const env = lastJsonObject(r.stdout);
    const answer = typeof env?.result === "string" ? env.result : "";
    const usage = env?.usage ?? {};
    return {
      answer,
      wallMs: r.ms,
      ok: !r.timedOut && env?.is_error !== true && !!answer,
      native: {
        costUsd: env?.total_cost_usd ?? null,
        numTurns: env?.num_turns ?? null,
        ccDurationMs: env?.duration_ms ?? null,
        inputTokens: usage.input_tokens ?? null,
        outputTokens: usage.output_tokens ?? null,
        permissionDenials: Array.isArray(env?.permission_denials) ? env.permission_denials.length : null,
        model: cfg.ccModel,
        isError: env?.is_error ?? null,
      },
      note: r.timedOut ? "TIMEOUT" : (answer ? undefined : (r.stderr || "no answer").slice(0, 400)),
    };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

function ccSkill(task: SuiteTask, cfg: ArmConfig): Promise<ArmOutcome> {
  // Skills stay enabled; `steel-browser` is a user-global skill so it's available
  // in the fresh cwd. Deny the competing local browser skill's tools so this arm
  // exercises steel-browser specifically (not agent-browser). A one-line hint
  // names the intended skill.
  const hint = `A browser-automation skill named "${cfg.skillName}" is available. Use it to complete web tasks. Return only the requested answer.`;
  return runClaude(task.objective, cfg, [
    "--disallowedTools", "Bash(agent-browser:*)", "Bash(npx agent-browser:*)",
    "--append-system-prompt", hint,
  ]);
}

function ccWireCli(task: SuiteTask, cfg: ArmConfig): Promise<ArmOutcome> {
  // Skills off; expose the wire CLI as the only browser capability. Pin the
  // nested wire to the same model as every other arm so cc-wire-cli's browser
  // work reasons with the same model, not wire's env default.
  const wireCmd =
    'wire "<objective>" --json --quiet' +
    (cfg.wireProvider ? ` --provider ${cfg.wireProvider}` : "") +
    (cfg.wireModel ? ` --model ${cfg.wireModel}` : "");
  const hint = [
    "You have a CLI tool named `wire` that autonomously completes web/browser tasks.",
    `Run it as: ${wireCmd}`,
    "It prints a JSON envelope whose final answer is at .data.result.",
    "Use wire to accomplish browser objectives instead of fetching pages yourself.",
    "Return only the requested answer.",
  ].join(" ");
  return runClaude(task.objective, cfg, ["--disable-slash-commands", "--append-system-prompt", hint]);
}

function ccBare(task: SuiteTask, cfg: ArmConfig): Promise<ArmOutcome> {
  // No skills, no wire — bare Claude Code improvising with its native tools.
  return runClaude(task.objective, cfg, ["--disable-slash-commands"]);
}

const ARMS: Record<string, (t: SuiteTask, c: ArmConfig) => Promise<ArmOutcome>> = {
  "wire": runWire,
  "cc-skill": ccSkill,
  "cc-wire-cli": ccWireCli,
  "cc-bare": ccBare,
};

// ---- Shared blind judge ----------------------------------------------------

const JUDGE_THRESHOLD_DEFAULT = 0.7;
type JudgeProvider = "claude" | "gemini";

function judgePrompt(objective: string, answer: string): string {
  // Same rubric as wire's bench judge. The judge sees only objective + answer —
  // it is blind to which arm produced the answer.
  return [
    "You are a judge evaluating whether a web agent's output fulfills an objective.",
    "Score the output from 0.0 to 1.0 based on:",
    "1. Does the output correctly address the objective? (0.6 weight)",
    "2. Is the output structured, complete, and free of placeholders? (0.4 weight)",
    "Respond with ONLY a number between 0.0 and 1.0. No other text.",
    "",
    `Objective: ${objective}`,
    "",
    "Agent output:",
    answer.slice(0, 4000),
  ].join("\n");
}

async function judge(
  objective: string,
  answer: string,
  judgeProvider: JudgeProvider,
  judgeModel: string,
  timeoutMs: number,
): Promise<GeminiJudgeResult> {
  if (!answer.trim()) return { score: 0 };
  const prompt = judgePrompt(objective, answer);
  if (judgeProvider === "gemini") {
    return judgeWithGemini({
      apiKey: process.env.GEMINI_API_KEY ?? "",
      model: judgeModel,
      prompt,
      timeoutMs,
    });
  }
  // Judge in a throwaway dir with skills off, so it scores purely from the
  // objective + answer and never picks up the repo's AGENTS.md or a skill.
  const workdir = await mkdtemp(join(tmpdir(), "wire-judge-"));
  try {
    const r = await sh(
      "claude",
      ["-p", prompt, "--output-format", "json", "--model", judgeModel, "--disable-slash-commands"],
      { timeoutMs, cwd: workdir },
    );
    if (r.timedOut) return { score: null, note: "Claude judge timed out" };
    if (r.code !== 0) return { score: null, note: `Claude judge exited ${r.code ?? "without status"}` };
    const env = lastJsonObject(r.stdout);
    const raw = typeof env?.result === "string" ? env.result : "";
    const score = parseFloat(raw.trim());
    if (Number.isNaN(score)) return { score: null, note: "Claude judge returned an invalid score" };
    return { score: Math.min(1, Math.max(0, score)) };
  } finally {
    await rm(workdir, { recursive: true, force: true });
  }
}

// ---- Aggregation + report --------------------------------------------------

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }

function fmtMs(ms: number): string { return `${(ms / 1000).toFixed(1)}s`; }

function buildReport(
  records: ResultRecord[],
  armOrder: string[],
  cfg: ArmConfig,
  judgeProvider: JudgeProvider,
  judgeModel: string,
  threshold: number,
): string {
  const lines: string[] = [];
  lines.push("# Cross-agent comparison report");
  lines.push("");
  lines.push(`- Judge: \`${judgeProvider}/${judgeModel}\` (blind, single shared rubric), success threshold \`${threshold}\``);
  lines.push(`- Claude Code arms model: \`${cfg.ccModel}\`; Wire: \`${cfg.wireProvider ?? "default"}/${cfg.wireModel ?? "default"}\``);
  lines.push(`- Latency is wall-clock measured by the harness around each subprocess (fair across all arms).`);
  lines.push("");

  // Per-arm summary
  lines.push("## Summary by arm");
  lines.push("");
  lines.push("| Arm | Runs | Success | Avg judge | Avg wall | Avg cost (USD) | Avg turns/steps |");
  lines.push("|-----|------|---------|-----------|----------|----------------|-----------------|");
  for (const arm of armOrder) {
    const rs = records.filter((r) => r.arm === arm);
    if (!rs.length) continue;
    const judges = rs.map((r) => r.judgeScore).filter((s): s is number => s !== null);
    const costs = rs.map((r) => r.native.costUsd).filter((c): c is number => typeof c === "number");
    const turns = rs.map((r) => r.native.numTurns).filter((t): t is number => typeof t === "number");
    const succ = rs.filter((r) => r.success).length;
    lines.push(
      `| ${arm} | ${rs.length} | ${succ}/${rs.length} (${((succ / rs.length) * 100).toFixed(0)}%) | ` +
      `${mean(judges).toFixed(2)} | ${fmtMs(mean(rs.map((r) => r.wallMs)))} | ` +
      `${costs.length ? mean(costs).toFixed(4) : "n/a"} | ${turns.length ? mean(turns).toFixed(1) : "n/a"} |`,
    );
  }
  lines.push("");

  // Per-task breakdown
  lines.push("## By task");
  lines.push("");
  const taskIds = [...new Set(records.map((r) => r.task))];
  for (const t of taskIds) {
    lines.push(`### ${t}`);
    lines.push("");
    lines.push("| Arm | judge | wall | cost | ok | note |");
    lines.push("|-----|-------|------|------|----|----|");
    for (const arm of armOrder) {
      const rs = records.filter((r) => r.task === t && r.arm === arm);
      for (const r of rs) {
        const cost = typeof r.native.costUsd === "number" ? (r.native.costUsd as number).toFixed(4) : "n/a";
        lines.push(`| ${arm} | ${r.judgeScore?.toFixed(2) ?? "n/a"} | ${fmtMs(r.wallMs)} | ${cost} | ${r.ok ? "y" : "n"} | ${(r.note ?? "").replace(/\n/g, " ").slice(0, 60)} |`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---- Environment + build ---------------------------------------------------

// Load the project's .env so spawned arms inherit the keys. Children inherit
// process.env, so loading here is enough. Without it the `wire` subprocess dies
// instantly on a missing STEEL_API_KEY and is silently scored 0 — an
// environment failure masquerading as a capability failure.
function loadProjectEnv(): void {
  try {
    process.loadEnvFile(join(WIRE_DIR, ".env"));
  } catch {
    // .env is optional; keys may already be exported in the shell.
  }
}

// Refuse to run the wire arm without its keys rather than report a misleading
// 0%. The CC arms authenticate independently, so they are not checked here.
function assertWireEnv(provider: string | undefined): void {
  const missing: string[] = [];
  if (!process.env.STEEL_API_KEY) missing.push("STEEL_API_KEY");
  // Require the key for the *selected* provider, not just any LLM key — an
  // OpenAI key does not let the anthropic provider authenticate, and wire would
  // crash instantly and be scored a misleading 0.
  if (provider === "anthropic") {
    if (!process.env.ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY (wire --provider anthropic)");
  } else if (provider === "openai") {
    if (!process.env.OPENAI_API_KEY) missing.push("OPENAI_API_KEY (wire --provider openai)");
  } else if (provider === "zai") {
    if (!process.env.ZAI_API_KEY) missing.push("ZAI_API_KEY (wire --provider zai)");
  } else if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    missing.push("OPENAI_API_KEY or ANTHROPIC_API_KEY");
  }
  if (missing.length > 0) {
    throw new Error(
      `The wire arm needs ${missing.join(" and ")} in the environment.\n` +
      `Export them or add them to ${join(WIRE_DIR, ".env")}.\n` +
      `Refusing to run so the wire arm is not silently scored 0. ` +
      `(Pass --arms without "wire" to skip it.)`,
    );
  }
}

// The `wire` bin runs dist/index.js, so a stale or missing build would make the
// wire arm measure old code. Rebuild once up front for parity with src; skip
// with --skip-build when dist is known-fresh.
async function buildWire(): Promise<void> {
  process.stdout.write("Building wire (dist) for parity with src … ");
  const r = await sh("pnpm", ["run", "build"], { timeoutMs: 180000, cwd: WIRE_DIR });
  if (r.code !== 0) {
    throw new Error(`pnpm build failed; the wire arm would run stale/no dist:\n${(r.stderr || r.stdout).slice(0, 800)}`);
  }
  console.log("done");
}

// ---- Main ------------------------------------------------------------------

function parseFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : "true"; }
  }
  return out;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const suitePath = resolve(flags.suite ?? join(dirname(fileURLToPath(import.meta.url)), "suite.json"));
  const suite: SuiteTask[] = JSON.parse(await readFile(suitePath, "utf-8"));
  const armOrder = (flags.arms ?? "wire,cc-skill,cc-wire-cli,cc-bare").split(",").map((s) => s.trim()).filter(Boolean);
  const reps = parseInt(flags.reps ?? "1", 10);
  const onlyTasks = flags.tasks ? new Set(flags.tasks.split(",").map((s) => s.trim())) : null;
  const tasks = onlyTasks ? suite.filter((t) => onlyTasks.has(t.id)) : suite;
  const judgeProvider = flags["judge-provider"] ?? "claude";
  if (judgeProvider !== "claude" && judgeProvider !== "gemini") {
    throw new Error(`Unsupported judge provider: ${judgeProvider}`);
  }
  const judgeModel = flags["judge-model"] ?? "claude-haiku-4-5-20251001";
  const threshold = parseFloat(flags["judge-threshold"] ?? String(JUDGE_THRESHOLD_DEFAULT));

  const cfg: ArmConfig = {
    ccModel: flags["cc-model"] ?? "claude-sonnet-4-6",
    // Default Wire to the same reasoning model as the Claude Code arms so the
    // comparison isolates the agent, not the model. Override with --wire-*.
    wireProvider: flags["wire-provider"] ?? process.env.WIRE_PROVIDER ?? "anthropic",
    wireModel: flags["wire-model"] ?? process.env.WIRE_MODEL ?? "claude-sonnet-4-6",
    skillName: flags.skill ?? "steel-browser",
    timeoutMs: parseInt(flags["timeout"] ?? "360000", 10),
  };

  // Load .env and guard/build the wire arm before doing any work, so a missing
  // key or stale dist fails loudly here instead of silently scoring wire 0.
  loadProjectEnv();
  // The steel-browser skill shells out to the `steel` CLI (~/.steel/bin); make
  // sure spawned arms can find it regardless of how the harness was launched.
  const steelBin = join(process.env.HOME ?? "", ".steel", "bin");
  process.env.PATH = `${steelBin}:${process.env.PATH ?? ""}`;
  if (armOrder.includes("wire")) {
    assertWireEnv(cfg.wireProvider);
    if (!flags["skip-build"]) await buildWire();
  }
  if (judgeProvider === "claude" && !process.env.ANTHROPIC_API_KEY) {
    throw new Error("The Claude blind judge requires ANTHROPIC_API_KEY");
  }
  if (judgeProvider === "gemini" && !process.env.GEMINI_API_KEY) {
    throw new Error("The Gemini blind judge requires GEMINI_API_KEY");
  }

  const stamp = (flags.stamp ?? new Date().toISOString()).replace(/[:.]/g, "-");
  const outDir = join(dirname(fileURLToPath(import.meta.url)), "results", stamp);
  await mkdir(outDir, { recursive: true });
  const jsonlPath = join(outDir, "results.jsonl");

  console.log(`Suite: ${tasks.length} task(s) × ${armOrder.length} arm(s) × ${reps} rep(s) = ${tasks.length * armOrder.length * reps} runs`);
  console.log(`Arms: ${armOrder.join(", ")}`);
  console.log(`Judge: ${judgeProvider}/${judgeModel} (threshold ${threshold})`);
  console.log(`Output: ${outDir}`);
  console.log("");

  const records: ResultRecord[] = [];
  for (const task of tasks) {
    for (let rep = 1; rep <= reps; rep++) {
      for (const arm of armOrder) {
        const fn = ARMS[arm];
        if (!fn) { console.log(`  skip unknown arm: ${arm}`); continue; }
        process.stdout.write(`[${task.id} #${rep}] ${arm.padEnd(12)} … `);
        const outcome = await fn(task, cfg);
        const judged = await judge(task.objective, outcome.answer, judgeProvider, judgeModel, cfg.timeoutMs);
        const judgeScore = judged.score;
        const success = judgeScore !== null && judgeScore >= threshold && outcome.ok;
        const note = [outcome.note, judged.note].filter((value): value is string => value !== undefined).join("; ") || undefined;
        const rec: ResultRecord = {
          task: task.id, objective: task.objective, arm, rep,
          ok: outcome.ok, wallMs: outcome.wallMs, judgeScore, success,
          answer: outcome.answer.slice(0, 2000), native: outcome.native, ...(note === undefined ? {} : { note }),
        };
        records.push(rec);
        await appendFile(jsonlPath, JSON.stringify(rec) + "\n");
        console.log(`judge ${judgeScore?.toFixed(2) ?? "n/a"}  ${fmtMs(outcome.wallMs)}  ${outcome.ok ? "ok" : "FAIL"}${note ? ` (${note.slice(0, 80)})` : ""}`);
      }
    }
  }

  const report = buildReport(records, armOrder, cfg, judgeProvider, judgeModel, threshold);
  const reportPath = join(outDir, "report.md");
  await writeFile(reportPath, report);
  console.log("");
  console.log(report);
  console.log(`\nRaw: ${jsonlPath}\nReport: ${reportPath}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
