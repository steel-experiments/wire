import * as assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, it, type TestContext } from "node:test";

import {
  buildSystemdSandboxInvocation,
  defaultSystemdSandboxTools,
  probeSystemdUserSandbox,
  resolveSystemdSandboxTools,
  runSystemdSandbox,
  SystemdSandboxUnsupportedError,
  type SystemdSandboxRequest,
} from "./sandbox.js";

const roots: string[] = [];
let supportProbe: ReturnType<typeof probeSystemdUserSandbox> | undefined;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixtureRoot(): Promise<string> {
  assert.ok(process.env.HOME);
  const root = await mkdtemp(join(await realpath(process.env.HOME), ".wire-opt-sandbox-test-"));
  roots.push(root);
  return root;
}

async function requireSystemdSandbox(context: TestContext): Promise<boolean> {
  supportProbe ??= probeSystemdUserSandbox();
  const support = await supportProbe;
  if (support.supported) return true;
  context.skip(support.reason);
  return false;
}

function baseRequest(overrides: Partial<SystemdSandboxRequest> = {}): SystemdSandboxRequest {
  return {
    command: "/usr/bin/true",
    args: [],
    cwd: "/",
    environment: {},
    environmentNames: [],
    readOnlyPaths: [],
    readWritePaths: [],
    timeoutMs: 2_000,
    ...overrides,
  };
}

