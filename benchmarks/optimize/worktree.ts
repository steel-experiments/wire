import { spawn } from "node:child_process";
import {
  cp,
  lstat,
  mkdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve } from "node:path";
import { z } from "zod";

import { atomicWriteJson, ensureDir, readJsonFile } from "../../src/storage/atomic.js";
import {
  candidateResponseSchema,
  type CandidateResponse,
} from "./model.js";
import { buildSystemdSandboxInvocation } from "./sandbox.js";
import { sha256Path, type CampaignPaths } from "./state.js";

const fullCommitPattern = /^[a-f0-9]{40}$/u;
const safeSegmentPattern = /^[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9])?$/u;
const registryFilename = "created-worktrees.json";

const protectedPrefixes = [
  "benchmarks/compare/",
  "benchmarks/optimize/",
] as const;

const protectedExactPaths = new Set([
  "benchmarks/benchmark_tasks.json",
  "benchmarks/benchmark_tasks.schema.json",
  "package.json",
  "pnpm-lock.yaml",
  ".gitattributes",
  ".npmrc",
  ".pnpmfile.cjs",
  "pnpm-workspace.yaml",
  "pnpm-workspace.yml",
]);

const dependencyFilenames = new Set([
  "bun.lock",
  "bun.lockb",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);

export interface GitRequest {
  cwd: string;
  args: readonly string[];
}

export interface GitResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A deliberately narrow injection seam: Git is always spawned with an argument array. */
export type GitRunner = (request: GitRequest) => Promise<GitResult>;

export const spawnGit: GitRunner = ({ cwd, args }) => new Promise((resolveResult) => {
  const child = spawn("git", [...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let settled = false;

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  child.on("error", (error) => {
    if (settled) return;
    settled = true;
    resolveResult({ code: null, stdout, stderr: `${stderr}${String(error)}` });
  });
  child.on("close", (code) => {
    if (settled) return;
    settled = true;
    resolveResult({ code, stdout, stderr });
  });
});

const worktreeRecordSchema = z.strictObject({
  id: z.string().regex(safeSegmentPattern),
  kind: z.enum(["base", "candidate"]),
  repositoryRoot: z.string().refine(isAbsolute),
  path: z.string().refine(isAbsolute),
  commit: z.string().regex(fullCommitPattern),
  status: z.enum(["planned", "active", "removed"]),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const worktreeRegistrySchema = z.strictObject({
  version: z.literal(1),
  worktrees: z.array(worktreeRecordSchema),
});

export type CreatedWorktreeRecord = z.infer<typeof worktreeRecordSchema>;
type WorktreeRegistry = z.infer<typeof worktreeRegistrySchema>;

export interface CreateBaseWorktreeOptions {
  repositoryRoot: string;
  paths: Pick<CampaignPaths, "worktrees">;
  baseCommit: string;
  runner?: GitRunner;
  now?: () => Date;
}

export interface CreateCandidateWorktreeOptions {
  repositoryRoot: string;
  paths: Pick<CampaignPaths, "worktrees">;
  candidateId: string;
  candidateCommit: string;
  runner?: GitRunner;
  now?: () => Date;
}

export interface ValidateCandidateOptions {
  repositoryRoot: string;
  campaignId: string;
  baseCommit: string;
  frozenSuitePath: string;
  response: CandidateResponse;
  runner?: GitRunner;
}

export interface CandidateValidation {
  worktreePath: string;
  changedFiles: string[];
  changedProductionLines: number;
  productionLineDelta: number;
  changedTestFiles: string[];
  existingTestFilesChanged: string[];
}

export interface CleanupWorktreesOptions {
  repositoryRoot: string;
  paths: Pick<CampaignPaths, "worktrees">;
  runner?: GitRunner;
  now?: () => Date;
}

export interface PrepareAttemptIsolationOptions {
  paths: Pick<CampaignPaths, "traces" | "skills">;
  slotId: string;
  arm: "base" | "candidate";
  skillSnapshotPath: string;
  skillSnapshotHash: string;
}

export interface AttemptIsolation {
  wireRoot: string;
  skillRoot: string;
  skillSnapshotHash: string;
}

export interface HarnessEnvironmentOptions {
  isolation: AttemptIsolation;
  launcherDirectory: string;
  harnessHome: string;
  inheritedEnv?: NodeJS.ProcessEnv;
  allowedEnvironmentKeys?: readonly string[];
}

export interface CreateWireShimOptions {
  launcherDirectory: string;
  candidateEnvironment: Readonly<NodeJS.ProcessEnv>;
  forwardedEnvironmentKeys: readonly string[];
  timeoutMs: number;
}

export interface CreateClaudeJudgeShimOptions {
  launcherDirectory: string;
  claudeExecutable: string;
  harnessHome: string;
}

const SAFE_PROCESS_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "TZ",
  "CI",
  "NO_COLOR",
  "NODE_EXTRA_CA_CERTS",
  "DBUS_SESSION_BUS_ADDRESS",
  "LOGNAME",
  "USER",
  "XDG_RUNTIME_DIR",
] as const;

function selectedEnvironment(
  source: NodeJS.ProcessEnv,
  additionalKeys: readonly string[],
): NodeJS.ProcessEnv {
  const selected: NodeJS.ProcessEnv = {};
  for (const key of [...SAFE_PROCESS_ENV_KEYS, ...additionalKeys]) {
    const value = source[key];
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

function registryPath(paths: Pick<CampaignPaths, "worktrees">): string {
  return join(resolve(paths.worktrees), registryFilename);
}

async function loadRegistry(paths: Pick<CampaignPaths, "worktrees">): Promise<WorktreeRegistry> {
  const raw = await readJsonFile(registryPath(paths));
  return raw === undefined
    ? { version: 1, worktrees: [] }
    : worktreeRegistrySchema.parse(raw);
}

async function saveRegistry(
  paths: Pick<CampaignPaths, "worktrees">,
  registry: WorktreeRegistry,
): Promise<void> {
  await atomicWriteJson(registryPath(paths), worktreeRegistrySchema.parse(registry));
}

function gitFailure(args: readonly string[], result: GitResult): Error {
  const detail = (result.stderr || result.stdout).trim();
  return new Error(`git ${args.join(" ")} failed${detail === "" ? "" : `: ${detail}`}`);
}

async function git(
  runner: GitRunner,
  cwd: string,
  args: readonly string[],
  allowedCodes: readonly number[] = [0],
): Promise<GitResult> {
  const result = await runner({ cwd, args });
  if (result.code === null || !allowedCodes.includes(result.code)) {
    throw gitFailure(args, result);
  }
  return result;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await stat(absolute);
  if (!info.isDirectory()) throw new Error(`Expected a directory: ${absolute}`);
  return realpath(absolute);
}

async function canonicalWorktreeDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Worktree path is not a real directory: ${absolute}`);
  }
  const canonical = await realpath(absolute);
  if (canonical !== absolute) {
    throw new Error(`Worktree path is not canonical: ${absolute} resolves to ${canonical}`);
  }
  return canonical;
}

async function repositoryIdentity(runner: GitRunner, cwd: string): Promise<{
  root: string;
  commonDir: string;
}> {
  const rootResult = await git(runner, cwd, ["rev-parse", "--show-toplevel"]);
  const commonResult = await git(runner, cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return {
    root: await canonicalDirectory(rootResult.stdout.trim()),
    commonDir: await canonicalDirectory(commonResult.stdout.trim()),
  };
}

async function assertRepositoryRoot(runner: GitRunner, path: string): Promise<{
  root: string;
  commonDir: string;
}> {
  const expected = await canonicalDirectory(path);
  const identity = await repositoryIdentity(runner, expected);
  if (identity.root !== expected) {
    throw new Error(`Repository root mismatch: expected ${expected}, got ${identity.root}`);
  }
  return identity;
}

async function assertClean(runner: GitRunner, worktreePath: string): Promise<void> {
  const status = await git(runner, worktreePath, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (status.stdout !== "") {
    throw new Error(`Worktree is not clean: ${worktreePath}`);
  }
}

const removableGeneratedPrefixes = [
  "node_modules/",
  "dist/",
  "benchmarks/compare/results/",
] as const;

async function assertCleanupResidueSafe(runner: GitRunner, worktreePath: string): Promise<void> {
  const status = await git(runner, worktreePath, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  for (const record of nulPaths(status.stdout)) {
    if (!record.startsWith("!! ")) {
      throw new Error(`Worktree is not clean: ${worktreePath}`);
    }
    const path = record.slice(3).replace(/\\/gu, "/");
    if (!removableGeneratedPrefixes.some((prefix) => (
      path === prefix.slice(0, -1) || path.startsWith(prefix)
    ))) {
      throw new Error(`Worktree contains unknown ignored residue and cannot be cleaned: ${worktreePath}/${path}`);
    }
  }
}

async function resolveCommit(runner: GitRunner, cwd: string, commit: string): Promise<string> {
  const result = await git(runner, cwd, ["rev-parse", "--verify", `${commit}^{commit}`]);
  const resolvedCommit = result.stdout.trim();
  if (!fullCommitPattern.test(resolvedCommit)) {
    throw new Error(`Git returned an invalid commit id: ${resolvedCommit}`);
  }
  return resolvedCommit;
}

async function assertWorktree(
  runner: GitRunner,
  sourceIdentity: { commonDir: string },
  worktreePath: string,
  expectedCommit: string,
  requireDetached: boolean,
): Promise<string> {
  const actualPath = await canonicalWorktreeDirectory(worktreePath);
  const identity = await repositoryIdentity(runner, actualPath);
  if (identity.commonDir !== sourceIdentity.commonDir) {
    throw new Error(`Worktree belongs to a different repository: ${actualPath}`);
  }
  const head = await resolveCommit(runner, actualPath, "HEAD");
  if (head !== expectedCommit) {
    throw new Error(`Worktree HEAD mismatch: expected ${expectedCommit}, got ${head}`);
  }
  if (requireDetached) {
    const symbolic = await git(runner, actualPath, ["symbolic-ref", "-q", "HEAD"], [0, 1]);
    if (symbolic.code === 0) throw new Error(`Base worktree is not detached: ${actualPath}`);
  }
  return actualPath;
}

function nowIso(now: (() => Date) | undefined): string {
  return (now ?? (() => new Date()))().toISOString();
}

function assertRecordMatches(
  record: CreatedWorktreeRecord,
  id: string,
  kind: CreatedWorktreeRecord["kind"],
  repositoryRoot: string,
  worktreePath: string,
  commit: string,
): void {
  if (
    record.id !== id
    || record.kind !== kind
    || record.repositoryRoot !== repositoryRoot
    || record.path !== worktreePath
    || record.commit !== commit
  ) {
    throw new Error(`Recorded ${kind} worktree does not match the requested repository, path, or commit`);
  }
}

interface CreateRegisteredWorktreeOptions {
  repositoryRoot: string;
  paths: Pick<CampaignPaths, "worktrees">;
  id: string;
  kind: CreatedWorktreeRecord["kind"];
  commit: string;
  runner?: GitRunner;
  now?: () => Date;
}

function ownedWorktreePath(
  worktreesRoot: string,
  kind: CreatedWorktreeRecord["kind"],
  id: string,
): string {
  return kind === "base"
    ? join(resolve(worktreesRoot), "base")
    : join(resolve(worktreesRoot), "candidates", id);
}

function recordKey(record: Pick<CreatedWorktreeRecord, "id" | "kind">): string {
  return `${record.kind}:${record.id}`;
}

async function createRegisteredDetachedWorktree(
  options: CreateRegisteredWorktreeOptions,
): Promise<CreatedWorktreeRecord> {
  const runner = options.runner ?? spawnGit;
  const sourceIdentity = await assertRepositoryRoot(runner, options.repositoryRoot);
  await assertClean(runner, sourceIdentity.root);
  const commit = await resolveCommit(runner, sourceIdentity.root, options.commit);
  const worktreesRoot = resolve(options.paths.worktrees);
  const worktreePath = ownedWorktreePath(worktreesRoot, options.kind, options.id);
  await ensureDir(worktreesRoot);

  const registry = await loadRegistry(options.paths);
  const existingRecord = registry.worktrees.find((record) => (
    record.id === options.id && record.kind === options.kind
  ));
  if (existingRecord?.status === "removed") {
    throw new Error(`The campaign ${options.kind} worktree was already cleaned up and will not be recreated`);
  }
  if (existingRecord !== undefined) {
    assertRecordMatches(
      existingRecord,
      options.id,
      options.kind,
      sourceIdentity.root,
      worktreePath,
      commit,
    );
    if (await exists(worktreePath)) {
      await assertWorktree(runner, sourceIdentity, worktreePath, commit, true);
      await assertClean(runner, worktreePath);
      if (existingRecord.status === "active") return existingRecord;
      const activated = {
        ...existingRecord,
        status: "active" as const,
        updatedAt: nowIso(options.now),
      };
      await saveRegistry(options.paths, {
        ...registry,
        worktrees: registry.worktrees.map((record) => (
          record.id === options.id && record.kind === options.kind ? activated : record
        )),
      });
      return activated;
    }
    if (existingRecord.status === "active") {
      throw new Error(`Recorded campaign worktree is missing: ${worktreePath}`);
    }
  } else if (await exists(worktreePath)) {
    throw new Error(`Refusing to adopt an unrecorded worktree path: ${worktreePath}`);
  }

  const timestamp = nowIso(options.now);
  const planned: CreatedWorktreeRecord = {
    id: options.id,
    kind: options.kind,
    repositoryRoot: sourceIdentity.root,
    path: worktreePath,
    commit,
    status: "planned",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  if (existingRecord === undefined) {
    registry.worktrees.push(planned);
    await saveRegistry(options.paths, registry);
  }

  await git(runner, sourceIdentity.root, [
    "worktree",
    "add",
    "--detach",
    worktreePath,
    commit,
  ]);
  await assertWorktree(runner, sourceIdentity, worktreePath, commit, true);
  await assertClean(runner, worktreePath);

  const activated: CreatedWorktreeRecord = {
    ...(existingRecord ?? planned),
    status: "active",
    updatedAt: nowIso(options.now),
  };
  const currentRegistry = await loadRegistry(options.paths);
  await saveRegistry(options.paths, {
    ...currentRegistry,
    worktrees: currentRegistry.worktrees.map((record) => (
      record.id === options.id && record.kind === options.kind ? activated : record
    )),
  });
  return activated;
}

export async function createDetachedBaseWorktree(
  options: CreateBaseWorktreeOptions,
): Promise<CreatedWorktreeRecord> {
  return createRegisteredDetachedWorktree({
    repositoryRoot: options.repositoryRoot,
    paths: options.paths,
    id: "base",
    kind: "base",
    commit: options.baseCommit,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export async function createDetachedCandidateWorktree(
  options: CreateCandidateWorktreeOptions,
): Promise<CreatedWorktreeRecord> {
  assertSafeSegment("candidate id", options.candidateId);
  return createRegisteredDetachedWorktree({
    repositoryRoot: options.repositoryRoot,
    paths: options.paths,
    id: options.candidateId,
    kind: "candidate",
    commit: options.candidateCommit,
    ...(options.runner === undefined ? {} : { runner: options.runner }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function nulPaths(stdout: string): string[] {
  if (stdout === "") return [];
  const values = stdout.split("\0");
  if (values.at(-1) === "") values.pop();
  return values;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function repositoryRelativePath(repositoryRoot: string, absolutePath: string): string | undefined {
  const candidate = relative(repositoryRoot, resolve(absolutePath));
  if (
    candidate === ""
    || candidate === ".."
    || candidate.startsWith("../")
    || candidate.startsWith("..\\")
    || isAbsolute(candidate)
  ) {
    return undefined;
  }
  return candidate.split("\\").join("/");
}

function protectedReason(path: string, frozenSuiteRelative: string | undefined): string | undefined {
  if (protectedExactPaths.has(path)) return "protected evaluator or package input";
  if (protectedPrefixes.some((prefix) => path.startsWith(prefix))) {
    return "protected comparison or optimizer controller path";
  }
  if (frozenSuiteRelative !== undefined && path === frozenSuiteRelative) {
    return "campaign frozen suite";
  }
  if (dependencyFilenames.has(posix.basename(path))) {
    return "dependency manifest or lockfile";
  }
  if (
    path.split("/").some((segment) => segment === "node_modules" || segment === ".wire")
    || path === "dist"
    || path.startsWith("dist/")
    || posix.basename(path) === ".env"
    || posix.basename(path).startsWith(".env.")
  ) {
    return "generated dependency, runtime state, build output, or environment file";
  }
  return undefined;
}

function isTestPath(path: string): boolean {
  return /(?:^|\/)tests?\//u.test(path) || /\.(?:test|spec)\.tsx?$/u.test(path);
}

function isProductionTypeScript(path: string): boolean {
  return path.startsWith("src/") && /\.tsx?$/u.test(path) && !isTestPath(path);
}

function isMeasuredBehaviorPath(path: string): boolean {
  return isProductionTypeScript(path) || path.startsWith("skills/");
}

function parseNumstat(stdout: string): Array<{ additions: number; deletions: number; path: string }> {
  const records: Array<{ additions: number; deletions: number; path: string }> = [];
  for (const record of nulPaths(stdout)) {
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error("Malformed git numstat output");
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    const path = record.slice(secondTab + 1);
    if (additionsText === "-" || deletionsText === "-") continue;
    const additions = Number.parseInt(additionsText, 10);
    const deletions = Number.parseInt(deletionsText, 10);
    if (!Number.isSafeInteger(additions) || !Number.isSafeInteger(deletions)) {
      throw new Error("Malformed git numstat line counts");
    }
    records.push({ additions, deletions, path });
  }
  return records;
}

function parseTreeEntries(stdout: string): Array<{ mode: string; type: string; path: string }> {
  return nulPaths(stdout).map((record) => {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error("Malformed git ls-tree output");
    const metadata = record.slice(0, separator).split(/\s+/u);
    if (metadata.length !== 3 || !/^\d{6}$/u.test(metadata[0] ?? "")) {
      throw new Error("Malformed git ls-tree metadata");
    }
    return {
      mode: metadata[0]!,
      type: metadata[1]!,
      path: record.slice(separator + 1),
    };
  });
}

async function assertCommitOwnedTreeEntries(
  runner: GitRunner,
  cwd: string,
  candidateCommit: string,
  changedPaths: readonly string[],
): Promise<void> {
  if (changedPaths.length === 0) return;
  const tree = await git(runner, cwd, [
    "ls-tree",
    "-r",
    "-z",
    candidateCommit,
    "--",
    ...changedPaths,
  ]);
  const unsafe = parseTreeEntries(tree.stdout).flatMap((entry) => {
    if (entry.mode === "120000") return [`${entry.path} (symbolic link)`];
    if (entry.mode === "160000" || entry.type === "commit") return [`${entry.path} (gitlink)`];
    return [];
  });
  if (unsafe.length > 0) {
    throw new Error(`Candidate changes non-regular tree entries: ${unsafe.join(", ")}`);
  }
}

async function existingAtBase(
  runner: GitRunner,
  cwd: string,
  baseCommit: string,
  path: string,
): Promise<boolean> {
  const result = await git(runner, cwd, ["cat-file", "-e", `${baseCommit}:${path}`], [0, 1]);
  return result.code === 0;
}

export async function validateCandidateWorktree(
  options: ValidateCandidateOptions,
): Promise<CandidateValidation> {
  const runner = options.runner ?? spawnGit;
  const response = candidateResponseSchema.parse(options.response);
  if (response.campaignId !== options.campaignId) {
    throw new Error(`Candidate belongs to campaign ${response.campaignId}, not ${options.campaignId}`);
  }
  const sourceIdentity = await assertRepositoryRoot(runner, options.repositoryRoot);
  const baseCommit = await resolveCommit(runner, sourceIdentity.root, options.baseCommit);
  if (response.baseCommit !== baseCommit) {
    throw new Error(`Candidate base ${response.baseCommit} does not match campaign base ${baseCommit}`);
  }

  const candidatePath = await canonicalWorktreeDirectory(response.worktreePath);
  const candidateIdentity = await repositoryIdentity(runner, candidatePath);
  if (candidateIdentity.commonDir !== sourceIdentity.commonDir) {
    throw new Error(`Candidate worktree belongs to a different repository: ${candidatePath}`);
  }
  const candidateCommit = await resolveCommit(runner, candidatePath, response.candidateCommit);
  const head = await resolveCommit(runner, candidatePath, "HEAD");
  if (head !== candidateCommit) {
    throw new Error(`Candidate worktree HEAD ${head} does not match response commit ${candidateCommit}`);
  }
  const ancestry = await git(
    runner,
    candidatePath,
    ["merge-base", "--is-ancestor", baseCommit, candidateCommit],
    [0, 1],
  );
  if (ancestry.code !== 0) {
    throw new Error(`Candidate commit ${candidateCommit} does not descend from base ${baseCommit}`);
  }
  await assertClean(runner, candidatePath);

  const diffRange = `${baseCommit}...${candidateCommit}`;
  const changedResult = await git(runner, candidatePath, [
    "diff",
    "--no-ext-diff",
    "--text",
    "--name-only",
    "-z",
    diffRange,
  ]);
  const changedFiles = sortedUnique(nulPaths(changedResult.stdout));
  const reportedFiles = sortedUnique(response.changedFiles);
  if (!arraysEqual(changedFiles, reportedFiles)) {
    throw new Error(
      `Candidate changedFiles mismatch: Git reports [${changedFiles.join(", ")}], response reports [${reportedFiles.join(", ")}]`,
    );
  }

  // Inspect both sides of renames independently. The response still matches the
  // ordinary `git diff --name-only base...candidate` contract above, while a
  // protected evaluator file cannot escape by being renamed out of its prefix.
  const allTouchedResult = await git(runner, candidatePath, [
    "diff",
    "--no-ext-diff",
    "--text",
    "--name-only",
    "--no-renames",
    "-z",
    diffRange,
  ]);
  const allTouchedFiles = sortedUnique(nulPaths(allTouchedResult.stdout));
  const frozenSuiteRelative = repositoryRelativePath(sourceIdentity.root, options.frozenSuitePath);
  const protectedChanges = allTouchedFiles.flatMap((path) => {
    const reason = protectedReason(path, frozenSuiteRelative);
    return reason === undefined ? [] : [`${path} (${reason})`];
  });
  if (protectedChanges.length > 0) {
    throw new Error(`Candidate changes protected paths: ${protectedChanges.join(", ")}`);
  }
  await assertCommitOwnedTreeEntries(runner, candidatePath, candidateCommit, allTouchedFiles);

  const numstat = await git(runner, candidatePath, [
    "diff",
    "--no-ext-diff",
    "--text",
    "--numstat",
    "--no-renames",
    "-z",
    diffRange,
  ]);
  // The persisted field name predates skill treatments. Count both production
  // TypeScript and durable skill content so simplicity does not treat a large
  // skill patch as zero behavioral churn.
  const behaviorStats = parseNumstat(numstat.stdout)
    .filter((record) => isMeasuredBehaviorPath(record.path));
  const changedProductionLines = behaviorStats
    .reduce((total, record) => total + record.additions + record.deletions, 0);
  const productionLineDelta = behaviorStats
    .reduce((total, record) => total + record.additions - record.deletions, 0);
  const changedTestFiles = allTouchedFiles.filter(isTestPath);
  const existingTestFilesChanged: string[] = [];
  for (const path of changedTestFiles) {
    if (await existingAtBase(runner, candidatePath, baseCommit, path)) {
      existingTestFilesChanged.push(path);
    }
  }

  return {
    worktreePath: candidatePath,
    changedFiles,
    changedProductionLines,
    productionLineDelta,
    changedTestFiles,
    existingTestFilesChanged,
  };
}

function assertCampaignOwnedPath(worktreesRoot: string, path: string): void {
  const resolvedRoot = resolve(worktreesRoot);
  const resolvedPath = resolve(path);
  const child = relative(resolvedRoot, resolvedPath);
  if (
    child === ""
    || child === ".."
    || child.startsWith("../")
    || child.startsWith("..\\")
    || isAbsolute(child)
  ) {
    throw new Error(`Recorded worktree is outside the campaign worktree directory: ${resolvedPath}`);
  }
}

export async function cleanupCampaignWorktrees(
  options: CleanupWorktreesOptions,
): Promise<string[]> {
  const runner = options.runner ?? spawnGit;
  const sourceIdentity = await assertRepositoryRoot(runner, options.repositoryRoot);
  const registry = await loadRegistry(options.paths);
  const candidates = registry.worktrees.filter((record) => record.status !== "removed");
  const removable: CreatedWorktreeRecord[] = [];
  const absentPlanned = new Set<string>();

  // Preflight every path before removing any, so one dirty worktree cannot leave
  // a campaign half-cleaned.
  for (const record of candidates) {
    assertRecordMatches(
      record,
      record.id,
      record.kind,
      sourceIdentity.root,
      ownedWorktreePath(options.paths.worktrees, record.kind, record.id),
      record.commit,
    );
    assertCampaignOwnedPath(options.paths.worktrees, record.path);
    if (!await exists(record.path)) {
      // Reconcile a crash after `git worktree remove` but before the registry's
      // atomic status update. The path is already absent, so no deletion occurs.
      absentPlanned.add(recordKey(record));
      continue;
    }
    await assertWorktree(runner, sourceIdentity, record.path, record.commit, true);
    await assertClean(runner, record.path);
    await assertCleanupResidueSafe(runner, record.path);
    removable.push(record);
  }

  const removed: string[] = [];
  let currentRegistry = registry;
  for (const record of removable) {
    // Recheck immediately and let Git's non-force removal perform the final
    // race-safe cleanliness check. Remove only known ignored build products
    // from this controller-owned worktree first.
    await assertWorktree(runner, sourceIdentity, record.path, record.commit, true);
    await assertClean(runner, record.path);
    for (const generated of removableGeneratedPrefixes.map((prefix) => (
      join(record.path, ...prefix.slice(0, -1).split("/"))
    ))) {
      await canonicalWorktreeDirectory(record.path);
      await rm(generated, { recursive: true, force: true });
    }
    await canonicalWorktreeDirectory(record.path);
    await assertClean(runner, record.path);
    await assertCleanupResidueSafe(runner, record.path);
    await canonicalWorktreeDirectory(record.path);
    await git(runner, sourceIdentity.root, ["worktree", "remove", record.path]);
    removed.push(record.path);
    const timestamp = nowIso(options.now);
    currentRegistry = {
      ...currentRegistry,
      worktrees: currentRegistry.worktrees.map((item) => recordKey(item) === recordKey(record)
        ? { ...item, status: "removed" as const, updatedAt: timestamp }
        : item),
    };
    await saveRegistry(options.paths, currentRegistry);
  }

  if (absentPlanned.size > 0) {
    const timestamp = nowIso(options.now);
    currentRegistry = {
      ...currentRegistry,
      worktrees: currentRegistry.worktrees.map((item) => absentPlanned.has(recordKey(item))
        ? { ...item, status: "removed" as const, updatedAt: timestamp }
        : item),
    };
    await saveRegistry(options.paths, currentRegistry);
  }
  return removed;
}

function assertSafeSegment(label: string, value: string): void {
  if (!safeSegmentPattern.test(value)) throw new Error(`Unsafe ${label}: ${value}`);
}

export async function prepareAttemptIsolation(
  options: PrepareAttemptIsolationOptions,
): Promise<AttemptIsolation> {
  assertSafeSegment("slot id", options.slotId);
  if (!/^[a-f0-9]{64}$/u.test(options.skillSnapshotHash)) {
    throw new Error("Invalid skill snapshot SHA-256");
  }
  const actualSnapshotHash = await sha256Path(options.skillSnapshotPath);
  if (actualSnapshotHash !== options.skillSnapshotHash) {
    throw new Error(
      `Skill snapshot hash mismatch: expected ${options.skillSnapshotHash}, got ${actualSnapshotHash}`,
    );
  }
  const snapshotInfo = await stat(options.skillSnapshotPath);
  if (!snapshotInfo.isDirectory()) throw new Error("Skill snapshot must be a directory");

  const wireRoot = resolve(options.paths.traces, options.slotId, options.arm);
  const skillRoot = resolve(
    options.paths.skills,
    options.skillSnapshotHash,
    options.slotId,
    options.arm,
  );
  if (await exists(wireRoot) || await exists(skillRoot)) {
    throw new Error(`Attempt isolation already exists for ${options.slotId}/${options.arm}`);
  }
  await mkdir(dirname(wireRoot), { recursive: true });
  await mkdir(wireRoot);
  await mkdir(dirname(skillRoot), { recursive: true });
  await cp(resolve(options.skillSnapshotPath), skillRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
  const copiedHash = await sha256Path(skillRoot);
  if (copiedHash !== options.skillSnapshotHash) {
    throw new Error(`Copied skill snapshot hash mismatch: expected ${options.skillSnapshotHash}, got ${copiedHash}`);
  }
  return { wireRoot, skillRoot, skillSnapshotHash: copiedHash };
}

export async function createWireShim(
  isolation: AttemptIsolation,
  worktreePath: string,
  options: CreateWireShimOptions,
): Promise<string> {
  const worktree = await canonicalDirectory(worktreePath);
  const wireEntry = join(worktree, "dist", "index.js");
  const entryInfo = await stat(wireEntry);
  if (!entryInfo.isFile()) throw new Error(`Built Wire entry is not a file: ${wireEntry}`);

  const wireRoot = await canonicalDirectory(isolation.wireRoot);
  const skillRoot = await canonicalDirectory(isolation.skillRoot);
  const launcherDirectory = resolve(options.launcherDirectory);
  await ensureDir(launcherDirectory);
  if (await canonicalDirectory(launcherDirectory) !== launcherDirectory) {
    throw new Error(`Attempt launcher directory is redirected: ${launcherDirectory}`);
  }
  const environmentNames = Object.keys(options.candidateEnvironment).sort((left, right) => (
    left.localeCompare(right)
  ));
  const forwarded = new Set(options.forwardedEnvironmentKeys);
  for (const name of forwarded) {
    if (options.candidateEnvironment[name] === undefined) {
      throw new Error(`Forwarded Wire environment variable is absent: ${name}`);
    }
  }
  const fixedEnvironment = Object.fromEntries(
    environmentNames
      .filter((name) => !forwarded.has(name))
      .map((name) => [name, options.candidateEnvironment[name]!]),
  );
  const extraCertificate = options.candidateEnvironment.NODE_EXTRA_CA_CERTS;
  const readOnlyPaths = [worktree];
  if (extraCertificate !== undefined) {
    if (!isAbsolute(extraCertificate) || resolve(extraCertificate) !== extraCertificate) {
      throw new Error("NODE_EXTRA_CA_CERTS must be a normalized absolute path in the Wire sandbox");
    }
    readOnlyPaths.push(extraCertificate);
  }
  const launch = buildSystemdSandboxInvocation({
    command: process.execPath,
    args: [wireEntry],
    cwd: worktree,
    environment: options.candidateEnvironment,
    environmentNames,
    readOnlyPaths,
    readWritePaths: [wireRoot, skillRoot],
    timeoutMs: options.timeoutMs,
  });
  const shimPath = join(launcherDirectory, "wire");
  const source = [
    `#!${process.execPath}`,
    "(async () => {",
    "const { spawnSync } = await import('node:child_process');",
    `const command = ${JSON.stringify(launch.command)};`,
    `const baseArgs = ${JSON.stringify(launch.args)};`,
    `const forwarded = ${JSON.stringify([...forwarded].sort((left, right) => left.localeCompare(right)))};`,
    `const fixed = ${JSON.stringify(fixedEnvironment)};`,
    `const control = ${JSON.stringify([
      "DBUS_SESSION_BUS_ADDRESS",
      "LOGNAME",
      "USER",
      "XDG_RUNTIME_DIR",
    ])};`,
    "const env = {};",
    "for (const name of [...control, ...forwarded]) {",
    "  if (process.env[name] !== undefined) env[name] = process.env[name];",
    "}",
    "Object.assign(env, fixed);",
    "const result = spawnSync(command, [...baseArgs, ...process.argv.slice(2)], {",
    "  stdio: 'inherit',",
    "  env,",
    "});",
    "if (result.error) throw result.error;",
    "if (result.signal) process.kill(process.pid, result.signal);",
    "process.exitCode = result.status ?? 1;",
    "})().catch((error) => {",
    "  console.error(error);",
    "  process.exitCode = 1;",
    "});",
    "",
  ].join("\n");
  await writeFile(shimPath, source, { encoding: "utf8", flag: "wx", mode: 0o755 });
  return launcherDirectory;
}

/**
 * Pin the controller's Claude executable behind a credential-scrubbing wrapper.
 * The immutable judge inherits the harness environment, so this boundary keeps
 * browser credentials and candidate runtime paths out of the judge process.
 */
export async function createClaudeJudgeShim(
  options: CreateClaudeJudgeShimOptions,
): Promise<string> {
  const launcherDirectory = await canonicalDirectory(options.launcherDirectory);
  const harnessHome = await canonicalDirectory(options.harnessHome);
  const declaredExecutable = resolve(options.claudeExecutable);
  const claudeExecutable = await realpath(declaredExecutable);
  if (claudeExecutable !== declaredExecutable) {
    throw new Error(`Claude judge executable is not canonical: ${declaredExecutable}`);
  }
  const executableInfo = await stat(claudeExecutable);
  if (!executableInfo.isFile() || (executableInfo.mode & 0o111) === 0) {
    throw new Error(`Claude judge executable is not an executable file: ${claudeExecutable}`);
  }

  const shimPath = join(launcherDirectory, "claude");
  const source = [
    `#!${process.execPath}`,
    "(async () => {",
    "const { spawnSync } = await import('node:child_process');",
    `const target = ${JSON.stringify(claudeExecutable)};`,
    `const home = ${JSON.stringify(harnessHome)};`,
    `const allowed = ${JSON.stringify([
      "ANTHROPIC_API_KEY",
      "LANG",
      "LC_ALL",
      "TZ",
      "NO_COLOR",
      "NODE_EXTRA_CA_CERTS",
    ])};`,
    "const env = {};",
    "for (const name of allowed) {",
    "  if (process.env[name] !== undefined) env[name] = process.env[name];",
    "}",
    "env.HOME = home;",
    `env.PATH = ${JSON.stringify([
      dirname(claudeExecutable),
      dirname(process.execPath),
    ].join(delimiter))};`,
    "const result = spawnSync(target, process.argv.slice(2), {",
    "  stdio: 'inherit',",
    "  env,",
    "  shell: false,",
    "});",
    "if (result.error) throw result.error;",
    "if (result.signal) process.kill(process.pid, result.signal);",
    "process.exitCode = result.status ?? 1;",
    "})().catch((error) => {",
    "  console.error(error);",
    "  process.exitCode = 1;",
    "});",
    "",
  ].join("\n");
  await writeFile(shimPath, source, { encoding: "utf8", flag: "wx", mode: 0o755 });
  return shimPath;
}

/**
 * Construct, but never persist, the child environment for the comparison
 * harness. Only controller-owned launchers and the exact controller Node
 * directory are executable by name; candidate-local package bins never enter
 * the judge's PATH.
 */
export function harnessEnvironment(options: HarnessEnvironmentOptions): NodeJS.ProcessEnv {
  const inherited = options.inheritedEnv ?? process.env;
  const launcherDirectory = resolve(options.launcherDirectory);
  return {
    ...selectedEnvironment(inherited, options.allowedEnvironmentKeys ?? []),
    HOME: resolve(options.harnessHome),
    WIRE_ROOT: resolve(options.isolation.wireRoot),
    WIRE_SKILLS: resolve(options.isolation.skillRoot),
    PATH: [launcherDirectory, dirname(process.execPath)].join(delimiter),
  };
}
