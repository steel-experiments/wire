import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "../../src/storage/atomic.js";
import { containsSecrets } from "../../src/shared/redact.js";
import { assertExistingDirectoryChain } from "./path-safety.js";
import {
  attemptSchema,
  campaignSpecSchema,
  campaignStateSchema,
  candidateResponseSchema,
  parseCampaignRecipe,
  safeIdentifierSchema,
  type Attempt,
  type CampaignRecipe,
  type CampaignSpec,
  type CampaignState,
  type CandidateResponse,
} from "./model.js";

const suiteSchema = z.array(z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u, "expected a CLI-safe task id"),
  objective: z.string().trim().min(1),
  maxSteps: z.number().int().positive(),
}).passthrough()).min(1);

export interface CampaignPaths {
  root: string;
  resolvedCampaign: string;
  state: string;
  attempts: string;
  traces: string;
  skills: string;
  autopsies: string;
  candidates: string;
  packets: string;
  reports: string;
  worktrees: string;
}

export interface InitializeCampaignOptions {
  optimizerRoot: string;
  recipePath: string;
  recipe?: CampaignRecipe;
  baseCommit: string;
  now?: () => Date;
}

interface ResolvedCampaignSnapshot {
  spec: CampaignSpec;
  sha256: string;
}

export function campaignPaths(optimizerRoot: string, campaignId: string): CampaignPaths {
  const safeCampaignId = safeIdentifierSchema.parse(campaignId);
  const root = join(resolve(optimizerRoot), safeCampaignId);
  return {
    root,
    resolvedCampaign: join(root, "resolved-campaign.json"),
    state: join(root, "state.json"),
    attempts: join(root, "attempts"),
    traces: join(root, "traces"),
    skills: join(root, "skills"),
    autopsies: join(root, "autopsies"),
    candidates: join(root, "candidates"),
    packets: join(root, "packets"),
    reports: join(root, "reports"),
    worktrees: join(root, "worktrees"),
  };
}

export function defaultOptimizerRoot(repositoryRoot: string): string {
  return join(resolve(repositoryRoot), ".wire", "optimizer");
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(await readFile(path));
  return hash.digest("hex");
}

function hashBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function readOwnedRegularFile(
  path: string,
  label: string,
): Promise<Buffer | undefined> {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`${label} is not a real regular file: ${path}`);
  }
  const content = await readFile(path);
  let after;
  try {
    after = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`${label} changed while it was being read: ${path}`);
    }
    throw error;
  }
  if (
    after.isSymbolicLink()
    || !after.isFile()
    || before.dev !== after.dev
    || before.ino !== after.ino
    || before.size !== after.size
  ) {
    throw new Error(`${label} changed while it was being read: ${path}`);
  }
  return content;
}

async function assertOwnedRegularFileIfPresent(path: string, label: string): Promise<void> {
  await readOwnedRegularFile(path, label);
}

