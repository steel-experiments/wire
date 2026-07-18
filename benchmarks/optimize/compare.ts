import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { redactSecrets } from "../../src/shared/redact.js";
import {
  runClassificationKindSchema,
  runIdSchema,
  runStatusSchema,
} from "../../src/shared/schemas.js";
import { loadRun } from "../../src/storage/runs.js";
import {
  attemptSchema,
  type Attempt,
  type CampaignSpec,
  type CampaignState,
  type CohortName,
  type PhysicalResult,
} from "./model.js";
import {
  type CampaignPaths,
  listAttempts,
  loadAttempt,
  saveAttempt,
  saveCampaignState,
  sha256Path,
  verifyFrozenInputs,
} from "./state.js";
import {
  createClaudeJudgeShim,
  createWireShim,
  harnessEnvironment,
  prepareAttemptIsolation,
  type AttemptIsolation,
} from "./worktree.js";
import {
  probeSystemdUserSandbox,
  runSystemdSandbox,
  SystemdSandboxUnsupportedError,
  type SystemdSandboxRequest,
} from "./sandbox.js";

const ARM_VALUES = ["base", "candidate"] as const;
const SAFE_STAMP = /^[a-z0-9][a-z0-9_-]{0,95}$/u;
const MAX_CAPTURE_BYTES = 64 * 1024;
const MAX_DIAGNOSTIC_CHARS = 2_000;
const MAX_JSONL_BYTES = 1024 * 1024;
const BUILD_TIMEOUT_MS = 180_000;
const HARNESS_GRACE_MS = 30_000;
const SAFE_TASK_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u;

type Arm = (typeof ARM_VALUES)[number];

const suiteTaskSchema = z.strictObject({
  id: z.string().regex(SAFE_TASK_ID, "expected a CLI-safe task id"),
  objective: z.string().min(1),
  maxSteps: z.number().int().positive(),
});

const suiteSchema = z.array(suiteTaskSchema).min(1);

const harnessRecordSchema = z.strictObject({
  task: z.string(),
  objective: z.string(),
  arm: z.string(),
  rep: z.number().int().positive(),
  ok: z.boolean(),
  wallMs: z.number().finite().nonnegative(),
  judgeScore: z.number().finite().min(0).max(1).nullable(),
  success: z.boolean(),
  answer: z.string(),
  native: z.strictObject({
    runId: runIdSchema.nullable(),
    status: runStatusSchema.nullable(),
    classification: z.union([runClassificationKindSchema, z.literal("unknown")]).nullable(),
    confidence: z.number().nullable(),
    summary: z.string().max(2_000).nullable(),
    provider: z.string().max(200).nullable(),
    model: z.string().max(200).nullable(),
    costUsd: z.null(),
  }),
  note: z.string().max(1_000).optional(),
});

const durableHarnessOutputSchema = z.strictObject({
  version: z.literal(1),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  record: z.strictObject({
    ok: z.boolean(),
    wallMs: z.number().finite().nonnegative(),
    judgeScore: z.number().finite().min(0).max(1),
    success: z.boolean(),
    runId: runIdSchema,
    answerSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    nativeStatus: runStatusSchema.nullable(),
    nativeClassification: z.union([runClassificationKindSchema, z.literal("unknown")]).nullable(),
  }).nullable(),
  subprocess: z.strictObject({
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    timedOut: z.boolean(),
    wallMs: z.number().finite().nonnegative(),
  }),
  diagnostic: z.string(),
});

type HarnessRecord = z.infer<typeof harnessRecordSchema>;

export interface RevisionUnderTest {
  commit: string;
  worktreePath: string;
}

export interface ChildInvocation {
  kind: "install" | "build" | "provenance" | "compare";
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  wallMs: number;
}

export type ChildRunner = (invocation: ChildInvocation) => Promise<ChildResult>;
export type RevisionVerifier = (revision: RevisionUnderTest) => Promise<void>;

export interface PairedSlot {
  slotId: string;
  slotIndex: number;
  taskId: string;
  repetition: number;
  order: [Arm, Arm];
}

export interface EvaluatePairedOptions {
  spec: CampaignSpec;
  state: CampaignState;
  paths: CampaignPaths;
  candidateId: string;
  cohort: CohortName;
  base: RevisionUnderTest;
  candidate: RevisionUnderTest;
  candidateSkillSnapshot?: Readonly<{
    path: string;
    sha256: string;
  }>;
  runner?: ChildRunner;
  verifyRevision?: RevisionVerifier;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pnpmCommand?: string;
}

export interface EvaluatePairedResult {
  state: CampaignState;
  attempts: Attempt[];
  stopped: boolean;
}

type ReattestPairedOptions = Pick<
  EvaluatePairedOptions,
  "spec" | "paths" | "candidateId" | "cohort" | "base" | "candidate" | "candidateSkillSnapshot"
>;

interface CohortInput {
  suitePath: string;
  tasks: Array<z.infer<typeof suiteTaskSchema>>;
  pairedSlots: number;
}

interface ExpectedHarnessRecord {
  taskId: string;
  objective: string;
  threshold: number;
  wireRoot: string;
}

class HarnessContractError extends Error {
  constructor(message: string, readonly record?: HarnessRecord) {
    super(message);
    this.name = "HarnessContractError";
  }
}

function appendBounded(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current) >= MAX_CAPTURE_BYTES) return current;
  const remaining = MAX_CAPTURE_BYTES - Buffer.byteLength(current);
  return current + Buffer.from(chunk).subarray(0, remaining).toString();
}

function elapsedMs(started: bigint): number {
  return Number(process.hrtime.bigint() - started) / 1e6;
}

function killChild(child: ReturnType<typeof spawn>): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
      return;
    } catch {
      // Fall back to the direct child if its process group has already ended.
    }
  }
  child.kill("SIGKILL");
}

const CHILD_SUPERVISOR_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const parentPid = Number(process.argv[1]);
const command = process.argv[2];
const args = process.argv.slice(3);
let settled = false;
let parentWatch;
let child;
const killActualGroup = () => {
  if (process.platform !== "win32" && child?.pid !== undefined) {
    try { process.kill(-child.pid, "SIGKILL"); return; } catch {}
  }
  try { child?.kill("SIGKILL"); } catch {}
};
const stopSignals = ["SIGTERM", "SIGINT", "SIGHUP"];
const exitAfterCleanup = (code, signal) => {
  if (settled) return;
  settled = true;
  if (parentWatch !== undefined) clearInterval(parentWatch);
  killActualGroup();
  if (signal) {
    for (const stopSignal of stopSignals) process.removeAllListeners(stopSignal);
    try { process.kill(process.pid, signal); return; } catch {}
  }
  process.exit(code ?? 1);
};
const stopGroup = () => exitAfterCleanup(null, "SIGKILL");
for (const signal of stopSignals) process.once(signal, stopGroup);
parentWatch = setInterval(() => {
  try { process.kill(parentPid, 0); } catch { stopGroup(); }
}, 250);
try {
  child = spawn(command, args, {
    env: process.env,
    shell: false,
    stdio: "inherit",
    detached: process.platform !== "win32",
  });
} catch (error) {
  process.stderr.write(String(error));
  exitAfterCleanup(1, null);
}
if (typeof process.send === "function" && child.pid !== undefined) {
  try { process.send({ type: "supervised-child", pid: child.pid }); } catch { stopGroup(); }
}
child.once("error", (error) => {
  process.stderr.write(String(error));
  exitAfterCleanup(1, null);
});
child.once("exit", (code, signal) => exitAfterCleanup(code, signal));
`;

export const spawnChild: ChildRunner = (invocation) => new Promise((resolveChild) => {
  const started = process.hrtime.bigint();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  let actualChildPid: number | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;
  let child: ReturnType<typeof spawn>;

  const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    resolveChild({ code, signal, stdout, stderr, timedOut, wallMs: elapsedMs(started) });
  };

  try {
    child = spawn(process.execPath, [
      "-e",
      CHILD_SUPERVISOR_SOURCE,
      String(process.pid),
      invocation.command,
      ...invocation.args,
    ], {
      cwd: invocation.cwd,
      env: invocation.env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
  } catch (error) {
    resolveChild({
      code: null,
      signal: null,
      stdout,
      stderr: String(error),
      timedOut,
      wallMs: elapsedMs(started),
    });
    return;
  }

  const timer = setTimeout(() => {
    timedOut = true;
    if (actualChildPid !== undefined && process.platform !== "win32") {
      try { process.kill(-actualChildPid, "SIGKILL"); } catch {}
    }
    child.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (actualChildPid !== undefined && process.platform !== "win32") {
        try { process.kill(-actualChildPid, "SIGKILL"); } catch {}
      }
      killChild(child);
    }, 500);
  }, invocation.timeoutMs);

  child.on("message", (message: unknown) => {
    if (message !== null && typeof message === "object") {
      const childMessage = message as { type?: unknown; pid?: unknown };
      if (
        childMessage.type === "supervised-child"
        && typeof childMessage.pid === "number"
        && Number.isSafeInteger(childMessage.pid)
        && childMessage.pid > 0
      ) {
        actualChildPid = childMessage.pid;
      }
    }
  });
  child.stdout?.on("data", (chunk: Buffer | string) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    stderr = appendBounded(stderr, chunk);
  });
  child.once("error", (error) => {
    stderr = appendBounded(stderr, String(error));
    finish(null, null);
  });
  child.once("close", finish);
});

function sanitizeDiagnostic(value: string): string {
  return redactSecrets(value)
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .slice(0, MAX_DIAGNOSTIC_CHARS);
}

function errorMessage(error: unknown): string {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function assertNoLocalEnv(worktreePath: string): Promise<void> {
  const name = (await readdir(worktreePath))
    .sort()
    .find((entry) => (
      entry === ".env"
      || (entry.startsWith(".env.") && entry !== ".env.example")
    ));
  if (name !== undefined) {
    throw new Error(`Refusing revision-local .env file: ${join(worktreePath, name)}`);
  }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createPairedSchedule(input: {
  campaignId: string;
  candidateId: string;
  cohort: CohortName;
  seed: string;
  taskIds: string[];
  pairedSlots: number;
}): PairedSlot[] {
  if (input.taskIds.length === 0) throw new Error("A paired schedule needs at least one task");
  if (!Number.isInteger(input.pairedSlots) || input.pairedSlots <= 0) {
    throw new Error("A paired schedule needs a positive slot count");
  }

  const scheduleSeed = `${input.seed}\0${input.campaignId}\0${input.candidateId}\0${input.cohort}`;
  const baseFirst = Number.parseInt(hashText(scheduleSeed).slice(0, 2), 16) % 2 === 0;
  return Array.from({ length: input.pairedSlots }, (_, slotIndex) => {
    const taskIndex = slotIndex % input.taskIds.length;
    const first: Arm = (baseFirst === (slotIndex % 2 === 0)) ? "base" : "candidate";
    const digest = hashText(`${scheduleSeed}\0${slotIndex}`).slice(0, 12);
    return {
      slotId: `slot-${input.cohort}-${String(slotIndex + 1).padStart(4, "0")}-${digest}`,
      slotIndex,
      taskId: input.taskIds[taskIndex]!,
      repetition: Math.floor(slotIndex / input.taskIds.length) + 1,
      order: first === "base" ? ["base", "candidate"] : ["candidate", "base"],
    };
  });
}

async function readSuite(path: string): Promise<Array<z.infer<typeof suiteTaskSchema>>> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const tasks = suiteSchema.parse(raw);
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) throw new Error(`Frozen suite has duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  return tasks;
}

