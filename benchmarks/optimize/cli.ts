import { constants as fsConstants } from "node:fs";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { atomicWriteJson, readJsonFile } from "../../src/storage/atomic.js";
import { containsSecrets, redactSecrets } from "../../src/shared/redact.js";
import type { RunId } from "../../src/shared/types.js";
import { persistRunAutopsy } from "./autopsy.js";
import {
  evaluatePaired,
  reattestPairedCohort,
  type ChildRunner,
  type RevisionUnderTest,
} from "./compare.js";
import {
  acceptPacketResponse,
  loadCampaignPendingPacket,
  writeNextAction,
} from "./handoff.js";
import { withCampaignLock } from "./lock.js";
import {
  candidateResponseSchema,
  controllerResponseSchema,
  hasRequiredCandidateChecks,
  parseCampaignRecipe,
  type Attempt,
  type CampaignRecipe,
  type CampaignState,
  type CandidateRecord,
  type CandidateResponse,
  type CohortName,
  type NextActionPacket,
  type ScoreSummary,
} from "./model.js";
import {
  defaultOptimizerRoot,
  initializeCampaign,
  listAttempts,
  loadCampaign,
  saveCandidateResponse,
  saveCampaignState,
  sha256Path,
  verifyFrozenInputs,
  type CampaignPaths,
} from "./state.js";
import {
  runSystemdSandbox,
  SystemdSandboxUnsupportedError,
  type SystemdSandboxRequest,
  type SystemdSandboxResult,
} from "./sandbox.js";
import { decideGate, isDocumentedSimplification, scoreAttempts } from "./tournament.js";
import {
  cleanupCampaignWorktrees,
  createDetachedBaseWorktree,
  createDetachedCandidateWorktree,
  spawnGit,
  validateCandidateWorktree,
  type CandidateValidation,
  type GitRunner,
} from "./worktree.js";

const FULL_COMMIT = /^[a-f0-9]{40}$/u;
const CHECK_TIMEOUT_MS = 15 * 60_000;
const BASELINE_ID = "baseline-calibration";

type CommandName =
  | "init"
  | "status"
  | "next"
  | "baseline"
  | "ingest"
  | "evaluate"
  | "holdout"
  | "cleanup";

interface ParsedCommand {
  command: CommandName;
  values: Readonly<Record<string, string | boolean>>;
}

interface PreparedInitialization {
  recipePath: string;
  recipe: CampaignRecipe;
}

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface CommandResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  wallMs: number;
}

export type CommandRunner = (invocation: CommandInvocation) => Promise<CommandResult>;
export type SystemdSandboxRunner = (
  request: SystemdSandboxRequest,
) => Promise<SystemdSandboxResult>;

export interface CliContext {
  repositoryRoot?: string;
  optimizerRoot?: string;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  pnpmCommand?: string;
  gitRunner?: GitRunner;
  commandRunner?: CommandRunner;
  systemdSandboxRunner?: SystemdSandboxRunner;
  compareRunner?: ChildRunner;
  write?: (text: string) => void;
}

const commandFlags: Record<CommandName, Readonly<Record<string, "value" | "boolean">>> = {
  init: { campaign: "value", base: "value" },
  status: { campaign: "value", json: "boolean" },
  next: { campaign: "value" },
  baseline: { campaign: "value" },
  ingest: { campaign: "value", response: "value" },
  evaluate: { campaign: "value", candidate: "value", cohort: "value" },
  holdout: { campaign: "value", candidate: "value" },
  cleanup: { campaign: "value" },
};

function usage(): string {
  return [
    "Usage:",
    "  optimize init --campaign <recipe.json> --base <commit>",
    "  optimize status --campaign <id> [--json]",
    "  optimize next --campaign <id>",
    "  optimize baseline --campaign <id>",
    "  optimize ingest --campaign <id> --response <response.json>",
    "  optimize evaluate --campaign <id> --candidate <id> --cohort <targeted|smoke|broad>",
    "  optimize holdout --campaign <id> --candidate <id>",
    "  optimize cleanup --campaign <id>",
  ].join("\n");
}