function parseJsonBuffer(content: Buffer, label: string): unknown {
  try {
    return JSON.parse(content.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

async function readResolvedCampaign(paths: CampaignPaths): Promise<ResolvedCampaignSnapshot | undefined> {
  const content = await readOwnedRegularFile(paths.resolvedCampaign, "Resolved campaign manifest");
  if (content === undefined) return undefined;
  return {
    spec: campaignSpecSchema.parse(parseJsonBuffer(content, "Resolved campaign manifest")),
    sha256: hashBytes(content),
  };
}

async function readCampaignState(paths: CampaignPaths): Promise<CampaignState | undefined> {
  const content = await readOwnedRegularFile(paths.state, "Campaign state");
  return content === undefined
    ? undefined
    : campaignStateSchema.parse(parseJsonBuffer(content, "Campaign state"));
}

async function directoryEntries(root: string, current: string): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((lhs, rhs) => lhs.name.localeCompare(rhs.name))) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Skill snapshots may not contain symbolic links: ${path}`);
    }
    if (entry.isDirectory()) {
      files.push(...await directoryEntries(root, path));
    } else if (entry.isFile()) {
      files.push(relative(root, path));
    }
  }
  return files;
}

export async function sha256Path(path: string): Promise<string> {
  const absolute = resolve(path);
  const stat = await lstat(absolute);
  if (stat.isSymbolicLink()) {
    throw new Error(`Hashed inputs may not be symbolic links: ${absolute}`);
  }
  if (stat.isFile()) return hashFile(absolute);
  if (!stat.isDirectory()) throw new Error(`Hashed input must be a file or directory: ${absolute}`);

  const hash = createHash("sha256");
  for (const name of await directoryEntries(absolute, absolute)) {
    hash.update(name);
    hash.update("\0");
    hash.update(await readFile(join(absolute, name)));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function absoluteFromRecipe(recipePath: string, inputPath: string): string {
  return isAbsolute(inputPath) ? resolve(inputPath) : resolve(dirname(recipePath), inputPath);
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([lhs], [rhs]) => lhs.localeCompare(rhs))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

async function taskIdsFromSuite(path: string): Promise<Set<string>> {
  const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  const suite = suiteSchema.parse(raw);
  const ids = new Set<string>();
  for (const task of suite) {
    if (ids.has(task.id)) throw new Error(`Frozen suite has duplicate task id: ${task.id}`);
    ids.add(task.id);
  }
  return ids;
}

async function verifyTaskIds(spec: CampaignSpec): Promise<void> {
  const suiteIds = await taskIdsFromSuite(spec.suite.path);
  for (const cohortName of ["smoke", "targeted", "broad"] as const) {
    for (const taskId of spec.cohorts[cohortName].taskIds) {
      if (!suiteIds.has(taskId)) {
        throw new Error(`Unknown ${cohortName} task id in frozen suite: ${taskId}`);
      }
    }
  }
}

async function assertHash(label: string, path: string, expected: string): Promise<void> {
  const actual = await sha256Path(path);
  if (actual !== expected) {
    throw new Error(`${label} hash mismatch: expected ${expected}, got ${actual}`);
  }
}

export async function verifyFrozenInputs(spec: CampaignSpec, includeHoldout = false): Promise<void> {
  await assertHash("suite", spec.suite.path, spec.suite.sha256);
  await assertHash("skill snapshot", spec.skillSnapshot.path, spec.skillSnapshot.sha256);
  await verifyTaskIds(spec);
  if (includeHoldout) {
    const holdout = spec.cohorts.holdout;
    if (holdout === undefined) throw new Error("Campaign has no holdout cohort");
    await assertHash("holdout suite", holdout.externalSuitePath, holdout.sha256);
    await taskIdsFromSuite(holdout.externalSuitePath);
  }
}

async function assertRealDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`Campaign-owned path is not a real directory: ${path}`);
  }
  if (await realpath(path) !== resolve(path)) {
    throw new Error(`Campaign-owned path has a symlinked ancestor: ${path}`);
  }
}

async function ensureRealDirectory(path: string, recursive: boolean): Promise<void> {
  await assertExistingDirectoryChain(path, "Campaign-owned path");
  try {
    await mkdir(path, { recursive, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await assertRealDirectory(path);
  await chmod(path, 0o700);
}

function ownedDirectories(paths: CampaignPaths): string[] {
  return [
    paths.root,
    paths.attempts,
    paths.traces,
    paths.skills,
    paths.autopsies,
    paths.candidates,
    paths.packets,
    paths.reports,
    paths.worktrees,
  ];
}

async function ensureCampaignDirectories(paths: CampaignPaths): Promise<void> {
  const [, ...directories] = ownedDirectories(paths);
  // Create the campaign root first, then require every owned path to be a real
  // directory before chmod or persistence can follow a pre-existing symlink.
  await ensureRealDirectory(paths.root, true);
  await Promise.all(directories.map((path) => ensureRealDirectory(path, false)));
}

async function assertCampaignDirectories(paths: CampaignPaths): Promise<void> {
  await Promise.all(ownedDirectories(paths).map(assertRealDirectory));
}

function assertManifestStateBinding(
  paths: CampaignPaths,
  snapshot: ResolvedCampaignSnapshot,
  state: CampaignState,
): void {
  if (snapshot.sha256 !== state.campaignSpecSha256) {
    throw new Error(
      `Resolved campaign manifest digest mismatch: expected ${state.campaignSpecSha256}, got ${snapshot.sha256}`,
    );
  }
  if (
    snapshot.spec.id !== basename(paths.root)
    || state.campaignId !== snapshot.spec.id
    || state.baseCommit !== snapshot.spec.baseCommit
  ) {
    throw new Error(`Campaign ${state.campaignId} state provenance does not match its resolved manifest`);
  }
}

/**
 * Re-attest campaign-owned directories and the exact resolved manifest bytes.
 * Passing an in-memory state preserves the controller's pre-child trust anchor;
 * omitting it binds reads and auxiliary writes to the currently persisted state.
 */
export async function assertCampaignIntegrity(
  paths: CampaignPaths,
  expectedState?: CampaignState,
): Promise<void> {
  await assertCampaignDirectories(paths);
  const state = expectedState ?? await readCampaignState(paths);
  if (state === undefined) throw new Error(`Campaign state is missing: ${paths.state}`);
  const snapshot = await readResolvedCampaign(paths);
  if (snapshot === undefined) {
    throw new Error(`Resolved campaign manifest is missing: ${paths.resolvedCampaign}`);
  }
  assertManifestStateBinding(paths, snapshot, state);
}

export async function initializeCampaign(
  options: InitializeCampaignOptions,
): Promise<{ spec: CampaignSpec; state: CampaignState; paths: CampaignPaths; reopened: boolean }> {
  const recipePath = resolve(options.recipePath);
  const recipe = parseCampaignRecipe(
    options.recipe ?? JSON.parse(await readFile(recipePath, "utf8")) as unknown,
  );
  if (recipe.baseCommit !== options.baseCommit) {
    throw new Error(`Recipe base ${recipe.baseCommit} does not match selected base ${options.baseCommit}`);
  }

  const holdout = recipe.cohorts.holdout;
  const spec = campaignSpecSchema.parse({
    ...recipe,
    suite: { ...recipe.suite, path: absoluteFromRecipe(recipePath, recipe.suite.path) },
    skillSnapshot: {
      ...recipe.skillSnapshot,
      path: absoluteFromRecipe(recipePath, recipe.skillSnapshot.path),
    },
    cohorts: {
      ...recipe.cohorts,
      ...(holdout === undefined ? {} : {
        holdout: {
          ...holdout,
          externalSuitePath: absoluteFromRecipe(recipePath, holdout.externalSuitePath),
        },
      }),
    },
  });
  if (containsSecrets(JSON.stringify(spec))) {
    throw new Error("Campaign manifest contains a secret-looking value");
  }
  // The sealed suite is deliberately not opened during initialization. Its
  // declared path/hash are frozen into the manifest and verified only after a
  // candidate has passed broad evaluation and its commit is revalidated.
  await verifyFrozenInputs(spec);

  const paths = campaignPaths(options.optimizerRoot, spec.id);
  await ensureCampaignDirectories(paths);
  let existingSpec = await readResolvedCampaign(paths);
  const existingState = await readCampaignState(paths);
  if (existingSpec === undefined && existingState !== undefined) {
    throw new Error(`Campaign ${spec.id} has state without a resolved manifest`);
  }
  if (existingSpec !== undefined) {
    if (existingState !== undefined) {
      assertManifestStateBinding(paths, existingSpec, existingState);
    }
    if (stable(existingSpec.spec) !== stable(spec)) {
      throw new Error(`Campaign ${spec.id} already exists with a different manifest or base`);
    }
    if (existingState !== undefined) {
      return {
        spec: existingSpec.spec,
        state: existingState,
        paths,
        reopened: true,
      };
    }
  }
  if (existingSpec === undefined) {
    await atomicWriteJson(paths.resolvedCampaign, spec);
    existingSpec = await readResolvedCampaign(paths);
    if (existingSpec === undefined) {
      throw new Error(`Resolved campaign manifest was not persisted: ${paths.resolvedCampaign}`);
    }
  }
  const now = (options.now ?? (() => new Date()))().toISOString();
  const state = campaignStateSchema.parse({
    version: 1,
    campaignId: spec.id,
    baseCommit: spec.baseCommit,
    campaignSpecSha256: existingSpec.sha256,
    phase: "initialized",
    createdAt: now,
    updatedAt: now,
    physicalRunsUsed: 0,
    wallClockMsUsed: 0,
    buildWallClockMsUsed: 0,
    verificationWallClockMsUsed: 0,
    candidatesUsed: 0,
    completedSlots: [],
    builtRevisions: [],
    packetSequence: 0,
    candidates: {},
  });
  await atomicWriteJson(paths.state, state);
  return { spec, state, paths, reopened: false };
}

export async function loadCampaign(
  optimizerRoot: string,
  campaignId: string,
): Promise<{ spec: CampaignSpec; state: CampaignState; paths: CampaignPaths }> {
  const paths = campaignPaths(optimizerRoot, campaignId);
  try {
    await assertCampaignDirectories(paths);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Campaign not found: ${campaignId}`);
    }
    throw error;
  }
  const snapshot = await readResolvedCampaign(paths);
  const state = await readCampaignState(paths);
  if (snapshot === undefined || state === undefined) {
    throw new Error(`Campaign not found: ${campaignId}`);
  }
  assertManifestStateBinding(paths, snapshot, state);
  if (snapshot.spec.id !== campaignId) {
    throw new Error(`Campaign ${campaignId} state provenance does not match its resolved manifest`);
  }
  return { spec: snapshot.spec, state, paths };
}

