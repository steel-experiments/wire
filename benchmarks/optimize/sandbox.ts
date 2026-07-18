import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const UNIT_NAME = /^[A-Za-z0-9_.@-]{1,200}$/u;
const SAFE_PROPERTY_PATH = /^\/[A-Za-z0-9._/@+,=-]*$/u;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const STOP_TIMEOUT_MS = 2_000;
const CONTROL_ENVIRONMENT_NAMES = [
  "DBUS_SESSION_BUS_ADDRESS",
  "HOME",
  "LOGNAME",
  "USER",
  "XDG_RUNTIME_DIR",
] as const;
const FORBIDDEN_INNER_ENVIRONMENT_NAMES = new Set([
  "DBUS_SESSION_BUS_ADDRESS",
  "INVOCATION_ID",
  "LISTEN_FDNAMES",
  "LISTEN_FDS",
  "LISTEN_PID",
  "NOTIFY_SOCKET",
  "SYSTEMD_EXEC_PID",
  "XDG_RUNTIME_DIR",
]);

export interface SystemdSandboxRequest {
  command: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<NodeJS.ProcessEnv>;
  environmentNames: readonly string[];
  readOnlyPaths: readonly string[];
  readWritePaths: readonly string[];
  timeoutMs: number;
}

export interface SystemdSandboxTools {
  systemdRunPath: string;
  systemctlPath: string;
  nodePath: string;
  runnerPath: string;
  runtimeDirectory: string;
}

export interface BuiltSystemdSandboxInvocation {
  unitName: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export interface SystemdSandboxResult {
  unitName: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  wallMs: number;
}

export type SystemdSandboxSupport =
  | Readonly<{ supported: true }>
  | Readonly<{ supported: false; reason: string }>;

export class SystemdSandboxUnsupportedError extends Error {
  readonly code = "SYSTEMD_SANDBOX_UNSUPPORTED";

  constructor(reason: string) {
    super(`Systemd user-service sandbox is unsupported: ${reason}`);
    this.name = "SystemdSandboxUnsupportedError";
  }
}

const runnerPath = fileURLToPath(new URL("./sandbox-runner.cjs", import.meta.url));

function defaultRuntimeDirectory(): string {
  const declared = process.env.XDG_RUNTIME_DIR;
  if (declared !== undefined && isAbsolute(declared) && resolve(declared) === declared) return declared;
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  return uid === undefined ? "/run/user" : `/run/user/${String(uid)}`;
}

export const defaultSystemdSandboxTools: Readonly<SystemdSandboxTools> = Object.freeze({
  systemdRunPath: "/usr/bin/systemd-run",
  systemctlPath: "/usr/bin/systemctl",
  nodePath: process.execPath,
  runnerPath,
  runtimeDirectory: defaultRuntimeDirectory(),
});

async function resolveExecutable(name: string, environment: Readonly<NodeJS.ProcessEnv>): Promise<string> {
  const candidates = isAbsolute(name)
    ? [name]
    : (environment.PATH ?? "")
        .split(delimiter)
        .filter((entry) => isAbsolute(entry))
        .map((entry) => join(entry, name));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue through the controller's explicit PATH without a shell.
    }
  }
  throw new Error(`Required sandbox executable is unavailable: ${name}`);
}

/** Resolve the controller tools without a shell and return canonical absolute paths. */
export async function resolveSystemdSandboxTools(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<SystemdSandboxTools> {
  return {
    systemdRunPath: await resolveExecutable("systemd-run", environment),
    systemctlPath: await resolveExecutable("systemctl", environment),
    nodePath: await realpath(process.execPath),
    runnerPath: await realpath(runnerPath),
    runtimeDirectory: await realpath(defaultRuntimeDirectory()),
  };
}

function safeAbsolutePath(label: string, path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`${label} must be a normalized absolute path`);
  }
  if (!SAFE_PROPERTY_PATH.test(path)) {
    throw new Error(`${label} contains characters unsafe for a systemd path property`);
  }
  return path;
}

function safeArgument(argument: string): string {
  if (argument.includes("\0")) throw new Error("Sandbox command arguments cannot contain NUL");
  return argument;
}