async function cohortInput(spec: CampaignSpec, cohort: CohortName): Promise<CohortInput> {
  if (cohort === "holdout") {
    const holdout = spec.cohorts.holdout;
    if (holdout === undefined) throw new Error("Campaign has no holdout cohort");
    return {
      suitePath: holdout.externalSuitePath,
      tasks: await readSuite(holdout.externalSuitePath),
      pairedSlots: holdout.slots,
    };
  }

  const suite = await readSuite(spec.suite.path);
  const byId = new Map(suite.map((task) => [task.id, task]));
  return {
    suitePath: spec.suite.path,
    tasks: spec.cohorts[cohort].taskIds.map((taskId) => {
      const task = byId.get(taskId);
      if (task === undefined) throw new Error(`Unknown ${cohort} task id: ${taskId}`);
      return task;
    }),
    pairedSlots: spec.cohorts[cohort].pairedSlots,
  };
}

function updatedState(
  state: CampaignState,
  now: () => Date,
  patch: Partial<CampaignState>,
): CampaignState {
  return {
    ...state,
    ...patch,
    updatedAt: now().toISOString(),
  };
}

async function stopCampaign(
  paths: CampaignPaths,
  state: CampaignState,
  now: () => Date,
  reason: string,
): Promise<CampaignState> {
  const stopped = updatedState(state, now, {
    phase: "stopped",
    stopReason: sanitizeDiagnostic(reason),
  });
  await saveCampaignState(paths, stopped);
  return stopped;
}

async function invokeRunner(runner: ChildRunner, invocation: ChildInvocation): Promise<ChildResult> {
  const started = process.hrtime.bigint();
  try {
    return await runner(invocation);
  } catch (error) {
    return {
      code: null,
      signal: null,
      stdout: "",
      stderr: String(error),
      timedOut: false,
      wallMs: elapsedMs(started),
    };
  }
}

const OFFLINE_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "NO_COLOR",
  "NODE_EXTRA_CA_CERTS",
] as const;

function selectEnvironment(source: NodeJS.ProcessEnv, keys: readonly string[]): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

function buildEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return {
    ...selectEnvironment(source, OFFLINE_ENV_KEYS),
    HOME: home,
    CI: "1",
    NO_COLOR: "1",
  };
}

export function preparationSandboxRequest(invocation: ChildInvocation): SystemdSandboxRequest {
  if (invocation.kind !== "install" && invocation.kind !== "build") {
    throw new Error(`Only candidate-controlled preparation commands may use this sandbox: ${invocation.kind}`);
  }
  if (!isAbsolute(invocation.command)) {
    throw new Error("Sandboxed preparation requires an absolute controller-resolved command");
  }
  const home = invocation.env.HOME;
  if (home === undefined || !isAbsolute(home)) {
    throw new Error("Sandboxed preparation requires an absolute isolated HOME");
  }
  const commandRoot = resolve(dirname(invocation.command), "..");
  const readOnlyPaths = [commandRoot];
  const extraCertificate = invocation.env.NODE_EXTRA_CA_CERTS;
  if (extraCertificate !== undefined) {
    if (!isAbsolute(extraCertificate) || resolve(extraCertificate) !== extraCertificate) {
      throw new Error("Sandboxed preparation requires an absolute NODE_EXTRA_CA_CERTS path");
    }
    readOnlyPaths.push(extraCertificate);
  }
  return {
    command: invocation.command,
    args: invocation.args,
    cwd: resolve(invocation.cwd),
    environment: invocation.env,
    environmentNames: Object.keys(invocation.env).sort((left, right) => left.localeCompare(right)),
    readOnlyPaths,
    readWritePaths: [resolve(invocation.cwd), resolve(home)],
    timeoutMs: invocation.timeoutMs,
  };
}

const sandboxedPreparationRunner: ChildRunner = async (invocation) => {
  if (invocation.kind !== "install" && invocation.kind !== "build") {
    return spawnChild(invocation);
  }
  const result = await runSystemdSandbox(preparationSandboxRequest(invocation));
  return {
    code: result.code,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut,
    wallMs: result.wallMs,
  };
};

async function assertGitRevision(
  revision: RevisionUnderTest,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const cleanEnv = selectEnvironment(env, OFFLINE_ENV_KEYS);
  const head = await spawnChild({
    kind: "provenance",
    command: "git",
    args: ["rev-parse", "--verify", "HEAD"],
    cwd: revision.worktreePath,
    env: cleanEnv,
    timeoutMs: 30_000,
  });
  if (head.timedOut || head.code !== 0 || head.stdout.trim() !== revision.commit) {
    throw new Error(`Revision HEAD changed after preparation: ${revision.commit}`);
  }
  const status = await spawnChild({
    kind: "provenance",
    command: "git",
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: revision.worktreePath,
    env: cleanEnv,
    timeoutMs: 30_000,
  });
  if (status.timedOut || status.code !== 0) {
    throw new Error(`Could not re-attest revision cleanliness after preparation: ${revision.commit}`);
  }
  if (status.stdout.trim() !== "") {
    throw new Error(`Revision became dirty during preparation: ${revision.commit}`);
  }
}

function providerEnvironmentKeys(provider: CampaignSpec["wire"]["provider"]): string[] {
  if (provider === "openai") return ["OPENAI_API_KEY", "OPENAI_REASONING_EFFORT"];
  if (provider === "anthropic") return ["ANTHROPIC_API_KEY", "ANTHROPIC_REASONING_EFFORT"];
  return ["ZAI_API_KEY", "ZAI_REASONING_EFFORT"];
}

function harnessEnvironmentKeys(spec: CampaignSpec): string[] {
  return [
    "STEEL_API_KEY",
    "STEEL_BASE_URL",
    // The immutable comparison harness uses Claude Code for its blind judge.
    "ANTHROPIC_API_KEY",
    ...providerEnvironmentKeys(spec.wire.provider),
  ];
}