export async function saveCampaignState(paths: CampaignPaths, state: CampaignState): Promise<void> {
  const parsed = campaignStateSchema.parse(state);
  await assertCampaignIntegrity(paths, parsed);
  await assertOwnedRegularFileIfPresent(paths.state, "Campaign state");
  await atomicWriteJson(paths.state, parsed);
}

export async function saveAttempt(paths: CampaignPaths, attempt: Attempt): Promise<void> {
  const parsed = attemptSchema.parse(attempt);
  await assertCampaignIntegrity(paths);
  const path = join(paths.attempts, `${parsed.slotId}.json`);
  await assertOwnedRegularFileIfPresent(path, "Campaign attempt");
  await atomicWriteJson(path, parsed);
}

export async function loadAttempt(paths: CampaignPaths, slotId: string): Promise<Attempt | undefined> {
  await assertCampaignIntegrity(paths);
  const safeSlotId = safeIdentifierSchema.parse(slotId);
  const content = await readOwnedRegularFile(
    join(paths.attempts, `${safeSlotId}.json`),
    "Campaign attempt",
  );
  return content === undefined
    ? undefined
    : attemptSchema.parse(parseJsonBuffer(content, "Campaign attempt"));
}

export async function listAttempts(paths: CampaignPaths): Promise<Attempt[]> {
  await assertCampaignIntegrity(paths);
  const entries = await readdir(paths.attempts, { withFileTypes: true });
  const attempts: Attempt[] = [];
  for (const entry of entries.sort((lhs, rhs) => lhs.name.localeCompare(rhs.name))) {
    if (!entry.name.endsWith(".json")) continue;
    if (!entry.isFile() || entry.isSymbolicLink()) {
      throw new Error(`Campaign attempt is not a real regular file: ${join(paths.attempts, entry.name)}`);
    }
    const content = await readOwnedRegularFile(join(paths.attempts, entry.name), "Campaign attempt");
    if (content === undefined) throw new Error(`Campaign attempt disappeared: ${entry.name}`);
    const attempt = attemptSchema.parse(parseJsonBuffer(content, "Campaign attempt"));
    if (entry.name !== `${attempt.slotId}.json`) {
      throw new Error(`Campaign attempt filename does not match slot identity: ${entry.name}`);
    }
    attempts.push(attempt);
  }
  return attempts;
}

export async function saveCandidateResponse(
  paths: CampaignPaths,
  response: CandidateResponse,
): Promise<void> {
  const parsed = candidateResponseSchema.parse(response);
  if (containsSecrets(JSON.stringify(parsed))) {
    throw new Error("Candidate response contains a secret-looking value");
  }
  await assertCampaignIntegrity(paths);
  const path = join(paths.candidates, `${parsed.candidateId}.json`);
  await assertOwnedRegularFileIfPresent(path, "Candidate response");
  await atomicWriteJson(path, parsed);
}
