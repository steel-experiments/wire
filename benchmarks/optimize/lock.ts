import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  readFile,
  realpath,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { assertExistingDirectoryChain } from "./path-safety.js";

const campaignIdPattern = /^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/u;
const actionPattern = /^[a-z0-9](?:[a-z0-9._:-]{0,62}[a-z0-9])?$/u;
const ownerIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const linuxIdentityPattern = /^linux:(?:[a-f0-9-]{36}:)?[0-9]+$/u;
const fallbackIdentityPattern = /^fallback-start:[0-9]+$/u;
const lockDirectoryName = ".campaign-locks";
const maxLockBytes = 4 * 1024;

interface LockRecord {
  version: 1;
  ownerId: string;
  pid: number;
  processIdentity: string;
  action: string;
  acquiredAt: string;
}

interface LockPaths {
  directory: string;
  lock: string;
}

interface LockSnapshot {
  record: LockRecord;
  device: number;
  inode: number;
}

interface LinuxProcessIdentity {
  startTicks: string;
  bootId?: string;
}

type LinuxIdentityProbe =
  | { status: "found"; identity: LinuxProcessIdentity }
  | { status: "missing" }
  | { status: "unavailable" };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function assertSafeAction(action: string): void {
  if (!actionPattern.test(action)) {
    throw new Error(`Unsafe campaign lock action: ${JSON.stringify(action)}`);
  }
}

function pathsFor(optimizerRoot: string, campaignId: string): LockPaths {
  if (optimizerRoot.trim() === "" || optimizerRoot.includes("\0")) {
    throw new Error("Optimizer root must be a non-empty filesystem path");
  }
  if (!campaignIdPattern.test(campaignId)) {
    throw new Error(`Unsafe campaign id for lock: ${JSON.stringify(campaignId)}`);
  }

  const root = resolve(optimizerRoot);
  const directory = join(root, lockDirectoryName);
  const lock = join(directory, `${campaignId}.lock`);
  const child = relative(root, lock);
  if (
    child === ""
    || child === ".."
    || child.startsWith("../")
    || child.startsWith("..\\")
    || isAbsolute(child)
  ) {
    throw new Error("Campaign lock path escapes the optimizer root");
  }
  return { directory, lock };
}

async function ensureLockDirectory(path: string): Promise<void> {
  await assertExistingDirectoryChain(path, "Campaign lock root");
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`Campaign lock root is not a real directory: ${path}`);
  }
  if (await realpath(path) !== resolve(path)) {
    throw new Error(`Campaign lock root has a symlinked ancestor: ${path}`);
  }
}

function isCanonicalIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function parseLockRecord(raw: unknown): LockRecord | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const expectedKeys = [
    "acquiredAt",
    "action",
    "ownerId",
    "pid",
    "processIdentity",
    "version",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    return undefined;
  }
  if (
    record.version !== 1
    || typeof record.ownerId !== "string"
    || !ownerIdPattern.test(record.ownerId)
    || typeof record.pid !== "number"
    || !Number.isSafeInteger(record.pid)
    || record.pid <= 0
    || record.pid > 2_147_483_647
    || typeof record.processIdentity !== "string"
    || (!linuxIdentityPattern.test(record.processIdentity)
      && !fallbackIdentityPattern.test(record.processIdentity))
    || typeof record.action !== "string"
    || !actionPattern.test(record.action)
    || !isCanonicalIsoDate(record.acquiredAt)
  ) {
    return undefined;
  }
  return {
    version: 1,
    ownerId: record.ownerId,
    pid: record.pid,
    processIdentity: record.processIdentity,
    action: record.action,
    acquiredAt: record.acquiredAt,
  };
}