async function ensureBuilt(input: {
  revision: RevisionUnderTest;
  state: CampaignState;
  spec: CampaignSpec;
  paths: CampaignPaths;
  runner: ChildRunner;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  pnpmCommand: string;
  verifyRevision: RevisionVerifier;
}): Promise<CampaignState> {
  const dist = join(input.revision.worktreePath, "dist");
  const entry = join(dist, "index.js");
  const revisionPath = resolve(input.revision.worktreePath);
  const existingBuild = input.state.builtRevisions.find((built) => (
    built.commit === input.revision.commit && built.worktreePath === revisionPath
  ));
  if (existingBuild !== undefined) {
    try {
      await input.verifyRevision(input.revision);
    } catch (error) {
      return stopCampaign(input.paths, input.state, input.now, errorMessage(error));
    }
    if (!await pathExists(entry)) {
      return stopCampaign(
        input.paths,
        input.state,
        input.now,
        `Commit ${input.revision.commit} is marked built but ${entry} is missing`,
      );
    }
    const actualDistHash = await sha256Path(dist);
    if (actualDistHash !== existingBuild.distSha256) {
      return stopCampaign(
        input.paths,
        input.state,
        input.now,
        `Built output changed for ${input.revision.commit}`,
      );
    }
    return input.state;
  }

  let state = input.state;
  const preparationHome = join(input.paths.root, "offline-home", input.revision.commit);
  await mkdir(preparationHome, { recursive: true, mode: 0o700 });
  const installRemaining = input.spec.budget.maxWallClockMs - state.wallClockMsUsed;
  if (installRemaining <= 0) {
    return stopCampaign(input.paths, state, input.now, "Campaign wall-clock budget exhausted before dependency install");
  }
  state = updatedState(state, input.now, {
    phase: "evaluating",
    inFlight: {
      kind: "install",
      commit: input.revision.commit,
      startedAt: input.now().toISOString(),
    },
  });
  await saveCampaignState(input.paths, state);
  const install = await invokeRunner(input.runner, {
    kind: "install",
    command: input.pnpmCommand,
    args: ["install", "--frozen-lockfile"],
    cwd: input.revision.worktreePath,
    env: buildEnvironment(input.env, preparationHome),
    timeoutMs: Math.max(1, Math.min(BUILD_TIMEOUT_MS, installRemaining)),
  });
  state = updatedState(state, input.now, {
    inFlight: undefined,
    wallClockMsUsed: state.wallClockMsUsed + install.wallMs,
    buildWallClockMsUsed: state.buildWallClockMsUsed + install.wallMs,
  });
  if (install.timedOut || install.code !== 0) {
    const detail = sanitizeDiagnostic(install.stderr || install.stdout || "no dependency install diagnostics");
    return stopCampaign(
      input.paths,
      state,
      input.now,
      `Dependency install failed for ${input.revision.commit}${install.timedOut ? " (timeout)" : ""}: ${detail}`,
    );
  }
  try {
    await input.verifyRevision(input.revision);
  } catch (error) {
    return stopCampaign(input.paths, state, input.now, errorMessage(error));
  }

  const buildRemaining = input.spec.budget.maxWallClockMs - state.wallClockMsUsed;
  if (buildRemaining <= 0) {
    return stopCampaign(input.paths, state, input.now, "Campaign wall-clock budget exhausted before build");
  }
  // The install accounting and the next reservation are one atomic state
  // transition. A crash can stop conservatively, but never repeat install.
  state = updatedState(state, input.now, {
    phase: "evaluating",
    inFlight: {
      kind: "build",
      commit: input.revision.commit,
      startedAt: input.now().toISOString(),
    },
  });
  await saveCampaignState(input.paths, state);
  const build = await invokeRunner(input.runner, {
    kind: "build",
    command: input.pnpmCommand,
    args: ["run", "build"],
    cwd: input.revision.worktreePath,
    env: buildEnvironment(input.env, preparationHome),
    timeoutMs: Math.max(1, Math.min(BUILD_TIMEOUT_MS, buildRemaining)),
  });
  state = updatedState(state, input.now, {
    inFlight: undefined,
    wallClockMsUsed: state.wallClockMsUsed + build.wallMs,
    buildWallClockMsUsed: state.buildWallClockMsUsed + build.wallMs,
  });
  if (build.timedOut || build.code !== 0) {
    const detail = sanitizeDiagnostic(build.stderr || build.stdout || "no build diagnostics");
    return stopCampaign(
      input.paths,
      state,
      input.now,
      `Build failed for ${input.revision.commit}${build.timedOut ? " (timeout)" : ""}: ${detail}`,
    );
  }
  try {
    await input.verifyRevision(input.revision);
  } catch (error) {
    return stopCampaign(input.paths, state, input.now, errorMessage(error));
  }
  if (!await pathExists(entry)) {
    return stopCampaign(
      input.paths,
      state,
      input.now,
      `Build for ${input.revision.commit} produced no ${entry}`,
    );
  }
  const distSha256 = await sha256Path(dist);
  if (state.wallClockMsUsed > input.spec.budget.maxWallClockMs) {
    return stopCampaign(input.paths, state, input.now, "Build exceeded campaign wall-clock budget");
  }

  // Clearing the build reservation and publishing the immutable dist hash are
  // one atomic state transition. A successful build is never silently rerun.
  state = updatedState(state, input.now, {
    builtRevisions: [...state.builtRevisions, {
      commit: input.revision.commit,
      worktreePath: revisionPath,
      distSha256,
    }],
  });
  await saveCampaignState(input.paths, state);
  return state;
}

function safeStamp(slotId: string, arm: Arm): string {
  const stamp = `${slotId}-${arm}`;
  if (!SAFE_STAMP.test(stamp)) throw new Error(`Unsafe harness stamp: ${stamp}`);
  return stamp;
}

export function harnessOutputPath(worktreePath: string, stamp: string): string {
  if (!SAFE_STAMP.test(stamp)) throw new Error(`Unsafe harness stamp: ${stamp}`);
  return join(resolve(worktreePath), "benchmarks", "compare", "results", stamp, "results.jsonl");
}

function durableHarnessOutputPath(paths: CampaignPaths, stamp: string): string {
  if (!SAFE_STAMP.test(stamp)) throw new Error(`Unsafe harness stamp: ${stamp}`);
  return join(paths.attempts, "raw", `${stamp}.jsonl`);
}