async function allFileText(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  const values: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) values.push(await allFileText(path));
    else if (entry.isFile()) values.push(await readFile(path, "utf8"));
  }
  return values.join("\n");
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe("systemd sandbox invocation boundary", () => {
  it("builds a hardened argument array without placing environment values in argv", () => {
    const secret = "sk-sandbox-secret-value-123456789";
    const unlisted = "bearer-unlisted-secret-value-123456789";
    const launch = buildSystemdSandboxInvocation(baseRequest({
      command: defaultSystemdSandboxTools.nodePath,
      args: ["--version"],
      environment: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        WIRE_SANDBOX_SECRET: secret,
        UNLISTED_SECRET: unlisted,
      },
      environmentNames: ["WIRE_SANDBOX_SECRET", "PATH"],
      readOnlyPaths: ["/tmp/wire-sandbox-readable"],
      readWritePaths: ["/tmp/wire-sandbox-writable"],
      timeoutMs: 1_234,
    }), {
      unitName: "wire-opt-sandbox-test-builder",
    });

    assert.equal(launch.command, "/usr/bin/systemd-run");
    assert.equal(launch.unitName, "wire-opt-sandbox-test-builder");
    for (const option of [
      "--user",
      "--quiet",
      "--wait",
      "--pipe",
      "--collect",
      "--expand-environment=no",
      "--property=KillMode=control-group",
      "--property=RuntimeMaxSec=1234ms",
      "--property=ProtectSystem=strict",
      "--property=ProtectHome=tmpfs",
      "--property=PrivateTmp=yes",
      "--property=PrivateUsers=yes",
      "--property=NoNewPrivileges=yes",
      "--property=ProtectProc=ptraceable",
      "--property=ProcSubset=pid",
      `--property=TemporaryFileSystem=${defaultSystemdSandboxTools.runtimeDirectory}:ro`,
      "--property=BindPaths=/tmp/wire-sandbox-writable",
      "--setenv=PATH",
      "--setenv=WIRE_SANDBOX_SECRET",
    ]) {
      assert.ok(launch.args.includes(option), `missing ${option}`);
    }
    assert.ok(launch.args.some((argument) => (
      argument.startsWith("--property=BindReadOnlyPaths=")
      && argument.split(" ").includes("/tmp/wire-sandbox-readable")
    )));
    assert.ok(!launch.args.some((argument) => argument.startsWith("--property=InaccessiblePaths=")));
    const serializedArgv = JSON.stringify([launch.command, ...launch.args]);
    assert.doesNotMatch(serializedArgv, new RegExp(secret, "u"));
    assert.doesNotMatch(serializedArgv, new RegExp(unlisted, "u"));
    assert.equal(launch.env.WIRE_SANDBOX_SECRET, secret);
    assert.equal(launch.env.UNLISTED_SECRET, undefined);

    const separator = launch.args.indexOf("--");
    assert.deepEqual(launch.args.slice(separator + 1, separator + 11), [
      defaultSystemdSandboxTools.nodePath,
      defaultSystemdSandboxTools.runnerPath,
      "--cwd",
      "/",
      "--env",
      "PATH",
      "--env",
      "WIRE_SANDBOX_SECRET",
      "--",
      defaultSystemdSandboxTools.nodePath,
    ]);
  });

  it("resolves controller tools to absolute canonical executables", async () => {
    const tools = await resolveSystemdSandboxTools({ PATH: process.env.PATH });
    assert.ok(tools.systemdRunPath.startsWith("/"));
    assert.ok(tools.systemctlPath.startsWith("/"));
    assert.ok(tools.nodePath.startsWith("/"));
    assert.ok(tools.runnerPath.startsWith("/"));
    assert.ok(tools.runtimeDirectory.startsWith("/"));
  });

  it("uses the static runner to filter the child environment and prepend the Node directory", () => {
    const secret = "sk-static-runner-secret-abcdefghijklmnopqrstuvwxyz";
    const unlisted = "bearer-static-runner-unlisted-abcdefghijklmnopqrstuvwxyz";
    const script = [
      "const path = require('node:path');",
      "process.stdout.write(JSON.stringify({",
      "  keys: Object.keys(process.env).sort(),",
      "  named: process.env.NAMED_SECRET !== undefined,",
      "  unlisted: process.env.UNLISTED_SECRET !== undefined,",
      "  pathHead: process.env.PATH.split(path.delimiter)[0]",
      "}));",
    ].join("\n");
    const args = [
      defaultSystemdSandboxTools.runnerPath,
      "--cwd",
      "/",
      "--env",
      "NAMED_SECRET",
      "--env",
      "PATH",
      "--",
      defaultSystemdSandboxTools.nodePath,
      "-e",
      script,
    ];
    const result = spawnSync(defaultSystemdSandboxTools.nodePath, args, {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        NAMED_SECRET: secret,
        UNLISTED_SECRET: unlisted,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(output.keys, ["NAMED_SECRET", "PATH"]);
    assert.equal(output.named, true);
    assert.equal(output.unlisted, false);
    assert.equal(output.pathHead, dirname(process.execPath));
    assert.doesNotMatch(JSON.stringify(args), new RegExp(secret, "u"));
    assert.doesNotMatch(result.stdout, new RegExp(secret, "u"));

    const forbidden = spawnSync(defaultSystemdSandboxTools.nodePath, [
      defaultSystemdSandboxTools.runnerPath,
      "--cwd",
      "/",
      "--env",
      "DBUS_SESSION_BUS_ADDRESS",
      "--",
      "/usr/bin/true",
    ], { encoding: "utf8" });
    assert.equal(forbidden.status, 125);
    assert.match(forbidden.stderr, /forbidden activation environment/u);
  });

  it("rejects ambiguous paths and fails closed when the user manager probe fails", async () => {
    assert.throws(() => buildSystemdSandboxInvocation(baseRequest({
      readOnlyPaths: ["/tmp/shared"],
      readWritePaths: ["/tmp/shared/output"],
    })), /paths overlap/u);
    assert.throws(() => buildSystemdSandboxInvocation(baseRequest({
      command: "node",
    })), /normalized absolute path/u);
    assert.throws(() => buildSystemdSandboxInvocation(baseRequest({
      environment: {},
      environmentNames: ["MISSING_SECRET"],
    })), /environment variable is absent/u);
    assert.throws(() => buildSystemdSandboxInvocation(baseRequest({
      environment: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" },
      environmentNames: ["DBUS_SESSION_BUS_ADDRESS"],
    })), /controller activation channel/u);
    assert.throws(() => buildSystemdSandboxInvocation(baseRequest({
      readWritePaths: [defaultSystemdSandboxTools.runtimeDirectory],
    })), /inaccessible controller runtime directory/u);

    await assert.rejects(
      runSystemdSandbox(baseRequest(), {
        ...defaultSystemdSandboxTools,
        systemdRunPath: "/usr/bin/false",
      }),
      (error: unknown) => {
        assert.ok(error instanceof SystemdSandboxUnsupportedError);
        assert.equal(error.code, "SYSTEMD_SANDBOX_UNSUPPORTED");
        assert.match(error.message, /required user manager or hardening properties unavailable/u);
        return true;
      },
    );
  });
});

describe("systemd sandbox local integration", () => {
  it("passes only named environment variables and never persists their values", async (context) => {
    if (!await requireSystemdSandbox(context)) return;
    const root = await fixtureRoot();
    const writable = join(root, "writable");
    await mkdir(writable);
    await writeFile(join(writable, "sentinel.txt"), "benign\n", "utf8");
    const secret = "sk-local-sandbox-secret-abcdefghijklmnopqrstuvwxyz";
    const unlisted = "bearer-local-unlisted-abcdefghijklmnopqrstuvwxyz";
    const script = [
      "const path = require('node:path');",
      "process.stdout.write(JSON.stringify({",
      "  keys: Object.keys(process.env).sort(),",
      "  namedPresent: process.env.WIRE_SANDBOX_SECRET !== undefined,",
      "  unlistedPresent: process.env.UNLISTED_SECRET !== undefined,",
      "  pathHead: (process.env.PATH || '').split(path.delimiter)[0]",
      "}));",
    ].join("\n");
    const result = await runSystemdSandbox(baseRequest({
      command: defaultSystemdSandboxTools.nodePath,
      args: ["-e", script],
      environment: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        WIRE_SANDBOX_SECRET: secret,
        UNLISTED_SECRET: unlisted,
      },
      environmentNames: ["PATH", "WIRE_SANDBOX_SECRET"],
      readWritePaths: [writable],
    }));

    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.timedOut, false);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.deepEqual(output.keys, ["PATH", "WIRE_SANDBOX_SECRET"]);
    assert.equal(output.namedPresent, true);
    assert.equal(output.unlistedPresent, false);
    assert.equal(output.pathHead, dirname(process.execPath));
    assert.doesNotMatch(result.stdout, new RegExp(secret, "u"));
    assert.doesNotMatch(result.stderr, new RegExp(secret, "u"));
    assert.doesNotMatch(await allFileText(root), new RegExp(secret, "u"));
    assert.doesNotMatch(await allFileText(root), new RegExp(unlisted, "u"));
  });

  it("enforces declared read-only and read-write host filesystem boundaries", async (context) => {
    if (!await requireSystemdSandbox(context)) return;
    const root = await fixtureRoot();
    const readOnly = join(root, "read-only");
    const readWrite = join(root, "read-write");
    const undeclared = join(root, "undeclared");
    await Promise.all([readOnly, readWrite, undeclared].map((path) => mkdir(path)));
    await writeFile(join(readOnly, "existing.txt"), "unchanged\n", "utf8");
    const script = [
      "const fs = require('node:fs');",
      "const path = require('node:path');",
      "const [readOnly, readWrite, undeclared] = process.argv.slice(1);",
      "function attempt(directory) {",
      "  try { fs.writeFileSync(path.join(directory, 'created.txt'), 'created'); return 'written'; }",
      "  catch (error) { return error && error.code || 'failed'; }",
      "}",
      "process.stdout.write(JSON.stringify({",
      "  readOnly: attempt(readOnly),",
      "  readWrite: attempt(readWrite),",
      "  undeclared: attempt(undeclared)",
      "}));",
    ].join("\n");
    const result = await runSystemdSandbox(baseRequest({
      command: defaultSystemdSandboxTools.nodePath,
      args: ["-e", script, readOnly, readWrite, undeclared],
      readOnlyPaths: [readOnly],
      readWritePaths: [readWrite],
    }));

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, string>;
    assert.notEqual(output.readOnly, "written");
    assert.equal(output.readWrite, "written");
    assert.notEqual(output.undeclared, "written");
    assert.equal(await readFile(join(readOnly, "existing.txt"), "utf8"), "unchanged\n");
    assert.equal(await readFile(join(readWrite, "created.txt"), "utf8"), "created");
    await assert.rejects(access(join(undeclared, "created.txt")));
  });

  it("kills detached descendants when the command exits", async (context) => {
    if (!await requireSystemdSandbox(context)) return;
    const root = await fixtureRoot();
    const writable = join(root, "writable");
    const marker = join(writable, "detached-survived.txt");
    await mkdir(writable);
    const descendant = [
      "const fs = require('node:fs');",
      "setTimeout(() => fs.writeFileSync(process.argv[1], 'survived'), 600);",
    ].join("\n");
    const parent = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], {",
      "  detached: true, stdio: 'ignore'",
      "});",
      "child.unref();",
    ].join("\n");
    const result = await runSystemdSandbox(baseRequest({
      command: defaultSystemdSandboxTools.nodePath,
      args: ["-e", parent, descendant, marker],
      readWritePaths: [writable],
    }));

    assert.equal(result.code, 0, result.stderr);
    await pause(900);
    await assert.rejects(access(marker));
  });

  it("cannot reach the user manager or launch an escaping transient service", async (context) => {
    if (!await requireSystemdSandbox(context)) return;
    const root = await fixtureRoot();
    const outsideMarker = join(root, "escaped-service-marker.txt");
    const unitName = `wire-opt-escape-test-${String(process.pid)}`;
    const script = [
      "const { spawnSync } = require('node:child_process');",
      "const [systemctl, systemdRun, unitName, marker] = process.argv.slice(1);",
      "const status = spawnSync(systemctl, ['--user', 'is-system-running'], { encoding: 'utf8' });",
      "const escape = spawnSync(systemdRun, [",
      "  '--user', '--quiet', `--unit=${unitName}`, '--collect', '--', '/usr/bin/touch', marker",
      "], { encoding: 'utf8' });",
      "process.stdout.write(JSON.stringify({ status: status.status, escape: escape.status }));",
    ].join("\n");
    const result = await runSystemdSandbox(baseRequest({
      command: defaultSystemdSandboxTools.nodePath,
      args: [
        "-e",
        script,
        defaultSystemdSandboxTools.systemctlPath,
        defaultSystemdSandboxTools.systemdRunPath,
        unitName,
        outsideMarker,
      ],
    }));

    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, number | null>;
    assert.notEqual(output.status, 0);
    assert.notEqual(output.escape, 0);
    await pause(200);
    await assert.rejects(access(outsideMarker));
  });

  it("stops and collects its unit on timeout without leaving descendants", async (context) => {
    if (!await requireSystemdSandbox(context)) return;
    const root = await fixtureRoot();
    const writable = join(root, "writable");
    const marker = join(writable, "timeout-survived.txt");
    await mkdir(writable);
    const descendant = [
      "const fs = require('node:fs');",
      "setTimeout(() => fs.writeFileSync(process.argv[1], 'survived'), 700);",
    ].join("\n");
    const parent = [
      "const { spawn } = require('node:child_process');",
      "const child = spawn(process.execPath, ['-e', process.argv[1], process.argv[2]], {",
      "  detached: true, stdio: 'ignore'",
      "});",
      "child.unref();",
      "setTimeout(() => {}, 10_000);",
    ].join("\n");
    const result = await runSystemdSandbox(baseRequest({
      command: defaultSystemdSandboxTools.nodePath,
      args: ["-e", parent, descendant, marker],
      readWritePaths: [writable],
      timeoutMs: 250,
    }));

    assert.equal(result.timedOut, true);
    assert.notEqual(result.code, 0);
    await pause(900);
    await assert.rejects(access(marker));
    const active = spawnSync(
      defaultSystemdSandboxTools.systemctlPath,
      ["--user", "is-active", result.unitName],
      { encoding: "utf8" },
    );
    assert.notEqual(active.status, 0, active.stdout);
  });
});