function parseArguments(args: readonly string[]): ParsedCommand {
  const command = args[0];
  if (command === undefined || !Object.hasOwn(commandFlags, command)) {
    throw new Error(`${command === undefined ? "Missing" : `Unknown`} command.\n${usage()}`);
  }
  const name = command as CommandName;
  const allowed = commandFlags[name];
  const values: Record<string, string | boolean> = {};
  for (let index = 1; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("--") || token === "--" || token.includes("=")) {
      throw new Error(`Unexpected argument for ${name}: ${token}`);
    }
    const flag = token.slice(2);
    const kind = allowed[flag];
    if (kind === undefined) throw new Error(`Unknown option for ${name}: ${token}`);
    if (values[flag] !== undefined) throw new Error(`Duplicate option for ${name}: ${token}`);
    if (kind === "boolean") {
      values[flag] = true;
      continue;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Option ${token} requires a value`);
    }
    values[flag] = value;
    index += 1;
  }
  for (const [flag, kind] of Object.entries(allowed)) {
    if (kind === "value" && values[flag] === undefined) {
      throw new Error(`Missing required option for ${name}: --${flag}`);
    }
  }
  return { command: name, values };
}

function value(command: ParsedCommand, flag: string): string {
  const found = command.values[flag];
  if (typeof found !== "string") throw new Error(`Missing --${flag}`);
  return found;
}

const OFFLINE_VERIFICATION_ENVIRONMENT_NAMES = [
  "CI",
  "HOME",
  "LANG",
  "LC_ALL",
  "NO_COLOR",
  "TZ",
  "WIRE_HOME",
  "WIRE_ROOT",
  "WIRE_SKILLS",
] as const;

export function createSystemdCommandRunner(
  sandboxRunner: SystemdSandboxRunner = runSystemdSandbox,
): CommandRunner {
  return async (invocation) => {
    const home = invocation.env.HOME;
    if (home === undefined || !isAbsolute(home)) {
      throw new Error("Sandboxed verification requires an absolute offline HOME");
    }
    if (!isAbsolute(invocation.command)) {
      throw new Error("Sandboxed verification requires an absolute command path");
    }
    const environmentNames = OFFLINE_VERIFICATION_ENVIRONMENT_NAMES.filter((name) => (
      invocation.env[name] !== undefined
    ));
    const result = await sandboxRunner({
      command: invocation.command,
      args: invocation.args,
      cwd: invocation.cwd,
      environment: invocation.env,
      environmentNames,
      readOnlyPaths: [],
      readWritePaths: [invocation.cwd, home],
      timeoutMs: invocation.timeoutMs,
    });
    return {
      code: result.code,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
      wallMs: result.wallMs,
    };
  };
}

/** Default verification is a fail-closed Linux user-service sandbox. */
export const spawnCommand: CommandRunner = createSystemdCommandRunner();

async function resolveExecutable(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  const candidates = isAbsolute(command)
    ? [command]
    : (env.PATH ?? "").split(delimiter).filter(isAbsolute).map((entry) => join(entry, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return realpath(candidate);
    } catch {
      // Continue through the controller's trusted PATH without invoking a shell.
    }
  }
  throw new Error(`Required executable is unavailable in the controller PATH: ${command}`);
}

function offlineVerificationEnvironment(source: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    HOME: home,
    CI: "1",
    NO_COLOR: "1",
    WIRE_HOME: join(home, "wire"),
    WIRE_ROOT: join(home, "wire", "state"),
    WIRE_SKILLS: join(home, "wire", "skills"),
  };
  for (const key of ["LANG", "LC_ALL", "TZ"]) {
    const found = source[key];
    if (found !== undefined) environment[key] = found;
  }
  return environment;
}

async function removeVerificationHome(campaignRoot: string, home: string): Promise<void> {
  const expectedRoot = resolve(campaignRoot);
  const expectedHome = resolve(home);
  if (dirname(expectedHome) !== expectedRoot || !expectedHome.startsWith(`${expectedRoot}/offline-home-`)) {
    throw new Error(`Refusing to remove an unexpected verification HOME: ${expectedHome}`);
  }
  let canonical: string;
  try {
    canonical = await realpath(expectedHome);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (canonical !== expectedHome) {
    throw new Error(`Refusing to remove a redirected verification HOME: ${expectedHome}`);
  }
  await rm(expectedHome, { recursive: true, force: false });
}

async function checkedGit(runner: GitRunner, cwd: string, args: readonly string[]): Promise<string> {
  const result = await runner({ cwd, args });
  if (result.code !== 0) {
    const detail = redactSecrets(result.stderr || result.stdout).trim().slice(0, 1_000);
    throw new Error(`git ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`);
  }
  return result.stdout.trim();
}

async function resolveCleanBase(
  repositoryRoot: string,
  selectedBase: string,
  runner: GitRunner,
): Promise<string> {
  const actualRoot = resolve(await checkedGit(runner, repositoryRoot, ["rev-parse", "--show-toplevel"]));
  if (actualRoot !== resolve(repositoryRoot)) {
    throw new Error(`repositoryRoot is not the Git worktree root: ${repositoryRoot}`);
  }
  const status = await checkedGit(runner, repositoryRoot, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status !== "") throw new Error("Source worktree must be clean before campaign initialization");
  const commit = await checkedGit(runner, repositoryRoot, [
    "rev-parse",
    "--verify",
    `${selectedBase}^{commit}`,
  ]);
  if (!FULL_COMMIT.test(commit)) throw new Error(`Git returned an invalid full commit SHA: ${commit}`);
  return commit;
}

function printJson(write: (text: string) => void, data: unknown): void {
  write(`${JSON.stringify(data, null, 2)}\n`);
}

function nowIso(now: () => Date): string {
  return now().toISOString();
}

function attemptsFor(
  attempts: readonly Attempt[],
  candidateId: string,
  cohort: CohortName,
): Attempt[] {
  return attempts.filter((attempt) => (
    attempt.candidateId === candidateId && attempt.cohort === cohort
  ));
}

function policyValidityReasons(attempts: readonly Attempt[]): string[] {
  const reasons: string[] = [];
  for (const attempt of attempts) {
    const base = attempt.results.find((result) => result.arm === "base");
    const candidate = attempt.results.find((result) => result.arm === "candidate");
    if (
      candidate?.nativeClassification === "blocked-policy"
      && base?.nativeClassification !== "blocked-policy"
    ) {
      reasons.push(`candidate introduced a policy-blocked run in ${attempt.slotId}`);
    }
    if (
      candidate?.nativeStatus === "awaiting-approval"
      && base?.nativeStatus !== "awaiting-approval"
    ) {
      reasons.push(`candidate introduced an unresolved approval in ${attempt.slotId}`);
    }
  }
  return [...new Set(reasons)];
}

async function persistAutopsies(
  paths: CampaignPaths,
  campaignId: string,
  attempts: readonly Attempt[],
  holdout: boolean,
  now: () => Date,
): Promise<void> {
  for (const attempt of attempts) {
    for (const result of attempt.results) {
      if (result.runId === null) continue;
      await persistRunAutopsy({
        campaignId,
        runId: result.runId as RunId,
        // Handoff's cluster loader deliberately excludes this prefix. It keeps
        // sealed trace details out of every future packet while preserving the
        // aggregate score in campaign state.
        attemptSlotId: holdout ? `holdout-${attempt.slotId}` : attempt.slotId,
        arm: result.arm,
        wireRoot: result.wireRoot,
        outputPath: join(paths.autopsies, `${result.runId}.json`),
        judgeSuccess: result.success,
        generatedAt: nowIso(now),
      });
    }
  }
}

function expectedSlots(
  cohort: CohortName,
  spec: Awaited<ReturnType<typeof loadCampaign>>["spec"],
): number {
  if (cohort === "holdout") {
    if (spec.cohorts.holdout === undefined) throw new Error("Campaign has no holdout cohort");
    return spec.cohorts.holdout.slots;
  }
  return spec.cohorts[cohort].pairedSlots;
}

async function reattestPriorScores(input: {
  spec: Awaited<ReturnType<typeof loadCampaign>>["spec"];
  paths: CampaignPaths;
  record: CandidateRecord;
  enteringCohort: CohortName;
  base: RevisionUnderTest;
  candidate: RevisionUnderTest;
  candidateSkillSnapshot?: Readonly<{ path: string; sha256: string }>;
}): Promise<Partial<Record<CohortName, ScoreSummary>>> {
  const priorScores: Partial<Record<CohortName, ScoreSummary>> = {};
  for (const cohort of requiredPriorCohorts(input.enteringCohort)) {
    const persisted = input.record.scores[cohort];
    if (persisted === undefined) continue;
    const attempts = await reattestPairedCohort({
      spec: input.spec,
      paths: input.paths,
      candidateId: input.record.response.candidateId,
      cohort,
      base: input.base,
      candidate: input.candidate,
      ...(input.candidateSkillSnapshot === undefined
        ? {}
        : { candidateSkillSnapshot: input.candidateSkillSnapshot }),
    });
    const derived = scoreAttempts(attempts);
    if (JSON.stringify(derived) !== JSON.stringify(persisted)) {
      throw new Error(`Persisted ${cohort} score does not match re-attested attempt evidence`);
    }
    priorScores[cohort] = derived;
  }
  return priorScores;
}

const SCORE_COHORT_ORDER = ["targeted", "smoke", "broad", "holdout"] as const;

function requiredPriorCohorts(cohort: CohortName): readonly CohortName[] {
  const index = SCORE_COHORT_ORDER.indexOf(cohort);
  if (index < 0) throw new Error(`Unknown cohort: ${cohort}`);
  return SCORE_COHORT_ORDER.slice(0, index);
}

function assertExactPriorScores(record: CandidateRecord, enteringCohort: CohortName): void {
  const expected = requiredPriorCohorts(enteringCohort);
  const actual = SCORE_COHORT_ORDER.filter((cohort) => record.scores[cohort] !== undefined);
  if (
    actual.length !== expected.length
    || actual.some((cohort, index) => cohort !== expected[index])
  ) {
    throw new Error(
      `${enteringCohort} evaluation requires exactly the prior score prefix: ${expected.join(", ") || "none"}`,
    );
  }
}

function storedScoreCohorts(record: CandidateRecord): CohortName[] {
  const cohorts = SCORE_COHORT_ORDER.filter((cohort) => record.scores[cohort] !== undefined);
  if (cohorts.some((cohort, index) => cohort !== SCORE_COHORT_ORDER[index])) {
    throw new Error(`Candidate ${record.response.candidateId} scores are not a contiguous evaluation prefix`);
  }
  const allowedStatuses: Record<number, readonly CandidateRecord["status"][]> = {
    0: ["ingested", "rejected"],
    1: ["survives-targeted", "rejected", "inconclusive"],
    2: ["survives-targeted", "rejected", "inconclusive"],
    3: ["survives-broad", "rejected", "inconclusive"],
    4: ["recommend-promote", "rejected", "inconclusive"],
  };
  if (!allowedStatuses[cohorts.length]!.includes(record.status)) {
    throw new Error(`Candidate ${record.response.candidateId} status does not match its evaluation evidence`);
  }
  if (cohorts.length > 0 && !hasRequiredCandidateChecks(record.verifiedTests)) {
    throw new Error(`Candidate ${record.response.candidateId} has scores without exact verified checks`);
  }
  return cohorts;
}

function candidateReviewWarnings(validation: CandidateValidation): string[] {
  return validation.existingTestFilesChanged.length === 0
    ? []
    : [`Existing test files changed; human review required: ${validation.existingTestFilesChanged.join(", ")}`.slice(0, 1_000)];
}

async function assertCandidateRecordMetadata(
  paths: CampaignPaths,
  record: CandidateRecord,
  validation: CandidateValidation,
): Promise<void> {
  const candidateId = record.response.candidateId;
  const rawResponse = await readJsonFile(join(paths.candidates, `${candidateId}.json`));
  if (rawResponse === undefined) {
    throw new Error(`Candidate ${candidateId} is missing its durable response`);
  }
  const durableResponse = candidateResponseSchema.parse(rawResponse);
  if (JSON.stringify(durableResponse) !== JSON.stringify(record.response)) {
    throw new Error(`Candidate ${candidateId} response does not match its durable provenance`);
  }
  const metadataMatches = (
    validation.changedProductionLines === record.changedProductionLines
    && validation.productionLineDelta === record.productionLineDelta
    && JSON.stringify(validation.changedTestFiles) === JSON.stringify(record.changedTestFiles)
    && JSON.stringify(validation.existingTestFilesChanged) === JSON.stringify(record.existingTestFilesChanged)
    && JSON.stringify(candidateReviewWarnings(validation)) === JSON.stringify(record.reviewWarnings)
  );
  if (!metadataMatches) {
    throw new Error(`Candidate ${candidateId} metadata does not match its revalidated commit`);
  }
}

async function reattestRoutingEvidence(input: {
  repositoryRoot: string;
  spec: Awaited<ReturnType<typeof loadCampaign>>["spec"];
  state: CampaignState;
  paths: CampaignPaths;
  gitRunner: GitRunner;
}): Promise<void> {
  const entries = Object.entries(input.state.candidates);
  const hasPromotionRecommendation = entries.some(([, record]) => record.status === "recommend-promote");
  if (input.state.phase === "stopped" && !hasPromotionRecommendation) {
    if (input.state.stopReason === "winner is ready for human promotion review") {
      throw new Error("Stopped campaign claims a promotion without a recommended candidate");
    }
    return;
  }
  const scoreCohorts = new Map(entries.map(([candidateId, record]) => (
    [candidateId, storedScoreCohorts(record)] as const
  )));
  for (const [candidateId, record] of entries) {
    const cohorts = scoreCohorts.get(candidateId)!;
    if (cohorts.length === 0) continue;
    const worktreePath = join(input.paths.worktrees, "candidates", candidateId);
    const validation = await validateCandidateWorktree({
      repositoryRoot: input.repositoryRoot,
      campaignId: input.spec.id,
      baseCommit: input.spec.baseCommit,
      frozenSuitePath: input.spec.suite.path,
      response: { ...record.response, worktreePath },
      runner: input.gitRunner,
    });
    await assertCandidateRecordMetadata(input.paths, record, validation);
    const changesSkills = record.response.changedFiles.some((path) => (
      path === "skills" || path.startsWith("skills/")
    ));
    const candidateSkillSnapshot = changesSkills
      ? { path: join(worktreePath, "skills"), sha256: await sha256Path(join(worktreePath, "skills")) }
      : undefined;
    const priorScores: Partial<Record<CohortName, ScoreSummary>> = {};
    let derivedDecision: ReturnType<typeof decideGate> | undefined;
    for (const cohort of cohorts) {
      let attempts: Attempt[];
      try {
        attempts = await reattestPairedCohort({
          spec: input.spec,
          paths: input.paths,
          candidateId,
          cohort,
          base: baseRevision(input.paths, input.spec.baseCommit),
          candidate: candidateRevision(record, worktreePath),
          ...(candidateSkillSnapshot === undefined ? {} : { candidateSkillSnapshot }),
        });
      } catch (error) {
        if (cohort === "holdout") {
          throw new Error("Sealed holdout evidence failed re-attestation; inspect local campaign state");
        }
        throw error;
      }
      const score = scoreAttempts(attempts);
      if (JSON.stringify(score) !== JSON.stringify(record.scores[cohort])) {
        throw new Error(`Candidate ${candidateId} ${cohort} score does not match re-attested evidence`);
      }
      const decision = decideGate({
        cohort,
        score,
        expectedPairedSlots: expectedSlots(cohort, input.spec),
        spec: input.spec,
        hardValidityReasons: [...record.rejectionReasons, ...policyValidityReasons(attempts)],
        documentedSimplification: isDocumentedSimplification(record),
        priorScores,
      });
      priorScores[cohort] = score;
      derivedDecision = decision;
    }
    if (
      derivedDecision?.status !== record.status
      || JSON.stringify(derivedDecision.reasons) !== JSON.stringify(record.gateReasons)
    ) {
      throw new Error(`Candidate ${candidateId} status does not match re-attested gate evidence`);
    }
  }
}

function baseRevision(paths: CampaignPaths, baseCommit: string): RevisionUnderTest {
  return { commit: baseCommit, worktreePath: join(paths.worktrees, "base") };
}

function candidateRevision(record: CandidateRecord, worktreePath: string): RevisionUnderTest {
  return {
    commit: record.response.candidateCommit,
    worktreePath,
  };
}

function candidateRecord(
  response: CandidateResponse,
  patch: Partial<Omit<CandidateRecord, "response">> = {},
): CandidateRecord {
  return {
    response,
    status: "rejected",
    changedProductionLines: 0,
    productionLineDelta: 0,
    changedTestFiles: [],
    existingTestFilesChanged: [],
    verifiedTests: [],
    rejectionReasons: ["candidate verification did not complete"],
    gateReasons: [],
    reviewWarnings: [],
    scores: {},
    ...patch,
  };
}

async function runVerification(
  runner: CommandRunner,
  pnpmCommand: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  script: "install" | "check" | "optimize:test",
  timeoutMs: number,
): Promise<CommandResult> {
  const args = script === "install"
    ? ["install", "--frozen-lockfile"]
    : [script];
  const started = performance.now();
  try {
    return await runner({
      command: pnpmCommand,
      args,
      cwd,
      env,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof SystemdSandboxUnsupportedError) throw error;
    return {
      code: null,
      signal: null,
      stdout: "",
      stderr: String(error),
      timedOut: false,
      wallMs: Math.max(0, performance.now() - started),
    };
  }
}

function verificationFailure(script: string, result: CommandResult): string | undefined {
  const command = script === "install" ? "pnpm install --frozen-lockfile" : `pnpm ${script}`;
  if (result.timedOut) return `${command} timed out`;
  if (result.code !== 0) return `${command} failed with exit code ${String(result.code)}`;
  return undefined;
}

async function ingestCandidate(input: {
  repositoryRoot: string;
  optimizerRoot: string;
  campaignId: string;
  responsePath: string;
  gitRunner: GitRunner;
  commandRunner: CommandRunner;
  pnpmCommand: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}): Promise<{ state: CampaignState; record: CandidateRecord }> {
  const campaign = await loadCampaign(input.optimizerRoot, input.campaignId);
  if (campaign.state.phase === "stopped") {
    throw new Error(`Campaign is stopped: ${redactSecrets(campaign.state.stopReason ?? "no reason recorded")}`);
  }
  await verifyFrozenInputs(campaign.spec);
  const responseFile = resolve(input.responsePath);
  const raw = JSON.parse(await readFile(responseFile, "utf8")) as unknown;
  const response = candidateResponseSchema.parse(raw);
  if (containsSecrets(JSON.stringify(response))) {
    throw new Error("Candidate response contains a secret-looking value");
  }
  if (response.candidateId === BASELINE_ID) {
    throw new Error(`Candidate id ${BASELINE_ID} is reserved for no-op calibration`);
  }
  const pending = campaign.state.pendingPacket;
  if (response.campaignId !== campaign.spec.id) {
    throw new Error("Candidate response belongs to another campaign");
  }
  if (response.baseCommit !== campaign.spec.baseCommit) {
    throw new Error("Candidate response has the wrong base commit");
  }
  const existing = campaign.state.candidates[response.candidateId];
  const inFlight = campaign.state.inFlight;
  if (inFlight !== undefined && (
    inFlight.kind !== "verification"
    || inFlight.candidateId !== response.candidateId
    || inFlight.commit !== response.candidateCommit
  )) {
    throw new Error("Campaign has unrelated in-flight work and cannot ingest this candidate");
  }
  const resumable = pending === undefined
    && existing !== undefined
    && JSON.stringify(existing.response) === JSON.stringify(response)
    && existing.verifiedTests.length <= 2
    && (
      existing.rejectionReasons.length === 1
        && existing.rejectionReasons[0] === "candidate verification did not complete"
      || campaign.state.inFlight?.kind === "verification"
    );

  let accepted: { response: CandidateResponse; state: CampaignState; responsePath: string };
  if (resumable) {
    let resumedState = campaign.state;
    const operation = resumedState.inFlight;
    if (operation !== undefined) {
      if (
        operation.kind !== "verification"
        || operation.candidateId !== response.candidateId
        || operation.commit !== response.candidateCommit
      ) {
        throw new Error("Campaign has unrelated in-flight work and cannot resume candidate verification");
      }
      const recoveredAt = input.now();
      const elapsed = Math.max(0, recoveredAt.getTime() - new Date(operation.startedAt).getTime());
      resumedState = {
        ...resumedState,
        inFlight: undefined,
        wallClockMsUsed: resumedState.wallClockMsUsed + elapsed,
        verificationWallClockMsUsed: resumedState.verificationWallClockMsUsed + elapsed,
        updatedAt: recoveredAt.toISOString(),
      };
    }
    accepted = { response, state: resumedState, responsePath: responseFile };
  } else {
    if (pending === undefined) throw new Error("There is no unanswered packet or resumable verification");
    if (response.requestId !== pending.requestId) {
      throw new Error("Candidate response is stale or altered");
    }
    await loadCampaignPendingPacket(campaign.spec, campaign.state, campaign.paths, {
      action: "propose-candidate",
    });
    accepted = await acceptPacketResponse(
      campaign.spec,
      campaign.state,
      campaign.paths,
      response,
      input.now,
    );
  }

  let record = resumable ? existing! : candidateRecord(accepted.response);
  let validation;
  let evaluationWorktree;
  let fatalValidationReason: string | undefined;
  try {
    validation = await validateCandidateWorktree({
      repositoryRoot: input.repositoryRoot,
      campaignId: campaign.spec.id,
      baseCommit: campaign.spec.baseCommit,
      frozenSuitePath: campaign.spec.suite.path,
      response: accepted.response,
      runner: input.gitRunner,
    });
    const warnings = candidateReviewWarnings(validation);
    record = resumable ? {
      ...record,
      changedProductionLines: validation.changedProductionLines,
      productionLineDelta: validation.productionLineDelta,
      changedTestFiles: validation.changedTestFiles,
      existingTestFilesChanged: validation.existingTestFilesChanged,
      reviewWarnings: warnings,
    } : candidateRecord(accepted.response, {
      changedProductionLines: validation.changedProductionLines,
      productionLineDelta: validation.productionLineDelta,
      changedTestFiles: validation.changedTestFiles,
      existingTestFilesChanged: validation.existingTestFilesChanged,
      reviewWarnings: warnings,
    });
    evaluationWorktree = await createDetachedCandidateWorktree({
      repositoryRoot: input.repositoryRoot,
      paths: campaign.paths,
      candidateId: response.candidateId,
      candidateCommit: response.candidateCommit,
      runner: input.gitRunner,
      now: input.now,
    });
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
    if (/Candidate changes protected paths/u.test(message)) {
      fatalValidationReason = "candidate changed a protected campaign or evaluator input";
    } else if (message.includes(campaign.paths.worktrees)) {
      fatalValidationReason = "controller-owned candidate worktree provenance changed";
    }
    record = candidateRecord(accepted.response, {
      rejectionReasons: [message],
    });
  }

  let state: CampaignState = {
    ...accepted.state,
    phase: fatalValidationReason === undefined ? "candidate-ingested" : "stopped",
    ...(fatalValidationReason === undefined ? {} : { stopReason: fatalValidationReason }),
    activeCandidateId: response.candidateId,
    candidatesUsed: accepted.state.candidatesUsed + (resumable ? 0 : 1),
    candidates: { ...accepted.state.candidates, [response.candidateId]: record },
    updatedAt: nowIso(input.now),
  };
  await saveCandidateResponse(campaign.paths, response);
  await saveCampaignState(campaign.paths, state);

  if (validation === undefined || evaluationWorktree === undefined) return { state, record };

  const verificationHome = await mkdtemp(join(campaign.paths.root, "offline-home-"));
  const verificationEnv = offlineVerificationEnvironment(input.env, verificationHome);
  const failures: string[] = [];
  try {
    for (const script of ["install", "check", "optimize:test"] as const) {
      if (script !== "install" && record.verifiedTests.includes(`pnpm ${script}`)) continue;
      const remainingWallMs = campaign.spec.budget.maxWallClockMs - state.wallClockMsUsed;
      if (remainingWallMs <= 0) {
        failures.push(`campaign wall-clock budget exhausted before pnpm ${script}`);
        state = {
          ...state,
          phase: "stopped",
          stopReason: failures.at(-1),
          updatedAt: nowIso(input.now),
        };
        break;
      }
      state = {
        ...state,
        inFlight: {
          kind: "verification",
          commit: response.candidateCommit,
          startedAt: nowIso(input.now),
          candidateId: response.candidateId,
          verificationScript: script,
        },
        updatedAt: nowIso(input.now),
      };
      await saveCampaignState(campaign.paths, state);
      let result: CommandResult;
      const verificationStarted = performance.now();
      try {
        result = await runVerification(
          input.commandRunner,
          input.pnpmCommand,
          evaluationWorktree.path,
          verificationEnv,
          script,
          Math.max(1, Math.min(CHECK_TIMEOUT_MS, remainingWallMs)),
        );
      } catch (error) {
        const elapsed = Math.max(0, performance.now() - verificationStarted);
        const reason = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1_000);
        record = { ...record, status: "rejected", rejectionReasons: [reason] };
        state = {
          ...state,
          phase: "stopped",
          stopReason: reason,
          inFlight: undefined,
          wallClockMsUsed: state.wallClockMsUsed + elapsed,
          verificationWallClockMsUsed: state.verificationWallClockMsUsed + elapsed,
          candidates: { ...state.candidates, [response.candidateId]: record },
          updatedAt: nowIso(input.now),
        };
        await saveCampaignState(campaign.paths, state);
        throw error;
      }

      let provenanceFailure: string | undefined;
      try {
        const currentValidation = await validateCandidateWorktree({
          repositoryRoot: input.repositoryRoot,
          campaignId: campaign.spec.id,
          baseCommit: campaign.spec.baseCommit,
          frozenSuitePath: campaign.spec.suite.path,
          response: { ...response, worktreePath: evaluationWorktree.path },
          runner: input.gitRunner,
        });
        await assertCandidateRecordMetadata(campaign.paths, record, currentValidation);
      } catch (error) {
        const detail = redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 900);
        provenanceFailure = `candidate provenance changed during pnpm ${script}: ${detail}`;
        failures.push(provenanceFailure);
      }

      const failure = verificationFailure(script, result);
      if (failure !== undefined) failures.push(failure);
      else if (script !== "install" && provenanceFailure === undefined) {
        record = { ...record, verifiedTests: [...record.verifiedTests, `pnpm ${script}`] };
      }
      record = {
        ...record,
        rejectionReasons: failures.length === 0 ? ["candidate verification did not complete"] : failures,
      };
      state = {
        ...state,
        ...(provenanceFailure === undefined ? {} : {
          phase: "stopped" as const,
          stopReason: provenanceFailure,
        }),
        inFlight: undefined,
        wallClockMsUsed: state.wallClockMsUsed + result.wallMs,
        verificationWallClockMsUsed: state.verificationWallClockMsUsed + result.wallMs,
        candidates: { ...state.candidates, [response.candidateId]: record },
        updatedAt: nowIso(input.now),
      };
      if (state.wallClockMsUsed >= campaign.spec.budget.maxWallClockMs) {
        failures.push(`campaign wall-clock budget exhausted during pnpm ${script}`);
        record = { ...record, rejectionReasons: failures };
        state = {
          ...state,
          phase: "stopped",
          stopReason: provenanceFailure ?? failures.at(-1),
          candidates: { ...state.candidates, [response.candidateId]: record },
          updatedAt: nowIso(input.now),
        };
      }
      await saveCampaignState(campaign.paths, state);
      if (script === "install" && failure !== undefined) break;
      if (state.phase === "stopped") break;
    }
  } finally {
    await removeVerificationHome(campaign.paths.root, verificationHome);
  }

  record = {
    ...record,
    status: failures.length === 0 ? "ingested" : "rejected",
    rejectionReasons: failures,
  };
  state = {
    ...state,
    candidates: { ...state.candidates, [response.candidateId]: record },
    updatedAt: nowIso(input.now),
  };
  await saveCampaignState(campaign.paths, state);
  return { state, record };
}

function expectedPacketAction(cohort: CohortName): NextActionPacket["action"] {
  if (cohort === "holdout") return "run-holdout";
  if (cohort === "targeted") return "evaluate-targeted";
  if (cohort === "smoke") return "evaluate-smoke";
  return "evaluate-broad";
}

async function validatePendingControllerAction(
  spec: Awaited<ReturnType<typeof loadCampaign>>["spec"],
  paths: CampaignPaths,
  state: CampaignState,
  action: NextActionPacket["action"],
  candidateId: string,
): Promise<NextActionPacket> {
  if (state.pendingPacket === undefined) throw new Error(`No pending ${action} controller packet`);
  if (state.activeCandidateId !== candidateId) {
    throw new Error(`Campaign routed ${action} to ${state.activeCandidateId ?? "no candidate"}, not ${candidateId}`);
  }
  const record = state.candidates[candidateId];
  if (record === undefined) throw new Error(`Unknown candidate: ${candidateId}`);
  return loadCampaignPendingPacket(spec, state, paths, { action, candidateId });
}

async function acknowledgeControllerAction(
  paths: CampaignPaths,
  state: CampaignState,
  packet: NextActionPacket | undefined,
  now: () => Date,
): Promise<CampaignState> {
  if (packet === undefined) return state;
  const responsePath = join(
    paths.packets,
    `${String(packet.sequence).padStart(4, "0")}-response.json`,
  );
  const existing = await readJsonFile(responsePath);
  if (existing === undefined) {
    await atomicWriteJson(responsePath, controllerResponseSchema.parse({
      version: 1,
      campaignId: packet.campaignId,
      requestId: packet.requestId,
      completedAction: packet.action,
      completedAt: nowIso(now),
    }));
  } else {
    const response = controllerResponseSchema.parse(existing);
    if (
      response.campaignId !== packet.campaignId
      || response.requestId !== packet.requestId
      || response.completedAction !== packet.action
    ) {
      throw new Error("Existing controller response does not match the pending action");
    }
  }
  return { ...state, pendingPacket: undefined, updatedAt: nowIso(now) };
}

function assertStageOrder(record: CandidateRecord, cohort: CohortName): void {
  if (record.rejectionReasons.length > 0 || record.status === "rejected") {
    throw new Error(`Candidate ${record.response.candidateId} has a hard-validity rejection`);
  }
  if (!hasRequiredCandidateChecks(record.verifiedTests)) {
    throw new Error("Candidate checks are not independently verified");
  }
  if (record.scores[cohort] !== undefined) {
    throw new Error(`Candidate ${record.response.candidateId} already has a ${cohort} result`);
  }
  assertExactPriorScores(record, cohort);
  if (cohort === "targeted") {
    if (record.status !== "ingested") throw new Error("Targeted evaluation requires an ingested candidate");
    return;
  }
  if (cohort === "holdout") {
    if (record.scores.broad === undefined || record.status !== "survives-broad") {
      throw new Error("Holdout requires a frozen candidate that survives broad evaluation");
    }
    return;
  }
  if (record.scores.targeted === undefined || record.status !== "survives-targeted") {
    throw new Error(`${cohort} evaluation requires a candidate that survives targeted evaluation`);
  }
  if (cohort === "broad" && record.scores.smoke === undefined) {
    throw new Error("Broad evaluation requires a completed smoke result");
  }
}

function assertLiveCredentials(
  provider: "openai" | "anthropic" | "zai",
  env: NodeJS.ProcessEnv,
): void {
  const missing = [
    ...(env.STEEL_API_KEY ? [] : ["STEEL_API_KEY"]),
    ...(!env.ANTHROPIC_API_KEY ? ["ANTHROPIC_API_KEY (blind judge)"] : []),
    ...(provider === "openai" && !env.OPENAI_API_KEY ? ["OPENAI_API_KEY"] : []),
    ...(provider === "zai" && !env.ZAI_API_KEY ? ["ZAI_API_KEY"] : []),
  ];
  if (missing.length > 0) {
    throw new Error(`Missing required live credentials: ${missing.join(", ")}`);
  }
}

async function evaluateCandidate(input: {
  repositoryRoot: string;
  optimizerRoot: string;
  campaignId: string;
  candidateId: string;
  cohort: CohortName;
  gitRunner: GitRunner;
  compareRunner?: ChildRunner;
  pnpmCommand: string;
  env: NodeJS.ProcessEnv;
  now: () => Date;
}): Promise<{ state: CampaignState; score: ScoreSummary; status: CandidateRecord["status"] }> {
  const campaign = await loadCampaign(input.optimizerRoot, input.campaignId);
  if (campaign.state.phase === "stopped") {
    throw new Error(`Campaign is stopped: ${campaign.state.stopReason ?? "no reason recorded"}`);
  }
  const record = campaign.state.candidates[input.candidateId];
  if (record === undefined) throw new Error(`Unknown candidate: ${input.candidateId}`);
  assertStageOrder(record, input.cohort);
  const packet = await validatePendingControllerAction(
    campaign.spec,
    campaign.paths,
    campaign.state,
    expectedPacketAction(input.cohort),
    input.candidateId,
  );

  const evaluationBase = await createDetachedBaseWorktree({
    repositoryRoot: input.repositoryRoot,
    paths: campaign.paths,
    baseCommit: campaign.spec.baseCommit,
    runner: input.gitRunner,
    now: input.now,
  });

  let evaluationCandidate: Awaited<ReturnType<typeof createDetachedCandidateWorktree>>;
  let candidateSkillSnapshot: Readonly<{ path: string; sha256: string }> | undefined;
  try {
    evaluationCandidate = await createDetachedCandidateWorktree({
      repositoryRoot: input.repositoryRoot,
      paths: campaign.paths,
      candidateId: input.candidateId,
      candidateCommit: record.response.candidateCommit,
      runner: input.gitRunner,
      now: input.now,
    });
    const validation = await validateCandidateWorktree({
      repositoryRoot: input.repositoryRoot,
      campaignId: campaign.spec.id,
      baseCommit: campaign.spec.baseCommit,
      frozenSuitePath: campaign.spec.suite.path,
      response: { ...record.response, worktreePath: evaluationCandidate.path },
      runner: input.gitRunner,
    });
    await assertCandidateRecordMetadata(campaign.paths, record, validation);
    const changesSkills = record.response.changedFiles.some((path) => (
      path === "skills" || path.startsWith("skills/")
    ));
    if (changesSkills) {
      const baseSkillPath = join(evaluationBase.path, "skills");
      const baseSkillHash = await sha256Path(baseSkillPath);
      if (baseSkillHash !== campaign.spec.skillSnapshot.sha256) {
        throw new Error(
          "A skill candidate requires the frozen skill snapshot to match the base revision's skills directory",
        );
      }
      const candidateSkillPath = join(evaluationCandidate.path, "skills");
      candidateSkillSnapshot = {
        path: candidateSkillPath,
        sha256: await sha256Path(candidateSkillPath),
      };
    }
  } catch (error) {
    const rejected: CandidateRecord = {
      ...record,
      status: "rejected",
      rejectionReasons: [redactSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1_000)],
    };
    let state: CampaignState = {
      ...campaign.state,
      candidates: { ...campaign.state.candidates, [input.candidateId]: rejected },
      updatedAt: nowIso(input.now),
    };
    state = await acknowledgeControllerAction(campaign.paths, state, packet, input.now);
    await saveCampaignState(campaign.paths, state);
    throw new Error(`Candidate provenance changed before evaluation: ${rejected.rejectionReasons[0]}`);
  }
  if (input.compareRunner === undefined) assertLiveCredentials(campaign.spec.wire.provider, input.env);
  // For holdout this is intentionally after stage-order and commit
  // revalidation: no sealed input is opened before the candidate is frozen.
  const baseUnderTest = baseRevision(campaign.paths, campaign.spec.baseCommit);
  const candidateUnderTest = candidateRevision(record, evaluationCandidate.path);
  let priorScores: Partial<Record<CohortName, ScoreSummary>>;
  try {
    priorScores = await reattestPriorScores({
      spec: campaign.spec,
      paths: campaign.paths,
      record,
      enteringCohort: input.cohort,
      base: baseUnderTest,
      candidate: candidateUnderTest,
      ...(candidateSkillSnapshot === undefined ? {} : { candidateSkillSnapshot }),
    });
  } catch (error) {
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      phase: "stopped",
      stopReason: "persisted prior evaluation evidence failed re-attestation",
      updatedAt: nowIso(input.now),
    });
    throw error;
  }

  await verifyFrozenInputs(campaign.spec, input.cohort === "holdout");

  const evaluated = await evaluatePaired({
    spec: campaign.spec,
    state: campaign.state,
    paths: campaign.paths,
    candidateId: input.candidateId,
    cohort: input.cohort,
    base: baseUnderTest,
    candidate: candidateUnderTest,
    ...(candidateSkillSnapshot === undefined ? {} : { candidateSkillSnapshot }),
    ...(input.compareRunner === undefined ? {} : { runner: input.compareRunner }),
    env: input.env,
    now: input.now,
    pnpmCommand: input.pnpmCommand,
  });
  const selectedAttempts = attemptsFor(evaluated.attempts, input.candidateId, input.cohort);
  await persistAutopsies(
    campaign.paths,
    campaign.spec.id,
    selectedAttempts,
    input.cohort === "holdout",
    input.now,
  );
  const score = scoreAttempts(selectedAttempts);
  const decision = evaluated.stopped
    ? {
        status: "inconclusive" as const,
        reasons: ["evaluation stage stopped before accepting complete trusted evidence"],
      }
    : decideGate({
        cohort: input.cohort,
        score,
        expectedPairedSlots: expectedSlots(input.cohort, campaign.spec),
        spec: campaign.spec,
        hardValidityReasons: [...record.rejectionReasons, ...policyValidityReasons(selectedAttempts)],
        documentedSimplification: isDocumentedSimplification(record),
        priorScores,
      });
  const nextRecord: CandidateRecord = {
    ...record,
    status: decision.status,
    gateReasons: decision.reasons,
    scores: { ...record.scores, [input.cohort]: score },
  };
  let state: CampaignState = {
    ...evaluated.state,
    phase: evaluated.state.phase === "stopped" ? "stopped" : "candidate-ingested",
    ...(input.cohort === "holdout" && evaluated.state.phase === "stopped"
      ? { stopReason: "Sealed holdout stage stopped; inspect local campaign attempts" }
      : {}),
    activeCandidateId: input.candidateId,
    candidates: { ...evaluated.state.candidates, [input.candidateId]: nextRecord },
    updatedAt: nowIso(input.now),
  };
  state = await acknowledgeControllerAction(campaign.paths, state, packet, input.now);
  await saveCampaignState(campaign.paths, state);
  return { state, score, status: decision.status };
}

function statusView(state: CampaignState): Record<string, unknown> {
  const inFlight = state.inFlight === undefined ? null : {
    kind: state.inFlight.kind,
    commit: state.inFlight.commit,
    startedAt: state.inFlight.startedAt,
    ...(state.inFlight.slotId === undefined ? {} : { slotId: state.inFlight.slotId }),
    ...(state.inFlight.arm === undefined ? {} : { arm: state.inFlight.arm }),
    ...(state.inFlight.candidateId === undefined ? {} : { candidateId: state.inFlight.candidateId }),
    ...(state.inFlight.verificationScript === undefined
      ? {}
      : { verificationScript: state.inFlight.verificationScript }),
  };
  return {
    version: state.version,
    campaignId: state.campaignId,
    baseCommit: state.baseCommit,
    phase: state.phase,
    physicalRunsUsed: state.physicalRunsUsed,
    wallClockMsUsed: state.wallClockMsUsed,
    buildWallClockMsUsed: state.buildWallClockMsUsed,
    verificationWallClockMsUsed: state.verificationWallClockMsUsed,
    candidatesUsed: state.candidatesUsed,
    completedSlots: state.completedSlots.length,
    packetSequence: state.packetSequence,
    pendingRequestId: state.pendingPacket?.requestId ?? null,
    activeCandidateId: state.activeCandidateId ?? null,
    inFlight,
    candidates: Object.fromEntries(Object.entries(state.candidates).map(([id, record]) => [id, {
      status: record.status,
      candidateCommit: record.response.candidateCommit,
      verifiedTests: record.verifiedTests,
      rejectionReasons: record.rejectionReasons,
      gateReasons: record.gateReasons,
      reviewWarnings: record.reviewWarnings,
      scores: record.scores,
    }])),
    stopReason: state.stopReason === undefined ? null : redactSecrets(state.stopReason),
  };
}

async function runCliUnlocked(
  args: readonly string[],
  context: CliContext = {},
  preparedInitialization?: PreparedInitialization,
): Promise<number> {
  const command = parseArguments(args);
  const repositoryRoot = resolve(context.repositoryRoot ?? process.cwd());
  const optimizerRoot = resolve(context.optimizerRoot ?? defaultOptimizerRoot(repositoryRoot));
  const env = context.env ?? process.env;
  const now = context.now ?? (() => new Date());
  const gitRunner = context.gitRunner ?? spawnGit;
  const commandRunner = context.commandRunner
    ?? createSystemdCommandRunner(context.systemdSandboxRunner ?? runSystemdSandbox);
  const needsPnpm = ["ingest", "baseline", "evaluate", "holdout"].includes(command.command);
  const requestedPnpm = context.pnpmCommand ?? "pnpm";
  const pnpmCommand = needsPnpm && context.commandRunner === undefined
    ? await resolveExecutable(requestedPnpm, env)
    : requestedPnpm;
  const write = context.write ?? ((text: string) => process.stdout.write(text));

  if (command.command === "init") {
    const recipePath = resolve(value(command, "campaign"));
    if (preparedInitialization !== undefined && preparedInitialization.recipePath !== recipePath) {
      throw new Error("Prepared campaign recipe path does not match the init command");
    }
    const baseCommit = await resolveCleanBase(repositoryRoot, value(command, "base"), gitRunner);
    const initialized = await initializeCampaign({
      optimizerRoot,
      recipePath,
      ...(preparedInitialization === undefined ? {} : { recipe: preparedInitialization.recipe }),
      baseCommit,
      now,
    });
    const base = await createDetachedBaseWorktree({
      repositoryRoot,
      paths: initialized.paths,
      baseCommit,
      runner: gitRunner,
      now,
    });
    printJson(write, {
      campaignId: initialized.spec.id,
      baseCommit,
      baseWorktree: base.path,
      reopened: initialized.reopened,
    });
    return 0;
  }

  const campaignId = value(command, "campaign");
  if (command.command === "status") {
    const { state } = await loadCampaign(optimizerRoot, campaignId);
    const view = statusView(state);
    if (command.values.json === true) printJson(write, view);
    else {
      const operation = state.inFlight === undefined ? "" : `; in-flight ${state.inFlight.kind}`;
      const reason = state.stopReason === undefined ? "" : `; stop: ${redactSecrets(state.stopReason)}`;
      write(`Campaign ${state.campaignId}: ${state.phase}; ${state.physicalRunsUsed} physical runs; ${state.candidatesUsed} candidates${operation}${reason}\n`);
    }
    return 0;
  }

  if (command.command === "next") {
    const campaign = await loadCampaign(optimizerRoot, campaignId);
    if (campaign.state.phase !== "stopped") await verifyFrozenInputs(campaign.spec);
    try {
      await reattestRoutingEvidence({
        repositoryRoot,
        spec: campaign.spec,
        state: campaign.state,
        paths: campaign.paths,
        gitRunner,
      });
    } catch (error) {
      await saveCampaignState(campaign.paths, {
        ...campaign.state,
        phase: "stopped",
        stopReason: "campaign routing evidence failed re-attestation",
        updatedAt: nowIso(now),
      });
      throw error;
    }
    const next = await writeNextAction(campaign.spec, campaign.state, campaign.paths, now);
    printJson(write, {
      path: next.state.pendingPacket?.path ?? next.packet.candidateContract.responsePath,
      requestId: next.packet.requestId,
      action: next.packet.action,
      written: next.written,
    });
    return 0;
  }

  if (command.command === "ingest") {
    const result = await ingestCandidate({
      repositoryRoot,
      optimizerRoot,
      campaignId,
      responsePath: value(command, "response"),
      gitRunner,
      commandRunner,
      pnpmCommand,
      env,
      now,
    });
    const campaign = await loadCampaign(optimizerRoot, campaignId);
    const next = await writeNextAction(campaign.spec, result.state, campaign.paths, now);
    printJson(write, {
      candidateId: result.record.response.candidateId,
      status: result.record.status,
      verifiedTests: result.record.verifiedTests,
      rejectionReasons: result.record.rejectionReasons,
      reviewWarnings: result.record.reviewWarnings,
      nextAction: next.packet.action,
      packetPath: next.state.pendingPacket?.path ?? null,
    });
    return result.record.status === "rejected" ? 1 : 0;
  }

  if (command.command === "baseline") {
    const campaign = await loadCampaign(optimizerRoot, campaignId);
    if (campaign.state.phase === "stopped") {
      throw new Error(`Campaign is stopped: ${campaign.state.stopReason ?? "no reason recorded"}`);
    }
    const persistedAttempts = await listAttempts(campaign.paths);
    const freshBaseline = (
      campaign.state.phase !== "initialized"
      ? false
      : campaign.state.pendingPacket === undefined
        && campaign.state.inFlight === undefined
        && campaign.state.physicalRunsUsed === 0
        && campaign.state.completedSlots.length === 0
        && persistedAttempts.length === 0
    );
    const baselineSlotIds = new Set(persistedAttempts.map((attempt) => attempt.slotId));
    const resumableBaseline = (
      campaign.state.phase === "evaluating"
      && campaign.state.pendingPacket === undefined
      && campaign.state.candidatesUsed === 0
      && Object.keys(campaign.state.candidates).length === 0
      && campaign.state.activeCandidateId === undefined
      && campaign.state.broadCandidateIds === undefined
      && campaign.state.inFlight?.kind !== "verification"
      && persistedAttempts.every((attempt) => (
        attempt.candidateId === BASELINE_ID && attempt.cohort === "smoke"
      ))
      && campaign.state.completedSlots.every((slotId) => baselineSlotIds.has(slotId))
    );
    if (!freshBaseline && !resumableBaseline) {
      throw new Error("Baseline calibration requires a fresh initialized campaign with no pending or in-flight work");
    }
    await verifyFrozenInputs(campaign.spec);
    if (context.compareRunner === undefined) assertLiveCredentials(campaign.spec.wire.provider, env);
    await createDetachedBaseWorktree({
      repositoryRoot,
      paths: campaign.paths,
      baseCommit: campaign.spec.baseCommit,
      runner: gitRunner,
      now,
    });
    const base = baseRevision(campaign.paths, campaign.spec.baseCommit);
    const result = await evaluatePaired({
      spec: campaign.spec,
      state: campaign.state,
      paths: campaign.paths,
      candidateId: BASELINE_ID,
      cohort: "smoke",
      base,
      candidate: base,
      ...(context.compareRunner === undefined ? {} : { runner: context.compareRunner }),
      env,
      now,
      pnpmCommand,
    });
    const selected = attemptsFor(result.attempts, BASELINE_ID, "smoke");
    await persistAutopsies(campaign.paths, campaign.spec.id, selected, false, now);
    const score = scoreAttempts(selected);
    const state: CampaignState = {
      ...result.state,
      phase: result.state.phase === "stopped" ? "stopped" : "initialized",
      updatedAt: nowIso(now),
    };
    await saveCampaignState(campaign.paths, state);
    printJson(write, { calibration: "base-vs-base", score, stopped: result.stopped });
    return result.stopped ? 1 : 0;
  }

  if (command.command === "evaluate") {
    const cohort = value(command, "cohort");
    if (cohort !== "targeted" && cohort !== "smoke" && cohort !== "broad") {
      throw new Error("--cohort must be targeted, smoke, or broad");
    }
    const result = await evaluateCandidate({
      repositoryRoot,
      optimizerRoot,
      campaignId,
      candidateId: value(command, "candidate"),
      cohort,
      gitRunner,
      ...(context.compareRunner === undefined ? {} : { compareRunner: context.compareRunner }),
      pnpmCommand,
      env,
      now,
    });
    printJson(write, { candidateId: value(command, "candidate"), cohort, status: result.status, score: result.score });
    return result.state.phase === "stopped" ? 1 : 0;
  }

  if (command.command === "holdout") {
    const before = await loadCampaign(optimizerRoot, campaignId);
    if (before.state.phase === "stopped") {
      throw new Error(`Campaign is stopped: ${redactSecrets(before.state.stopReason ?? "no reason recorded")}`);
    }
    const candidateId = value(command, "candidate");
    const record = before.state.candidates[candidateId];
    if (record === undefined) throw new Error(`Unknown candidate: ${candidateId}`);
    assertStageOrder(record, "holdout");
    await validatePendingControllerAction(
      before.spec,
      before.paths,
      before.state,
      "run-holdout",
      candidateId,
    );
    if (context.compareRunner === undefined) assertLiveCredentials(before.spec.wire.provider, env);

    let result: Awaited<ReturnType<typeof evaluateCandidate>>;
    try {
      result = await evaluateCandidate({
        repositoryRoot,
        optimizerRoot,
        campaignId,
        candidateId,
        cohort: "holdout",
        gitRunner,
        ...(context.compareRunner === undefined ? {} : { compareRunner: context.compareRunner }),
        pnpmCommand,
        env,
        now,
      });
    } catch {
      const current = await loadCampaign(optimizerRoot, campaignId);
      const priorEvidenceFailed = current.state.stopReason
        === "persisted prior evaluation evidence failed re-attestation";
      await saveCampaignState(current.paths, {
        ...current.state,
        phase: "stopped",
        stopReason: priorEvidenceFailed
          ? "persisted prior evaluation evidence failed re-attestation"
          : "Sealed holdout stage stopped; inspect local campaign attempts",
        updatedAt: nowIso(now),
      });
      throw new Error(priorEvidenceFailed
        ? "Prior public-stage evidence failed re-attestation before sealed holdout access"
        : "Holdout stage could not complete; inspect sealed local campaign state");
    }
    // Deliberately aggregate-only: no sealed suite path, task id, prompt,
    // answer, trace, or autopsy pointer is emitted here.
    printJson(write, {
      candidateId,
      status: result.status,
      aggregate: {
        pairedSlots: result.score.pairedSlots,
        successDelta: result.score.successDelta,
        meanJudgeDelta: result.score.meanJudgeDelta,
        scorable: result.score.scorable,
      },
    });
    return result.state.phase === "stopped" ? 1 : 0;
  }

  const campaign = await loadCampaign(optimizerRoot, campaignId);
  if (campaign.state.phase !== "stopped" || campaign.state.inFlight !== undefined) {
    throw new Error("Cleanup requires a stopped campaign with no in-flight work");
  }
  const removed = await cleanupCampaignWorktrees({
    repositoryRoot,
    paths: campaign.paths,
    runner: gitRunner,
    now,
  });
  printJson(write, { campaignId, removed });
  return 0;
}

export async function runCli(args: readonly string[], context: CliContext = {}): Promise<number> {
  const command = parseArguments(args);
  if (command.command === "status") return runCliUnlocked(args, context);
  const repositoryRoot = resolve(context.repositoryRoot ?? process.cwd());
  const optimizerRoot = resolve(context.optimizerRoot ?? defaultOptimizerRoot(repositoryRoot));
  let preparedInitialization: PreparedInitialization | undefined;
  let campaignId: string;
  if (command.command === "init") {
    const recipePath = resolve(value(command, "campaign"));
    const recipe = parseCampaignRecipe(
      JSON.parse(await readFile(recipePath, "utf8")) as unknown,
    );
    preparedInitialization = { recipePath, recipe };
    campaignId = recipe.id;
  } else {
    campaignId = value(command, "campaign");
  }
  return withCampaignLock(
    optimizerRoot,
    campaignId,
    command.command,
    async () => {
      try {
        return await runCliUnlocked(args, context, preparedInitialization);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const stopReason = /Missing required live credentials/u.test(message)
          ? "required live credentials are missing"
          : /hash mismatch/u.test(message)
            ? "a frozen campaign input hash changed"
            : /Candidate provenance changed before evaluation:.*protected paths/u.test(message)
              ? "candidate changed a protected campaign or evaluator input"
              : /^Worktree is not clean:/u.test(message)
                ? "required campaign worktree provenance is not clean"
                : undefined;
        if (command.command !== "init" && stopReason !== undefined) {
          const campaign = await loadCampaign(optimizerRoot, campaignId);
          await saveCampaignState(campaign.paths, {
            ...campaign.state,
            phase: "stopped",
            stopReason,
            updatedAt: nowIso(context.now ?? (() => new Date())),
          });
        }
        throw error;
      }
    },
  );
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${redactSecrets(error instanceof Error ? error.message : String(error))}\n`);
    process.exitCode = 1;
  }
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  await main();
}