async function preserveHarnessOutput(
  paths: CampaignPaths,
  sourcePath: string,
  stamp: string,
  record: HarnessRecord | undefined,
  child: ChildResult,
): Promise<{ path: string; sha256: string | null }> {
  const durablePath = durableHarnessOutputPath(paths, stamp);
  const sourceExists = await pathExists(sourcePath);
  if (!sourceExists) {
    return await pathExists(durablePath)
      ? { path: durablePath, sha256: await sha256Path(durablePath) }
      : { path: sourcePath, sha256: null };
  }
  const sourceStat = await lstat(sourcePath);
  if (!sourceStat.isFile() || sourceStat.size > MAX_JSONL_BYTES) {
    throw new Error(`Harness output is not a bounded regular file: ${sourcePath}`);
  }
  const sourceHash = await sha256Path(sourcePath);
  const durableContent = `${JSON.stringify(durableHarnessOutputSchema.parse({
    version: 1,
    sourceSha256: sourceHash,
    record: record?.native.runId === null || record?.judgeScore === null || record === undefined
      ? null
      : {
          ok: record.ok,
          wallMs: record.wallMs,
          judgeScore: record.judgeScore,
          success: record.success,
          runId: record.native.runId,
          answerSha256: hashText(record.answer),
          nativeStatus: record.native.status,
          nativeClassification: record.native.classification,
        },
    subprocess: {
      exitCode: child.code,
      signal: child.signal,
      timedOut: child.timedOut,
      wallMs: child.wallMs,
    },
    diagnostic: record === undefined ? "Harness output omitted after a contract failure." : "Normalized harness record; objective and answer omitted.",
  }))}\n`;
  const durableHash = hashText(durableContent);
  await mkdir(dirname(durablePath), { recursive: true, mode: 0o700 });
  if (await pathExists(durablePath)) {
    const existingHash = await sha256Path(durablePath);
    if (existingHash !== durableHash) {
      throw new Error(`Durable harness output hash mismatch: ${durablePath}`);
    }
  } else {
    await writeFile(durablePath, durableContent, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await chmod(durablePath, 0o400);
  }
  // The immutable harness writes into the measured worktree. Remove that
  // candidate-visible copy after preserving the bounded normalized record.
  await rm(dirname(sourcePath), { recursive: true, force: false });
  return { path: durablePath, sha256: durableHash };
}

async function parseDurableHarnessOutput(
  outputPath: string,
  expected: ExpectedHarnessRecord,
): Promise<HarnessRecord> {
  const raw = durableHarnessOutputSchema.parse(JSON.parse(await readFile(outputPath, "utf8")) as unknown);
  if (raw.record === null) throw new HarnessContractError("Durable output records an infrastructure failure");
  let persistedAnswer: string;
  let persistedConfidence: number;
  try {
    const persisted = await loadRun(expected.wireRoot, raw.record.runId as `run_${string}`);
    persistedAnswer = persisted.result?.slice(0, 2_000) ?? "";
    persistedConfidence = persisted.classification?.confidence ?? 0;
  } catch {
    throw new HarnessContractError("Durable output points to an invalid persisted run");
  }
  if (hashText(persistedAnswer) !== raw.record.answerSha256) {
    throw new HarnessContractError("Durable output answer evidence changed");
  }
  const record: HarnessRecord = {
    task: expected.taskId,
    objective: expected.objective,
    arm: "wire",
    rep: 1,
    ok: raw.record.ok,
    wallMs: raw.record.wallMs,
    judgeScore: raw.record.judgeScore,
    success: raw.record.success,
    answer: persistedAnswer,
    native: {
      runId: raw.record.runId,
      status: raw.record.nativeStatus,
      classification: raw.record.nativeClassification,
      confidence: persistedConfidence,
      summary: null,
      provider: null,
      model: null,
      costUsd: null,
    },
  };
  return validateHarnessRecord(record, expected);
}

export function harnessArguments(input: {
  spec: CampaignSpec;
  suitePath: string;
  taskId: string;
  stamp: string;
}): string[] {
  if (!isAbsolute(input.suitePath)) throw new Error("Harness suite path must be absolute");
  if (!SAFE_STAMP.test(input.stamp)) throw new Error(`Unsafe harness stamp: ${input.stamp}`);
  if (!SAFE_TASK_ID.test(input.taskId)) throw new Error(`Unsafe harness task id: ${input.taskId}`);
  for (const [label, value] of [
    ["judge model", input.spec.judge.model],
    ["Wire model", input.spec.wire.model],
  ] as const) {
    if (value.startsWith("--") || value.includes("\0")) {
      throw new Error(`Unsafe ${label} flag value`);
    }
  }
  return [
    "--arms", "wire",
    "--suite", input.suitePath,
    "--tasks", input.taskId,
    "--reps", "1",
    "--stamp", input.stamp,
    "--skip-build",
    "--judge-model", input.spec.judge.model,
    "--judge-threshold", String(input.spec.judge.threshold),
    "--wire-provider", input.spec.wire.provider,
    "--wire-model", input.spec.wire.model,
    "--timeout", String(input.spec.wire.timeoutMs),
  ];
}

async function parseHarnessJsonl(
  outputPath: string,
  expected: ExpectedHarnessRecord,
): Promise<HarnessRecord> {
  let content: string;
  try {
    content = await readFile(outputPath, "utf8");
  } catch (error) {
    throw new HarnessContractError(`Harness produced no readable result: ${errorMessage(error)}`);
  }
  if (Buffer.byteLength(content) > MAX_JSONL_BYTES) {
    throw new HarnessContractError("Harness result exceeded the bounded JSONL size");
  }

  const lines = content.split(/\r?\n/u);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length !== 1 || lines[0]!.trim().length === 0) {
    throw new HarnessContractError(`Expected exactly one harness record, found ${lines.filter(Boolean).length}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(lines[0]!) as unknown;
  } catch {
    throw new HarnessContractError("Harness result is not valid JSON");
  }

  let record: HarnessRecord;
  try {
    record = harnessRecordSchema.parse(raw);
  } catch {
    throw new HarnessContractError("Harness result does not match the frozen record contract");
  }
  return validateHarnessRecord(record, expected);
}

async function validateHarnessRecord(
  record: HarnessRecord,
  expected: ExpectedHarnessRecord,
): Promise<HarnessRecord> {
  if (
    record.task !== expected.taskId
    || record.objective !== expected.objective
    || record.arm !== "wire"
    || record.rep !== 1
  ) {
    throw new HarnessContractError("Harness result identity does not match the requested task/arm/repetition", record);
  }
  if (record.native.runId === null || !runIdSchema.safeParse(record.native.runId).success) {
    throw new HarnessContractError("Harness result has no valid native.runId", record);
  }

  let persistedRun;
  try {
    persistedRun = await loadRun(expected.wireRoot, record.native.runId as `run_${string}`);
  } catch {
    throw new HarnessContractError("native.runId is not a valid persisted run in the isolated WIRE_ROOT", record);
  }
  const persistedAnswer = persistedRun.result ?? "";
  if (
    persistedAnswer.slice(0, 2_000) !== record.answer
    || persistedRun.status !== record.native.status
    || (persistedRun.classification?.kind ?? "unknown") !== record.native.classification
    || (persistedRun.classification?.confidence ?? 0) !== record.native.confidence
  ) {
    throw new HarnessContractError("Harness native envelope does not match the persisted run", record);
  }
  if (record.native.classification === "infra-error") {
    throw new HarnessContractError("Wire persisted an infrastructure-classified run", record);
  }

  if (record.judgeScore === null) {
    throw new HarnessContractError("Judge output is unscorable", record);
  }
  const computedSuccess = record.ok && record.judgeScore >= expected.threshold;
  if (record.success !== computedSuccess) {
    throw new HarnessContractError("Harness success does not match the frozen judge threshold", record);
  }
  return record;
}

function diagnosticFrom(record: HarnessRecord | undefined, childStderr: string, extra = ""): string {
  return sanitizeDiagnostic([
    record?.note ?? "",
    childStderr,
    extra,
  ].filter(Boolean).join("\n"));
}

function normalizedPhysicalResult(input: {
  arm: Arm;
  revision: RevisionUnderTest;
  outputPath: string;
  wireRoot: string;
  skillRoot: string;
  startedAt: string;
  finishedAt: string;
  child: ChildResult;
  outputSha256: string | null;
  record?: HarnessRecord;
  failure?: string;
}): PhysicalResult {
  const runId = input.record?.native.runId;
  const base = {
    arm: input.arm,
    status: input.failure === undefined ? "completed" as const : "infrastructure-failure" as const,
    runId: runId !== undefined && runId !== null && runIdSchema.safeParse(runId).success ? runId : null,
    judgeScore: input.record?.judgeScore ?? null,
    success: input.failure === undefined ? (input.record?.success ?? null) : null,
    wallMs: input.record?.wallMs ?? input.child.wallMs,
    nativeStatus: input.record?.native.status ?? null,
    nativeClassification: input.record?.native.classification ?? null,
    harnessOutputPath: input.outputPath,
    harnessOutputSha256: input.outputSha256,
    subprocess: {
      exitCode: input.child.code,
      signal: input.child.signal,
      timedOut: input.child.timedOut,
      wallMs: input.child.wallMs,
    },
    commit: input.revision.commit,
    wireRoot: input.wireRoot,
    skillRoot: input.skillRoot,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    stderr: diagnosticFrom(input.record, input.child.stderr),
  };
  return input.failure === undefined
    ? base
    : { ...base, failureReason: sanitizeDiagnostic(input.failure) };
}

function expectedAttempt(
  spec: CampaignSpec,
  candidateId: string,
  cohort: CohortName,
  slot: PairedSlot,
): Attempt {
  return {
    version: 1,
    campaignId: spec.id,
    candidateId,
    cohort,
    slotId: slot.slotId,
    slotIndex: slot.slotIndex,
    taskId: slot.taskId,
    repetition: slot.repetition,
    order: slot.order,
    results: [],
    complete: false,
  };
}

function validateExistingAttempt(actual: Attempt, expected: Attempt): void {
  const identity = [
    "version",
    "campaignId",
    "candidateId",
    "cohort",
    "slotId",
    "slotIndex",
    "taskId",
    "repetition",
  ] as const;
  for (const key of identity) {
    if (actual[key] !== expected[key]) throw new Error(`Persisted attempt ${actual.slotId} has mismatched ${key}`);
  }
  if (actual.order[0] !== expected.order[0] || actual.order[1] !== expected.order[1]) {
    throw new Error(`Persisted attempt ${actual.slotId} has mismatched seeded order`);
  }
  const resultArms = actual.results.map((result) => result.arm);
  if (new Set(resultArms).size !== resultArms.length) {
    throw new Error(`Persisted attempt ${actual.slotId} has duplicate arm results`);
  }
  for (let index = 0; index < resultArms.length; index += 1) {
    if (resultArms[index] !== actual.order[index]) {
      throw new Error(`Persisted attempt ${actual.slotId} results are not an order prefix`);
    }
  }
  const derivedComplete = actual.results.length === 2
    && actual.results.every((result) => result.status === "completed");
  if (actual.complete !== derivedComplete) {
    throw new Error(`Persisted attempt ${actual.slotId} has inconsistent completion state`);
  }
}

function isPathInside(root: string, path: string): boolean {
  const child = relative(resolve(root), resolve(path));
  return child !== ""
    && child !== ".."
    && !child.startsWith("../")
    && !child.startsWith("..\\")
    && !isAbsolute(child);
}

async function verifyPersistedAttemptEvidence(
  attempt: Attempt,
  options: ReattestPairedOptions,
): Promise<void> {
  for (const result of attempt.results) {
    if (result.status !== "completed") continue;
    const revision = revisionFor(result.arm, options);
    if (result.commit !== revision.commit) {
      throw new Error(`Persisted result ${attempt.slotId}/${result.arm} has the wrong commit`);
    }
    const expectedWireRoot = resolve(options.paths.traces, attempt.slotId, result.arm);
    const skillSnapshot = result.arm === "candidate" && options.candidateSkillSnapshot !== undefined
      ? options.candidateSkillSnapshot
      : options.spec.skillSnapshot;
    const expectedSkillRoot = resolve(
      options.paths.skills,
      skillSnapshot.sha256,
      attempt.slotId,
      result.arm,
    );
    if (resolve(result.wireRoot) !== expectedWireRoot || resolve(result.skillRoot) !== expectedSkillRoot) {
      throw new Error(`Persisted result ${attempt.slotId}/${result.arm} has mismatched isolation roots`);
    }
    if (!isPathInside(join(options.paths.attempts, "raw"), result.harnessOutputPath)) {
      throw new Error(`Persisted result ${attempt.slotId}/${result.arm} points outside durable output storage`);
    }
    if (result.harnessOutputSha256 === null) {
      throw new Error(`Persisted result ${attempt.slotId}/${result.arm} has no output hash`);
    }
    const outputHash = await sha256Path(result.harnessOutputPath);
    if (outputHash !== result.harnessOutputSha256) {
      throw new Error(`Persisted result ${attempt.slotId}/${result.arm} output hash changed`);
    }
    const durable = durableHarnessOutputSchema.parse(
      JSON.parse(await readFile(result.harnessOutputPath, "utf8")) as unknown,
    );
    const record = durable.record;
    if (
      record === null
      || record.success !== (record.ok && record.judgeScore >= options.spec.judge.threshold)
      || result.runId !== record.runId
      || result.judgeScore !== record.judgeScore
      || result.success !== record.success
      || result.wallMs !== record.wallMs
      || result.nativeStatus !== record.nativeStatus
      || result.nativeClassification !== record.nativeClassification
      || result.subprocess.exitCode !== durable.subprocess.exitCode
      || result.subprocess.signal !== durable.subprocess.signal
      || result.subprocess.timedOut !== durable.subprocess.timedOut
      || result.subprocess.wallMs !== durable.subprocess.wallMs
    ) {
      throw new Error(`Persisted result ${attempt.slotId}/${result.arm} fields changed`);
    }
    if (result.runId === null) throw new Error(`Persisted result ${attempt.slotId}/${result.arm} has no runId`);
    let persistedRun;
    try {
      persistedRun = await loadRun(result.wireRoot, result.runId as `run_${string}`);
    } catch {
      throw new Error(`Persisted result ${attempt.slotId}/${result.arm} run evidence changed`);
    }
    if (
      hashText(persistedRun.result?.slice(0, 2_000) ?? "") !== record.answerSha256
      || persistedRun.status !== record.nativeStatus
      || (persistedRun.classification?.kind ?? "unknown") !== record.nativeClassification
    ) {
      throw new Error(`Persisted result ${attempt.slotId}/${result.arm} run evidence changed`);
    }
  }
}

async function assertTrustedStageEvidence(
  trusted: ReadonlyMap<string, Attempt>,
  options: ReattestPairedOptions,
): Promise<void> {
  const persistedStage = (await listAttempts(options.paths)).filter((attempt) => (
    attempt.candidateId === options.candidateId && attempt.cohort === options.cohort
  ));
  if (persistedStage.length !== trusted.size) {
    throw new Error("Current stage attempt set changed while candidate code was running");
  }
  const persistedBySlot = new Map(persistedStage.map((attempt) => [attempt.slotId, attempt]));
  if (persistedBySlot.size !== persistedStage.length) {
    throw new Error("Current stage contains duplicate attempt slots");
  }
  for (const [slotId, expected] of trusted) {
    const persisted = persistedBySlot.get(slotId);
    if (persisted === undefined) throw new Error(`Trusted attempt ${slotId} disappeared`);
    if (
      JSON.stringify(attemptSchema.parse(persisted))
      !== JSON.stringify(attemptSchema.parse(expected))
    ) {
      throw new Error(`Persisted attempt ${slotId} changed while candidate code was running`);
    }
    await verifyPersistedAttemptEvidence(persisted, options);
  }
}

async function trustedStageSnapshot(
  attempts: readonly Attempt[],
  schedule: readonly PairedSlot[],
  options: ReattestPairedOptions,
): Promise<Map<string, Attempt>> {
  const selected = attempts.filter((attempt) => (
    attempt.candidateId === options.candidateId && attempt.cohort === options.cohort
  ));
  const bySlot = new Map(selected.map((attempt) => [attempt.slotId, attempt]));
  if (bySlot.size !== selected.length) {
    throw new Error("Current stage contains duplicate attempt slots");
  }
  const scheduled = new Map(schedule.map((slot) => [slot.slotId, slot]));
  for (const attempt of selected) {
    const slot = scheduled.get(attempt.slotId);
    if (slot === undefined) {
      throw new Error(`Current stage contains unknown attempt slot ${attempt.slotId}`);
    }
    validateExistingAttempt(
      attempt,
      expectedAttempt(options.spec, options.candidateId, options.cohort, slot),
    );
    await verifyPersistedAttemptEvidence(attempt, options);
  }
  return bySlot;
}

export async function reattestPairedCohort(options: ReattestPairedOptions): Promise<Attempt[]> {
  await verifyFrozenInputs(options.spec, options.cohort === "holdout");
  const input = await cohortInput(options.spec, options.cohort);
  const schedule = createPairedSchedule({
    campaignId: options.spec.id,
    candidateId: options.candidateId,
    cohort: options.cohort,
    seed: options.spec.seed,
    taskIds: input.tasks.map((task) => task.id),
    pairedSlots: input.pairedSlots,
  });
  const selected = (await listAttempts(options.paths)).filter((attempt) => (
    attempt.candidateId === options.candidateId && attempt.cohort === options.cohort
  ));
  if (selected.length !== schedule.length) {
    throw new Error(`Persisted ${options.cohort} attempt count does not match the frozen schedule`);
  }
  const bySlot = new Map(selected.map((attempt) => [attempt.slotId, attempt]));
  if (bySlot.size !== selected.length) {
    throw new Error(`Persisted ${options.cohort} attempts contain duplicate slots`);
  }
  const attested: Attempt[] = [];
  for (const slot of schedule) {
    const attempt = bySlot.get(slot.slotId);
    if (attempt === undefined) {
      throw new Error(`Persisted ${options.cohort} attempt is missing scheduled slot ${slot.slotId}`);
    }
    validateExistingAttempt(
      attempt,
      expectedAttempt(options.spec, options.candidateId, options.cohort, slot),
    );
    if (!attempt.complete) {
      throw new Error(`Persisted ${options.cohort} attempt ${slot.slotId} is incomplete`);
    }
    await verifyPersistedAttemptEvidence(attempt, options);
    attested.push(attempt);
  }
  return attested;
}

interface PreparedPhysicalPaths extends AttemptIsolation {
  launcherDirectory: string;
  harnessHome: string;
}

async function resolveControllerExecutable(
  name: string,
  environment: NodeJS.ProcessEnv,
  protectedRoots: readonly string[],
): Promise<string> {
  if (!/^[a-zA-Z0-9._-]+$/u.test(name)) throw new Error(`Unsafe controller executable name: ${name}`);
  const search = environment.PATH?.split(delimiter) ?? [];
  for (const directory of search) {
    if (directory === "" || !isAbsolute(directory) || resolve(directory) !== directory) {
      throw new Error("Controller PATH contains an empty, relative, or non-normalized entry");
    }
    const candidate = join(directory, name);
    if (protectedRoots.some((root) => isPathInside(root, candidate))) {
      try {
        await access(candidate, fsConstants.X_OK);
        throw new Error(`Controller ${name} resolves through candidate- or campaign-writable PATH: ${candidate}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    try {
      await access(candidate, fsConstants.X_OK);
      const canonical = await realpath(candidate);
      const info = await stat(canonical);
      if (!info.isFile()) continue;
      if (protectedRoots.some((root) => isPathInside(root, canonical))) {
        throw new Error(`Controller ${name} resolves into candidate- or campaign-writable storage: ${canonical}`);
      }
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Could not resolve a trusted controller ${name} executable`);
}

function candidatePhysicalEnvironment(input: {
  source: NodeJS.ProcessEnv;
  isolation: AttemptIsolation;
  spec: CampaignSpec;
}): NodeJS.ProcessEnv {
  const candidateHome = join(input.isolation.wireRoot, "home");
  return {
    ...selectEnvironment(input.source, [
      "LANG",
      "LC_ALL",
      "TZ",
      "NODE_EXTRA_CA_CERTS",
      "STEEL_API_KEY",
      "STEEL_BASE_URL",
      ...providerEnvironmentKeys(input.spec.wire.provider),
    ]),
    HOME: candidateHome,
    PATH: dirname(process.execPath),
    WIRE_ROOT: input.isolation.wireRoot,
    WIRE_SKILLS: input.isolation.skillRoot,
    WIRE_HOME: candidateHome,
    WIRE_PROVIDER: input.spec.wire.provider,
    WIRE_MODEL: input.spec.wire.model,
    CI: "1",
    NO_COLOR: "1",
  };
}

async function preparePhysicalPaths(input: {
  spec: CampaignSpec;
  paths: CampaignPaths;
  slot: PairedSlot;
  arm: Arm;
  revision: RevisionUnderTest;
  skillSnapshot: Readonly<{ path: string; sha256: string }>;
  env: NodeJS.ProcessEnv;
  claudeExecutable?: string;
}): Promise<PreparedPhysicalPaths> {
  const isolation = await prepareAttemptIsolation({
    paths: input.paths,
    slotId: input.slot.slotId,
    arm: input.arm,
    skillSnapshotPath: input.skillSnapshot.path,
    skillSnapshotHash: input.skillSnapshot.sha256,
  });
  const launcherDirectory = resolve(
    input.paths.attempts,
    "launchers",
    input.slot.slotId,
    input.arm,
  );
  if (await pathExists(launcherDirectory)) {
    const launcherInfo = await lstat(launcherDirectory);
    if (
      launcherInfo.isSymbolicLink()
      || !launcherInfo.isDirectory()
      || await realpath(launcherDirectory) !== launcherDirectory
    ) {
      throw new Error(`Stale attempt launcher is not a real directory: ${launcherDirectory}`);
    }
    await rm(launcherDirectory, { recursive: true, force: false });
  }
  const harnessHome = join(launcherDirectory, "home");
  await mkdir(join(harnessHome, ".steel", "bin"), { recursive: true, mode: 0o700 });
  const candidateEnvironment = candidatePhysicalEnvironment({
    source: input.env,
    isolation,
    spec: input.spec,
  });
  const forwardedEnvironmentKeys = [
    "STEEL_API_KEY",
    "STEEL_BASE_URL",
    ...providerEnvironmentKeys(input.spec.wire.provider),
  ].filter((name) => candidateEnvironment[name] !== undefined);
  await createWireShim(
    isolation,
    input.revision.worktreePath,
    {
      launcherDirectory,
      candidateEnvironment,
      forwardedEnvironmentKeys,
      timeoutMs: input.spec.wire.timeoutMs,
    },
  );
  if (input.claudeExecutable !== undefined) {
    await createClaudeJudgeShim({
      launcherDirectory,
      claudeExecutable: input.claudeExecutable,
      harnessHome,
    });
  }
  return { ...isolation, launcherDirectory, harnessHome };
}

function physicalEnvironment(input: {
  source: NodeJS.ProcessEnv;
  isolation: PreparedPhysicalPaths;
  spec: CampaignSpec;
}): NodeJS.ProcessEnv {
  const base = harnessEnvironment({
    isolation: input.isolation,
    launcherDirectory: input.isolation.launcherDirectory,
    harnessHome: input.isolation.harnessHome,
    inheritedEnv: input.source,
    allowedEnvironmentKeys: harnessEnvironmentKeys(input.spec),
  });
  return {
    ...base,
    WIRE_HOME: join(input.isolation.wireRoot, "home"),
    WIRE_PROVIDER: input.spec.wire.provider,
    WIRE_MODEL: input.spec.wire.model,
    NO_COLOR: "1",
  };
}

async function runPhysical(input: {
  spec: CampaignSpec;
  state: CampaignState;
  paths: CampaignPaths;
  slot: PairedSlot;
  arm: Arm;
  revision: RevisionUnderTest;
  skillSnapshot: Readonly<{ path: string; sha256: string }>;
  suitePath: string;
  objective: string;
  runner: ChildRunner;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  claudeExecutable?: string;
  verifyRevision: RevisionVerifier;
}): Promise<{ state: CampaignState; result: PhysicalResult }> {
  await verifyFrozenInputs(input.spec, input.suitePath !== input.spec.suite.path);
  await input.verifyRevision(input.revision);
  const built = input.state.builtRevisions.find((entry) => (
    entry.commit === input.revision.commit
    && entry.worktreePath === resolve(input.revision.worktreePath)
  ));
  if (built === undefined) throw new Error(`Revision is not recorded as built: ${input.revision.commit}`);
  const actualDistHash = await sha256Path(join(input.revision.worktreePath, "dist"));
  if (actualDistHash !== built.distSha256) {
    throw new Error(`Built output changed before physical run: ${input.revision.commit}`);
  }
  const remainingRuns = input.spec.budget.maxPhysicalRuns - input.state.physicalRunsUsed;
  const remainingWall = input.spec.budget.maxWallClockMs - input.state.wallClockMsUsed;
  if (remainingRuns <= 0) throw new Error("Campaign physical-run budget exhausted");
  if (remainingWall <= 0) throw new Error("Campaign wall-clock budget exhausted");

  const stamp = safeStamp(input.slot.slotId, input.arm);
  const outputPath = harnessOutputPath(input.revision.worktreePath, stamp);
  if (await pathExists(dirname(outputPath))) {
    throw new Error(`Fresh physical run would append to an existing harness output: ${outputPath}`);
  }

  const startedAt = input.now().toISOString();
  let state = updatedState(input.state, input.now, {
    phase: "evaluating",
    physicalRunsUsed: input.state.physicalRunsUsed + 1,
    inFlight: {
      kind: "compare",
      commit: input.revision.commit,
      startedAt,
      slotId: input.slot.slotId,
      arm: input.arm,
    },
  });
  await saveCampaignState(input.paths, state);

  const expectedIsolation: AttemptIsolation = {
    wireRoot: resolve(input.paths.traces, input.slot.slotId, input.arm),
    skillRoot: resolve(
      input.paths.skills,
      input.skillSnapshot.sha256,
      input.slot.slotId,
      input.arm,
    ),
    skillSnapshotHash: input.skillSnapshot.sha256,
  };
  let prepared: PreparedPhysicalPaths;
  let env: NodeJS.ProcessEnv;
  try {
    prepared = await preparePhysicalPaths({
      spec: input.spec,
      paths: input.paths,
      slot: input.slot,
      arm: input.arm,
      revision: input.revision,
      skillSnapshot: input.skillSnapshot,
      env: input.env,
      ...(input.claudeExecutable === undefined ? {} : { claudeExecutable: input.claudeExecutable }),
    });
    await mkdir(join(prepared.wireRoot, "home"), { recursive: true });
    env = physicalEnvironment({
      source: input.env,
      isolation: prepared,
      spec: input.spec,
    });
  } catch (error) {
    const finishedAt = input.now().toISOString();
    const wallMs = Math.max(
      0,
      new Date(finishedAt).getTime() - new Date(startedAt).getTime(),
    );
    const failure = `Physical attempt preparation failed: ${errorMessage(error)}`;
    const child: ChildResult = {
      code: null,
      signal: null,
      stdout: "",
      stderr: failure,
      timedOut: false,
      wallMs,
    };
    const result = normalizedPhysicalResult({
      arm: input.arm,
      revision: input.revision,
      outputPath,
      wireRoot: expectedIsolation.wireRoot,
      skillRoot: expectedIsolation.skillRoot,
      startedAt,
      finishedAt,
      child,
      outputSha256: null,
      failure,
    });
    state = updatedState(state, input.now, {
      inFlight: undefined,
      wallClockMsUsed: state.wallClockMsUsed + wallMs,
    });
    return { state, result };
  }

  const child = await invokeRunner(input.runner, {
    kind: "compare",
    command: process.execPath,
    args: [
      "--experimental-strip-types",
      join(input.revision.worktreePath, "benchmarks", "compare", "run-compare.ts"),
      ...harnessArguments({
        spec: input.spec,
        suitePath: input.suitePath,
        taskId: input.slot.taskId,
        stamp,
      }),
    ],
    cwd: input.revision.worktreePath,
    env,
    timeoutMs: Math.max(
      1,
      Math.min(remainingWall, (input.spec.wire.timeoutMs * 2) + HARNESS_GRACE_MS),
    ),
  });
  const finishedAt = input.now().toISOString();

  let record: HarnessRecord | undefined;
  let failure: string | undefined;
  try {
    await input.verifyRevision(input.revision);
    await verifyFrozenInputs(input.spec, input.suitePath !== input.spec.suite.path);
    const postRunDistHash = await sha256Path(join(input.revision.worktreePath, "dist"));
    if (postRunDistHash !== built.distSha256) {
      throw new Error(`Built output changed during physical run: ${input.revision.commit}`);
    }
  } catch (error) {
    failure = `Physical-run evidence failed re-attestation: ${errorMessage(error)}`;
  }
  try {
    record = await parseHarnessJsonl(outputPath, {
      taskId: input.slot.taskId,
      objective: input.objective,
      threshold: input.spec.judge.threshold,
      wireRoot: prepared.wireRoot,
    });
  } catch (error) {
    if (error instanceof HarnessContractError) record = error.record;
    failure ??= errorMessage(error);
  }
  if (child.timedOut) failure ??= "Comparison child timed out";
  else if (child.code !== 0) failure ??= `Comparison child exited with code ${String(child.code)}`;
  let durableOutput = { path: outputPath, sha256: null as string | null };
  try {
    durableOutput = await preserveHarnessOutput(
      input.paths,
      outputPath,
      stamp,
      failure === undefined ? record : undefined,
      child,
    );
  } catch (error) {
    failure = `Harness output could not be preserved: ${errorMessage(error)}`;
  }

  const result = normalizedPhysicalResult({
    arm: input.arm,
    revision: input.revision,
    outputPath: durableOutput.path,
    wireRoot: prepared.wireRoot,
    skillRoot: prepared.skillRoot,
    startedAt,
    finishedAt,
    child,
    outputSha256: durableOutput.sha256,
    ...(record === undefined ? {} : { record }),
    ...(failure === undefined ? {} : { failure }),
  });
  state = updatedState(state, input.now, {
    inFlight: undefined,
    wallClockMsUsed: state.wallClockMsUsed + child.wallMs,
  });
  return { state, result };
}

async function recoverReservedPhysical(input: {
  spec: CampaignSpec;
  state: CampaignState;
  paths: CampaignPaths;
  slot: PairedSlot;
  arm: Arm;
  revision: RevisionUnderTest;
  skillSnapshot: Readonly<{ path: string; sha256: string }>;
  objective: string;
  now: () => Date;
}): Promise<{ state: CampaignState; result: PhysicalResult }> {
  const stamp = safeStamp(input.slot.slotId, input.arm);
  const outputPath = harnessOutputPath(input.revision.worktreePath, stamp);
  const durablePath = durableHarnessOutputPath(input.paths, stamp);
  const wireRoot = resolve(input.paths.traces, input.slot.slotId, input.arm);
  const skillRoot = resolve(
    input.paths.skills,
    input.skillSnapshot.sha256,
    input.slot.slotId,
    input.arm,
  );
  const operation = input.state.inFlight;
  if (
    operation?.kind !== "compare"
    || operation.slotId !== input.slot.slotId
    || operation.arm !== input.arm
    || operation.commit !== input.revision.commit
  ) {
    throw new Error("Reserved physical run does not match persisted in-flight provenance");
  }
  const finishedAt = input.now().toISOString();
  const elapsedSinceReservation = Math.max(
    0,
    new Date(finishedAt).getTime() - new Date(operation.startedAt).getTime(),
  );
  const child: ChildResult = {
    code: null,
    signal: null,
    stdout: "",
    stderr: "Recovered after an interrupted controller; child exit status and stderr were unavailable.",
    timedOut: false,
    wallMs: elapsedSinceReservation,
  };
  let record: HarnessRecord | undefined;
  let failure: string | undefined;
  try {
    const sourceAvailable = await pathExists(outputPath);
    const expected = {
      taskId: input.slot.taskId,
      objective: input.objective,
      threshold: input.spec.judge.threshold,
      wireRoot,
    };
    record = sourceAvailable
      ? await parseHarnessJsonl(outputPath, expected)
      : await parseDurableHarnessOutput(durablePath, expected);
  } catch (error) {
    if (error instanceof HarnessContractError) record = error.record;
    failure = `Interrupted physical run has no valid durable result: ${errorMessage(error)}`;
  }
  if (failure === undefined) {
    failure = "Controller was interrupted before the comparison subprocess exit could be attested";
  }
  let durableOutput = { path: outputPath, sha256: null as string | null };
  try {
    durableOutput = await preserveHarnessOutput(
      input.paths,
      outputPath,
      stamp,
      record,
      child,
    );
  } catch (error) {
    failure = `Interrupted harness output could not be preserved: ${errorMessage(error)}`;
  }
  const recoveredWallMs = Math.max(elapsedSinceReservation, record?.wallMs ?? 0);
  child.wallMs = recoveredWallMs;
  const result = normalizedPhysicalResult({
    arm: input.arm,
    revision: input.revision,
    outputPath: durableOutput.path,
    wireRoot,
    skillRoot,
    startedAt: operation.startedAt,
    finishedAt,
    child,
    outputSha256: durableOutput.sha256,
    ...(record === undefined ? {} : { record }),
    ...(failure === undefined ? {} : { failure }),
  });
  const state = updatedState(input.state, input.now, {
    inFlight: undefined,
    wallClockMsUsed: input.state.wallClockMsUsed + recoveredWallMs,
  });
  return { state, result };
}

function revisionFor(
  arm: Arm,
  options: Pick<EvaluatePairedOptions, "base" | "candidate">,
): RevisionUnderTest {
  return arm === "base" ? options.base : options.candidate;
}

function resultCount(attempts: Attempt[]): number {
  return attempts.reduce((sum, attempt) => sum + attempt.results.length, 0);
}

function persistedPhysicalWallMs(attempts: Attempt[]): number {
  return attempts.reduce((attemptTotal, attempt) => (
    attemptTotal + attempt.results.reduce((resultTotal, result) => (
      resultTotal + result.subprocess.wallMs
    ), 0)
  ), 0);
}

function trustedAttemptView(
  original: readonly Attempt[],
  trustedStage: ReadonlyMap<string, Attempt>,
  candidateId: string,
  cohort: CohortName,
): Attempt[] {
  return [
    ...original.filter((attempt) => (
      attempt.candidateId !== candidateId || attempt.cohort !== cohort
    )),
    ...trustedStage.values(),
  ];
}

export async function evaluatePaired(options: EvaluatePairedOptions): Promise<EvaluatePairedResult> {
  const productionExecution = options.runner === undefined;
  const runner = options.runner ?? sandboxedPreparationRunner;
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const pnpmCommand = options.pnpmCommand ?? "pnpm";
  const verifyRevision = options.verifyRevision
    ?? ((revision: RevisionUnderTest) => assertGitRevision(revision, env));
  if (options.spec.id !== options.state.campaignId || options.spec.baseCommit !== options.state.baseCommit) {
    throw new Error("Campaign spec/state provenance mismatch");
  }
  if (options.state.phase === "stopped") {
    return { state: options.state, attempts: await listAttempts(options.paths), stopped: true };
  }
  if (productionExecution && !isAbsolute(pnpmCommand)) {
    throw new Error("Live comparison requires an absolute controller-resolved pnpm executable");
  }
  let claudeExecutable: string | undefined;
  if (productionExecution) {
    const support = await probeSystemdUserSandbox();
    if (!support.supported) throw new SystemdSandboxUnsupportedError(support.reason);
    claudeExecutable = await resolveControllerExecutable("claude", env, [
      resolve(options.paths.root),
      resolve(options.base.worktreePath),
      resolve(options.candidate.worktreePath),
    ]);
  }
  if (options.candidateSkillSnapshot !== undefined) {
    const snapshot = options.candidateSkillSnapshot;
    if (resolve(snapshot.path) !== resolve(options.candidate.worktreePath, "skills")) {
      throw new Error("Candidate skill treatment must be the owned candidate worktree's skills directory");
    }
    if (!/^[a-f0-9]{64}$/u.test(snapshot.sha256)) {
      throw new Error("Candidate skill treatment has an invalid SHA-256");
    }
    const actualCandidateSkillHash = await sha256Path(snapshot.path);
    if (actualCandidateSkillHash !== snapshot.sha256) {
      throw new Error("Candidate skill treatment hash changed before evaluation");
    }
  }
  let state = options.state;
  if (state.inFlight !== undefined && state.inFlight.kind !== "compare") {
    const recoveredAt = now();
    const elapsed = Math.max(0, recoveredAt.getTime() - new Date(state.inFlight.startedAt).getTime());
    const interrupted = state.inFlight;
    state = updatedState(state, () => recoveredAt, {
      inFlight: undefined,
      wallClockMsUsed: state.wallClockMsUsed + elapsed,
      ...(interrupted.kind === "verification"
        ? { verificationWallClockMsUsed: state.verificationWallClockMsUsed + elapsed }
        : { buildWallClockMsUsed: state.buildWallClockMsUsed + elapsed }),
    });
    state = await stopCampaign(
      options.paths,
      state,
      () => recoveredAt,
      `Controller interrupted during ${interrupted.kind} for ${interrupted.commit}`,
    );
    return { state, attempts: await listAttempts(options.paths), stopped: true };
  }
  if (options.base.commit !== options.spec.baseCommit) {
    throw new Error("Base revision does not match campaign baseCommit");
  }
  for (const revision of [options.base, options.candidate]) {
    if (!isAbsolute(revision.worktreePath)) throw new Error("Revision worktree path must be absolute");
    try {
      await assertNoLocalEnv(revision.worktreePath);
    } catch (error) {
      state = await stopCampaign(options.paths, state, now, errorMessage(error));
      return { state, attempts: await listAttempts(options.paths), stopped: true };
    }
  }

  const includeHoldout = options.cohort === "holdout";
  await verifyFrozenInputs(options.spec, includeHoldout);
  const input = await cohortInput(options.spec, options.cohort);
  const schedule = createPairedSchedule({
    campaignId: options.spec.id,
    candidateId: options.candidateId,
    cohort: options.cohort,
    seed: options.spec.seed,
    taskIds: input.tasks.map((task) => task.id),
    pairedSlots: input.pairedSlots,
  });
  const taskById = new Map(input.tasks.map((task) => [task.id, task]));

  const allAttempts = await listAttempts(options.paths);
  // Candidate code shares the controller's OS account, so disk state is not a
  // trust boundary while a measured child is running. Snapshot every accepted
  // current-stage file before launching and require the complete disk set to
  // stay exactly equal after each child, including not gaining future slots.
  let trustedStageAttempts: Map<string, Attempt>;
  try {
    trustedStageAttempts = await trustedStageSnapshot(allAttempts, schedule, options);
  } catch (error) {
    state = await stopCampaign(options.paths, state, now, errorMessage(error));
    return {
      state,
      attempts: trustedAttemptView(
        allAttempts,
        new Map(),
        options.candidateId,
        options.cohort,
      ),
      stopped: true,
    };
  }
  if (state.inFlight?.kind === "compare") {
    const operation = state.inFlight;
    const persistedAttempt = allAttempts.find((attempt) => attempt.slotId === operation.slotId);
    const persistedResult = persistedAttempt?.results.find((result) => result.arm === operation.arm);
    if (persistedAttempt !== undefined && persistedResult !== undefined) {
      try {
        const scheduled = schedule.find((slot) => slot.slotId === operation.slotId);
        if (scheduled === undefined) throw new Error("Persisted in-flight result is outside the requested schedule");
        validateExistingAttempt(
          persistedAttempt,
          expectedAttempt(options.spec, options.candidateId, options.cohort, scheduled),
        );
        await verifyPersistedAttemptEvidence(persistedAttempt, options);
        if (persistedResult.commit !== operation.commit) {
          throw new Error("Persisted in-flight result has the wrong commit");
        }
      } catch (error) {
        state = await stopCampaign(options.paths, state, now, errorMessage(error));
        return { state, attempts: allAttempts, stopped: true };
      }
      // saveAttempt won the crash race but the following state write did not.
      // The immutable evidence re-attests the already-spent run, so clear only
      // the stale reservation and never launch it again.
      state = updatedState(state, now, { inFlight: undefined });
      await saveCampaignState(options.paths, state);
    }
  }
  const reconciledWallMs = state.buildWallClockMsUsed
    + state.verificationWallClockMsUsed
    + persistedPhysicalWallMs(allAttempts);
  if (state.wallClockMsUsed !== reconciledWallMs) {
    state = updatedState(state, now, { wallClockMsUsed: reconciledWallMs });
    await saveCampaignState(options.paths, state);
  }
  for (const revision of [options.base, options.candidate]) {
    state = await ensureBuilt({
      revision,
      state,
      spec: options.spec,
      paths: options.paths,
      runner,
      env,
      now,
      pnpmCommand,
      verifyRevision,
    });
    if (state.phase === "stopped") {
      return { state, attempts: await listAttempts(options.paths), stopped: true };
    }
  }
  try {
    await assertTrustedStageEvidence(trustedStageAttempts, options);
  } catch (error) {
    state = await stopCampaign(options.paths, state, now, errorMessage(error));
    return {
      state,
      attempts: trustedAttemptView(
        allAttempts,
        trustedStageAttempts,
        options.candidateId,
        options.cohort,
      ),
      stopped: true,
    };
  }

  let persistedResults = resultCount(allAttempts);
  if (state.physicalRunsUsed < persistedResults) {
    state = await stopCampaign(options.paths, state, now, "Campaign physical-run count is lower than persisted results");
    return { state, attempts: allAttempts, stopped: true };
  }
  if (state.physicalRunsUsed - persistedResults > 1) {
    state = await stopCampaign(options.paths, state, now, "More than one physical run lacks a durable result");
    return { state, attempts: await listAttempts(options.paths), stopped: true };
  }

  for (const slot of schedule) {
    const skeleton = expectedAttempt(options.spec, options.candidateId, options.cohort, slot);
    let attempt = await loadAttempt(options.paths, slot.slotId);
    const wasPersisted = attempt !== undefined;
    if (attempt === undefined) {
      attempt = skeleton;
      await saveAttempt(options.paths, attempt);
    } else {
      try {
        validateExistingAttempt(attempt, skeleton);
        await verifyPersistedAttemptEvidence(attempt, options);
      } catch (error) {
        state = await stopCampaign(options.paths, state, now, errorMessage(error));
        return { state, attempts: await listAttempts(options.paths), stopped: true };
      }
    }
    trustedStageAttempts.set(slot.slotId, attempt);

    if (attempt.results.some((result) => result.status === "infrastructure-failure")) {
      state = await stopCampaign(options.paths, state, now, `Attempt ${slot.slotId} already has an infrastructure failure`);
      return { state, attempts: await listAttempts(options.paths), stopped: true };
    }
    if (attempt.complete) {
      if (!state.completedSlots.includes(slot.slotId)) {
        state = updatedState(state, now, { completedSlots: [...state.completedSlots, slot.slotId] });
        await saveCampaignState(options.paths, state);
      }
      continue;
    }

    const task = taskById.get(slot.taskId);
    if (task === undefined) throw new Error(`Scheduled task is absent from frozen suite: ${slot.taskId}`);
    for (const arm of slot.order) {
      if (attempt.results.some((result) => result.arm === arm)) continue;
      const revision = revisionFor(arm, options);
      const skillSnapshot = arm === "candidate" && options.candidateSkillSnapshot !== undefined
        ? options.candidateSkillSnapshot
        : options.spec.skillSnapshot;
      let physical: { state: CampaignState; result: PhysicalResult };
      const outstanding = state.physicalRunsUsed - persistedResults;
      if (outstanding === 1) {
        if (!wasPersisted || state.inFlight?.kind !== "compare") {
          state = await stopCampaign(
            options.paths,
            state,
            now,
            "Reserved physical run has no matching persisted in-flight attempt",
          );
          return { state, attempts: await listAttempts(options.paths), stopped: true };
        }
        try {
          physical = await recoverReservedPhysical({
            spec: options.spec,
            state,
            paths: options.paths,
            slot,
            arm,
            revision,
            skillSnapshot,
            objective: task.objective,
            now,
          });
        } catch (error) {
          state = await stopCampaign(options.paths, state, now, errorMessage(error));
          return { state, attempts: await listAttempts(options.paths), stopped: true };
        }
      } else if (outstanding === 0) {
        if (state.inFlight !== undefined) {
          state = await stopCampaign(options.paths, state, now, "In-flight provenance has no physical-run reservation");
          return { state, attempts: await listAttempts(options.paths), stopped: true };
        }
        try {
          physical = await runPhysical({
            spec: options.spec,
            state,
            paths: options.paths,
            slot,
            arm,
            revision,
            skillSnapshot,
            suitePath: input.suitePath,
            objective: task.objective,
            runner,
            env,
            now,
            ...(claudeExecutable === undefined ? {} : { claudeExecutable }),
            verifyRevision,
          });
        } catch (error) {
          state = await stopCampaign(options.paths, state, now, errorMessage(error));
          return { state, attempts: await listAttempts(options.paths), stopped: true };
        }
      } else {
        state = await stopCampaign(options.paths, state, now, "Physical-run accounting is inconsistent");
        return { state, attempts: await listAttempts(options.paths), stopped: true };
      }

      attempt = {
        ...attempt,
        results: [...attempt.results, physical.result],
        complete: false,
      };
      if (attempt.results.length === 2 && attempt.results.every((result) => result.status === "completed")) {
        attempt.complete = true;
      }
      await saveAttempt(options.paths, attempt);
      trustedStageAttempts.set(slot.slotId, attempt);
      state = physical.state;
      try {
        await assertTrustedStageEvidence(trustedStageAttempts, options);
      } catch (error) {
        state = await stopCampaign(options.paths, state, now, errorMessage(error));
        return {
          state,
          attempts: trustedAttemptView(
            allAttempts,
            trustedStageAttempts,
            options.candidateId,
            options.cohort,
          ),
          stopped: true,
        };
      }
      persistedResults += 1;
      if (attempt.complete && !state.completedSlots.includes(slot.slotId)) {
        state = updatedState(state, now, { completedSlots: [...state.completedSlots, slot.slotId] });
      }
      if (physical.result.status === "infrastructure-failure") {
        state = await stopCampaign(
          options.paths,
          state,
          now,
          physical.result.failureReason ?? "Comparison infrastructure failure",
        );
        return { state, attempts: await listAttempts(options.paths), stopped: true };
      }
      await saveCampaignState(options.paths, state);
      if (state.wallClockMsUsed >= options.spec.budget.maxWallClockMs) {
        state = await stopCampaign(options.paths, state, now, "Campaign wall-clock budget exhausted");
        return { state, attempts: await listAttempts(options.paths), stopped: true };
      }
    }
  }

  const safeAttempts = trustedAttemptView(
    allAttempts,
    trustedStageAttempts,
    options.candidateId,
    options.cohort,
  );
  try {
    const finalAttempts = (await listAttempts(options.paths)).filter((attempt) => (
      attempt.candidateId === options.candidateId && attempt.cohort === options.cohort
    ));
    if (finalAttempts.length !== schedule.length) {
      throw new Error("Final stage attempt count changed while candidate code was running");
    }
    const finalBySlot = new Map(finalAttempts.map((attempt) => [attempt.slotId, attempt]));
    if (finalBySlot.size !== finalAttempts.length) {
      throw new Error("Final stage contains duplicate attempt slots");
    }
    for (const slot of schedule) {
      const trusted = trustedStageAttempts.get(slot.slotId);
      const persisted = finalBySlot.get(slot.slotId);
      if (trusted === undefined || persisted === undefined) {
        throw new Error(`Final stage is missing trusted slot ${slot.slotId}`);
      }
      if (
        JSON.stringify(attemptSchema.parse(persisted))
        !== JSON.stringify(attemptSchema.parse(trusted))
      ) {
        throw new Error(`Persisted attempt ${slot.slotId} changed while candidate code was running`);
      }
      validateExistingAttempt(
        persisted,
        expectedAttempt(options.spec, options.candidateId, options.cohort, slot),
      );
      await verifyPersistedAttemptEvidence(persisted, options);
    }
  } catch (error) {
    state = await stopCampaign(options.paths, state, now, errorMessage(error));
    return { state, attempts: safeAttempts, stopped: true };
  }

  return { state, attempts: safeAttempts, stopped: false };
}