async function readLock(path: string): Promise<LockSnapshot | undefined> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > maxLockBytes) {
    throw new Error(`Campaign lock is not a bounded regular record; refusing unsafe reclaim: ${path}`);
  }

  let content: string;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  if (Buffer.byteLength(content) > maxLockBytes) {
    throw new Error(`Campaign lock exceeds ${String(maxLockBytes)} bytes; refusing unsafe reclaim: ${path}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(content) as unknown;
  } catch {
    throw new Error(`Campaign lock is invalid JSON; refusing unsafe reclaim: ${path}`);
  }
  const record = parseLockRecord(raw);
  if (record === undefined) {
    throw new Error(`Campaign lock has an invalid owner record; refusing unsafe reclaim: ${path}`);
  }
  return { record, device: info.dev, inode: info.ino };
}

function procStartTicks(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 0) return undefined;
  // Fields after the command begin at proc(5) field 3; starttime is field 22.
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/u);
  const startTicks = fields[19];
  return startTicks !== undefined && /^[0-9]+$/u.test(startTicks) ? startTicks : undefined;
}

async function linuxProcessIdentity(pid: number): Promise<LinuxIdentityProbe> {
  if (process.platform !== "linux") return { status: "unavailable" };
  let stat: string;
  try {
    stat = await readFile(`/proc/${String(pid)}/stat`, "utf8");
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { status: "missing" }
      : { status: "unavailable" };
  }
  const startTicks = procStartTicks(stat);
  if (startTicks === undefined) return { status: "unavailable" };

  let bootId: string | undefined;
  try {
    const value = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim().toLowerCase();
    if (/^[a-f0-9-]{36}$/u.test(value)) bootId = value;
  } catch {
    // The process start tick remains useful when boot identity is unavailable.
  }
  return {
    status: "found",
    identity: bootId === undefined ? { startTicks } : { startTicks, bootId },
  };
}

function encodeLinuxIdentity(identity: LinuxProcessIdentity): string {
  return identity.bootId === undefined
    ? `linux:${identity.startTicks}`
    : `linux:${identity.bootId}:${identity.startTicks}`;
}

function decodeLinuxIdentity(value: string): LinuxProcessIdentity | undefined {
  if (!linuxIdentityPattern.test(value)) return undefined;
  const parts = value.split(":");
  if (parts.length === 2) return { startTicks: parts[1]! };
  if (parts.length === 3) return { bootId: parts[1]!, startTicks: parts[2]! };
  return undefined;
}

async function currentProcessIdentity(): Promise<string> {
  const linux = await linuxProcessIdentity(process.pid);
  if (linux.status === "found") return encodeLinuxIdentity(linux.identity);
  const startedAt = Math.max(0, Math.floor(Date.now() - (process.uptime() * 1_000)));
  return `fallback-start:${String(startedAt)}`;
}

async function ownerIsLive(owner: LockRecord): Promise<boolean> {
  const expectedLinux = decodeLinuxIdentity(owner.processIdentity);
  if (expectedLinux !== undefined) {
    const actual = await linuxProcessIdentity(owner.pid);
    if (actual.status === "missing") return false;
    if (actual.status === "found") {
      if (actual.identity.startTicks !== expectedLinux.startTicks) return false;
      if (
        expectedLinux.bootId !== undefined
        && actual.identity.bootId !== undefined
        && actual.identity.bootId !== expectedLinux.bootId
      ) {
        return false;
      }
      return true;
    }
  }

  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // EPERM proves that a process exists but is owned by another account. Any
    // unexpected probe failure is also treated conservatively as a live owner.
    return errorCode(error) !== "ESRCH";
  }
}

function newLockRecord(action: string, processIdentity: string): LockRecord {
  return {
    version: 1,
    ownerId: randomUUID(),
    pid: process.pid,
    processIdentity,
    action,
    acquiredAt: new Date().toISOString(),
  };
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

async function publishLock(paths: LockPaths, record: LockRecord): Promise<boolean> {
  const temporary = join(paths.directory, `.${record.ownerId}.tmp`);
  await writeFile(temporary, `${JSON.stringify(record)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  let published = false;
  let publishError: unknown;
  try {
    await link(temporary, paths.lock);
    published = true;
  } catch (error) {
    if (errorCode(error) !== "EEXIST") publishError = error;
  }

  try {
    await unlink(temporary);
  } catch (error) {
    if (published) await unlinkIfPresent(paths.lock);
    throw error;
  }
  if (publishError !== undefined) throw publishError;
  return published;
}

function sameLock(left: LockSnapshot, right: LockSnapshot): boolean {
  return left.device === right.device
    && left.inode === right.inode
    && left.record.ownerId === right.record.ownerId;
}

function liveOwnerError(campaignId: string, owner: LockRecord): Error {
  return new Error(
    `Campaign ${campaignId} is locked by live PID ${String(owner.pid)} for ${owner.action} since ${owner.acquiredAt}`,
  );
}

async function acquireLock(paths: LockPaths, campaignId: string, record: LockRecord): Promise<void> {
  if (await publishLock(paths, record)) return;

  const observed = await readLock(paths.lock);
  if (observed === undefined) {
    throw new Error(`Campaign ${campaignId} lock changed during acquisition; retry explicitly`);
  }
  if (await ownerIsLive(observed.record)) throw liveOwnerError(campaignId, observed.record);

  // Re-read immediately before removal. Ambiguous or replaced locks are never
  // reclaimed; the operator must retry as a separate explicit action.
  const current = await readLock(paths.lock);
  if (current === undefined || !sameLock(observed, current)) {
    throw new Error(`Campaign ${campaignId} lock changed during stale-owner inspection`);
  }
  if (await ownerIsLive(current.record)) throw liveOwnerError(campaignId, current.record);
  try {
    await unlink(paths.lock);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      throw new Error(`Campaign ${campaignId} lock changed during stale-owner reclaim`);
    }
    throw error;
  }

  if (!await publishLock(paths, record)) {
    const winner = await readLock(paths.lock);
    if (winner !== undefined && await ownerIsLive(winner.record)) {
      throw liveOwnerError(campaignId, winner.record);
    }
    throw new Error(`Campaign ${campaignId} lock was acquired during stale-owner reclaim`);
  }
}

async function releaseLock(paths: LockPaths, record: LockRecord): Promise<void> {
  const observed = await readLock(paths.lock);
  if (observed === undefined) return;
  if (observed.record.ownerId !== record.ownerId) {
    throw new Error("Campaign lock ownership changed; refusing to release another process's lock");
  }
  const current = await readLock(paths.lock);
  if (current === undefined) return;
  if (!sameLock(observed, current) || current.record.ownerId !== record.ownerId) {
    throw new Error("Campaign lock changed during release; refusing unsafe removal");
  }
  await unlink(paths.lock);
}

/**
 * Run one campaign action under a non-blocking, per-campaign filesystem lock.
 * A live owner is rejected immediately. A well-formed lock whose recorded
 * process is gone is reclaimed once; there is no wait loop or hidden retry.
 */
export async function withCampaignLock<T>(
  optimizerRoot: string,
  campaignId: string,
  action: string,
  fn: () => T | Promise<T>,
): Promise<T> {
  assertSafeAction(action);
  const paths = pathsFor(optimizerRoot, campaignId);
  await ensureLockDirectory(paths.directory);
  const record = newLockRecord(action, await currentProcessIdentity());
  await acquireLock(paths, campaignId, record);
  try {
    return await fn();
  } finally {
    await releaseLock(paths, record);
  }
}