function sortedUniquePaths(label: string, paths: readonly string[]): string[] {
  const normalized = paths.map((path) => safeAbsolutePath(label, path));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contains duplicate paths`);
  }
  return normalized.sort((left, right) => left.localeCompare(right));
}

function pathContains(parent: string, child: string): boolean {
  return parent === "/" || child === parent || child.startsWith(`${parent}/`);
}

function assertNoConflictingBinds(readOnlyPaths: readonly string[], readWritePaths: readonly string[]): void {
  for (const readOnly of readOnlyPaths) {
    for (const readWrite of readWritePaths) {
      if (pathContains(readOnly, readWrite) || pathContains(readWrite, readOnly)) {
        throw new Error(`Read-only and read-write sandbox paths overlap: ${readOnly}, ${readWrite}`);
      }
    }
  }
}

function environmentNames(request: SystemdSandboxRequest): string[] {
  const names = request.environmentNames.map((name) => {
    if (!ENVIRONMENT_NAME.test(name)) throw new Error(`Invalid sandbox environment name: ${name}`);
    if (
      FORBIDDEN_INNER_ENVIRONMENT_NAMES.has(name)
      || name.startsWith("DBUS_")
      || name.startsWith("SYSTEMD_")
    ) {
      throw new Error(`Sandbox environment cannot expose a controller activation channel: ${name}`);
    }
    if (request.environment[name] === undefined) {
      throw new Error(`Named sandbox environment variable is absent: ${name}`);
    }
    return name;
  });
  if (new Set(names).size !== names.length) {
    throw new Error("Sandbox environment names must be unique");
  }
  return names.sort((left, right) => left.localeCompare(right));
}

function launcherEnvironment(request: SystemdSandboxRequest, names: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CONTROL_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  for (const name of names) environment[name] = request.environment[name]!;
  return environment;
}

function generatedUnitName(): string {
  return `wire-opt-sandbox-${randomUUID().replaceAll("-", "")}`;
}

/**
 * Build the exact outer argv. Environment values exist only in the launcher's
 * environment; systemd receives name-only --setenv arguments.
 */
export function buildSystemdSandboxInvocation(
  request: SystemdSandboxRequest,
  options: Readonly<{
    tools?: Readonly<SystemdSandboxTools>;
    unitName?: string;
  }> = {},
): BuiltSystemdSandboxInvocation {
  const tools = options.tools ?? defaultSystemdSandboxTools;
  const unitName = options.unitName ?? generatedUnitName();
  if (!UNIT_NAME.test(unitName)) throw new Error(`Invalid transient unit name: ${unitName}`);
  if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new Error("Sandbox timeoutMs must be a positive safe integer");
  }

  const command = safeAbsolutePath("Sandbox command", request.command);
  const cwd = safeAbsolutePath("Sandbox cwd", request.cwd);
  const systemdRunPath = safeAbsolutePath("systemd-run path", tools.systemdRunPath);
  safeAbsolutePath("systemctl path", tools.systemctlPath);
  const nodePath = safeAbsolutePath("Sandbox Node path", tools.nodePath);
  const staticRunnerPath = safeAbsolutePath("Sandbox runner path", tools.runnerPath);
  const runtimeDirectory = safeAbsolutePath("Controller runtime directory", tools.runtimeDirectory);
  const names = environmentNames(request);
  const requestedReadOnly = sortedUniquePaths("Read-only sandbox path", request.readOnlyPaths);
  const readWritePaths = sortedUniquePaths("Read-write sandbox path", request.readWritePaths);
  assertNoConflictingBinds(requestedReadOnly, readWritePaths);
  for (const path of [cwd, command]) {
    if (pathContains(runtimeDirectory, path)) {
      throw new Error(`Sandbox path overlaps the inaccessible controller runtime directory: ${path}`);
    }
  }
  for (const path of [...requestedReadOnly, ...readWritePaths]) {
    if (pathContains(runtimeDirectory, path) || pathContains(path, runtimeDirectory)) {
      throw new Error(`Sandbox path overlaps the inaccessible controller runtime directory: ${path}`);
    }
  }

  const controlFiles = [...new Set([command, nodePath, staticRunnerPath])];
  for (const controlFile of controlFiles) {
    const mutableParent = readWritePaths.find((path) => pathContains(path, controlFile));
    if (mutableParent !== undefined) {
      throw new Error(`Sandbox control executable is inside a read-write bind: ${controlFile}`);
    }
  }
  const readOnlyPaths = [...new Set([...requestedReadOnly, ...controlFiles])]
    .sort((left, right) => left.localeCompare(right));

  const args = [
    "--user",
    "--quiet",
    "--wait",
    "--pipe",
    "--collect",
    "--no-ask-password",
    "--expand-environment=no",
    `--unit=${unitName}`,
    "--service-type=exec",
    "--working-directory=/",
    "--property=KillMode=control-group",
    `--property=RuntimeMaxSec=${String(request.timeoutMs)}ms`,
    "--property=ProtectSystem=strict",
    "--property=ProtectHome=tmpfs",
    "--property=PrivateTmp=yes",
    "--property=PrivateUsers=yes",
    "--property=NoNewPrivileges=yes",
    "--property=ProtectProc=ptraceable",
    "--property=ProcSubset=pid",
    "--property=TimeoutStopSec=2s",
    `--property=InaccessiblePaths=${runtimeDirectory}`,
    ...(readWritePaths.length === 0
      ? []
      : [`--property=BindPaths=${readWritePaths.join(" ")}`]),
    ...(readOnlyPaths.length === 0
      ? []
      : [`--property=BindReadOnlyPaths=${readOnlyPaths.join(" ")}`]),
    ...names.map((name) => `--setenv=${name}`),
    "--",
    nodePath,
    staticRunnerPath,
    "--cwd",
    cwd,
    ...names.flatMap((name) => ["--env", name]),
    "--",
    command,
    ...request.args.map(safeArgument),
  ];
  return {
    unitName,
    command: systemdRunPath,
    args,
    env: launcherEnvironment(request, names),
  };
}

interface Capture {
  chunks: Buffer[];
  bytes: number;
  truncated: boolean;
}

function appendCapture(capture: Capture, chunk: Buffer): void {
  const remaining = MAX_CAPTURE_BYTES - capture.bytes;
  if (remaining <= 0) {
    capture.truncated = true;
    return;
  }
  if (chunk.byteLength <= remaining) {
    capture.chunks.push(chunk);
    capture.bytes += chunk.byteLength;
    return;
  }
  capture.chunks.push(chunk.subarray(0, remaining));
  capture.bytes += remaining;
  capture.truncated = true;
}

function controlEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of CONTROL_ENVIRONMENT_NAMES) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

async function stopOwnedUnit(tools: Readonly<SystemdSandboxTools>, unitName: string): Promise<void> {
  await new Promise<void>((resolveStop) => {
    const child = spawn(tools.systemctlPath, ["--user", "stop", unitName], {
      env: controlEnvironment(),
      shell: false,
      stdio: "ignore",
      windowsHide: true,
    });
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveStop();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, STOP_TIMEOUT_MS);
    child.once("error", finish);
    child.once("close", finish);
  });
}

async function executeBuiltInvocation(
  launch: BuiltSystemdSandboxInvocation,
  tools: Readonly<SystemdSandboxTools>,
  timeoutMs: number,
): Promise<SystemdSandboxResult> {
  const started = performance.now();
  const stdout: Capture = { chunks: [], bytes: 0, truncated: false };
  const stderr: Capture = { chunks: [], bytes: 0, truncated: false };
  return new Promise<SystemdSandboxResult>((resolveResult, rejectResult) => {
    const child: ChildProcess = spawn(launch.command, launch.args, {
      env: launch.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout?.on("data", (chunk: Buffer) => appendCapture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendCapture(stderr, chunk));

    let timedOut = false;
    let cleanup: Promise<void> | undefined;
    const cleanUp = (): Promise<void> => {
      cleanup ??= stopOwnedUnit(tools, launch.unitName).finally(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      });
      return cleanup;
    };
    const watchdog = setTimeout(() => {
      timedOut = true;
      void cleanUp();
    }, timeoutMs + 250);

    let spawnFailed = false;
    child.once("error", (error) => {
      spawnFailed = true;
      clearTimeout(watchdog);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      if (spawnFailed) return;
      clearTimeout(watchdog);
      void (async () => {
        const wallMs = performance.now() - started;
        if (!timedOut && code !== 0 && wallMs + 25 >= timeoutMs) timedOut = true;
        if (timedOut) await cleanUp();
        resolveResult({
          unitName: launch.unitName,
          code,
          signal,
          stdout: Buffer.concat(stdout.chunks).toString("utf8"),
          stderr: Buffer.concat(stderr.chunks).toString("utf8"),
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
          timedOut,
          wallMs,
        });
      })().catch(rejectResult);
    });
  });
}

async function assertCanonicalExisting(path: string, mode: number, label: string): Promise<void> {
  await access(path, mode);
  const canonical = await realpath(path);
  if (canonical !== path) throw new Error(`${label} must not be a symbolic link: ${path}`);
}

async function assertHostInputs(
  request: SystemdSandboxRequest,
  tools: Readonly<SystemdSandboxTools>,
): Promise<void> {
  await Promise.all([
    assertCanonicalExisting(tools.systemdRunPath, fsConstants.X_OK, "systemd-run"),
    assertCanonicalExisting(tools.systemctlPath, fsConstants.X_OK, "systemctl"),
    assertCanonicalExisting(tools.nodePath, fsConstants.X_OK, "Sandbox Node"),
    assertCanonicalExisting(tools.runnerPath, fsConstants.R_OK, "Sandbox runner"),
    assertCanonicalExisting(tools.runtimeDirectory, fsConstants.R_OK, "Controller runtime directory"),
    assertCanonicalExisting(request.command, fsConstants.X_OK, "Sandbox command"),
    assertCanonicalExisting(request.cwd, fsConstants.R_OK | fsConstants.X_OK, "Sandbox cwd"),
    ...request.readOnlyPaths.map((path) => assertCanonicalExisting(path, fsConstants.R_OK, "Read-only bind")),
    ...request.readWritePaths.map((path) => assertCanonicalExisting(path, fsConstants.R_OK | fsConstants.W_OK, "Read-write bind")),
  ]);
  const cwdStat = await stat(request.cwd);
  if (!cwdStat.isDirectory()) throw new Error(`Sandbox cwd is not a directory: ${request.cwd}`);
}

function probeRequest(root: string, runtimeDirectory: string): SystemdSandboxRequest {
  const readOnly = join(root, "read-only");
  const readWrite = join(root, "read-write");
  const undeclared = join(root, "undeclared");
  const script = [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "function writes(directory) {",
    "  try { fs.writeFileSync(path.join(directory, 'probe'), 'probe'); return true; }",
    "  catch { return false; }",
    "}",
    "const [readOnly, readWrite, undeclared, runtimeDirectory] = process.argv.slice(1);",
    "let runtimeHidden = false;",
    "try { fs.accessSync(runtimeDirectory); } catch { runtimeHidden = true; }",
    "process.exit(!writes(readOnly) && writes(readWrite) && !writes(undeclared) && runtimeHidden ? 0 : 78);",
  ].join("\n");
  return {
    command: process.execPath,
    args: ["-e", script, readOnly, readWrite, undeclared, runtimeDirectory],
    cwd: "/",
    environment: {},
    environmentNames: [],
    readOnlyPaths: [readOnly],
    readWritePaths: [readWrite],
    timeoutMs: 2_000,
  };
}

function boundedReason(value: string): string {
  const singleLine = value.replaceAll(/[\r\n]+/gu, " ").trim();
  return singleLine === "" ? "probe exited unsuccessfully" : singleLine.slice(0, 500);
}

/** Verify behavior, not merely property acceptance, before trusting the user manager. */
export async function probeSystemdUserSandbox(
  tools: Readonly<SystemdSandboxTools> = defaultSystemdSandboxTools,
): Promise<SystemdSandboxSupport> {
  if (process.platform !== "linux") {
    return { supported: false, reason: `requires Linux, received ${process.platform}` };
  }
  let root: string | undefined;
  try {
    const home = process.env.HOME;
    if (home === undefined) throw new Error("Controller HOME is required for the sandbox probe");
    const canonicalHome = await realpath(safeAbsolutePath("Controller HOME", home));
    // Probe below the canonical home so ProtectHome=tmpfs must hide the
    // undeclared sibling while explicit binds re-expose only RO/RW roots.
    root = await mkdtemp(join(canonicalHome, ".wire-systemd-probe-"));
    await Promise.all([
      mkdir(join(root, "read-only")),
      mkdir(join(root, "read-write")),
      mkdir(join(root, "undeclared")),
    ]);
    const request = probeRequest(root, tools.runtimeDirectory);
    buildSystemdSandboxInvocation(request, { tools, unitName: generatedUnitName() });
    await assertHostInputs(request, tools);
    const launch = buildSystemdSandboxInvocation(request, { tools });
    const result = await executeBuiltInvocation(launch, tools, request.timeoutMs);
    if (result.code !== 0 || result.timedOut) {
      const detail = result.code === 78
        ? "filesystem or user-manager socket isolation was not enforced"
        : boundedReason(result.stderr || result.stdout);
      return {
        supported: false,
        reason: `required user manager or hardening properties unavailable (unprivileged user namespace prerequisite; ${detail}; status ${String(result.code)})`,
      };
    }
    return { supported: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { supported: false, reason: boundedReason(reason) };
  } finally {
    if (root !== undefined) await rm(root, { recursive: true, force: true });
  }
}

/** Own one transient unit, including bounded output capture and timeout cleanup. */
export async function runSystemdSandbox(
  request: SystemdSandboxRequest,
  tools: Readonly<SystemdSandboxTools> = defaultSystemdSandboxTools,
): Promise<SystemdSandboxResult> {
  const launch = buildSystemdSandboxInvocation(request, { tools });
  const support = await probeSystemdUserSandbox(tools);
  if (!support.supported) throw new SystemdSandboxUnsupportedError(support.reason);
  await assertHostInputs(request, tools);
  try {
    return await executeBuiltInvocation(launch, tools, request.timeoutMs);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new SystemdSandboxUnsupportedError(boundedReason(reason));
  }
}
