"use strict";

const { spawn } = require("node:child_process");
const { delimiter, dirname, isAbsolute } = require("node:path");

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const FORBIDDEN_ENVIRONMENT_NAMES = new Set([
  "INVOCATION_ID",
  "LISTEN_FDNAMES",
  "LISTEN_FDS",
  "LISTEN_PID",
  "NOTIFY_SOCKET",
  "XDG_RUNTIME_DIR",
]);

function activationChannel(name) {
  return FORBIDDEN_ENVIRONMENT_NAMES.has(name)
    || name.startsWith("DBUS_")
    || name.startsWith("SYSTEMD_");
}

function fail(message) {
  process.stderr.write(`wire sandbox runner: ${message}\n`);
  process.exitCode = 125;
}

function parse(argv) {
  let cwd;
  const environmentNames = [];
  let index = 0;
  while (index < argv.length && argv[index] !== "--") {
    const argument = argv[index];
    if (argument === "--cwd") {
      if (cwd !== undefined || index + 1 >= argv.length) {
        throw new Error("expected exactly one --cwd value");
      }
      cwd = argv[index + 1];
      index += 2;
      continue;
    }
    if (argument === "--env") {
      const name = argv[index + 1];
      if (name === undefined || !ENVIRONMENT_NAME.test(name)) {
        throw new Error("invalid --env name");
      }
      if (activationChannel(name)) throw new Error(`forbidden activation environment: ${name}`);
      if (environmentNames.includes(name)) {
        throw new Error(`duplicate --env name: ${name}`);
      }
      environmentNames.push(name);
      index += 2;
      continue;
    }
    throw new Error(`unknown runner argument: ${String(argument)}`);
  }
  if (argv[index] !== "--") throw new Error("missing command separator");
  const command = argv[index + 1];
  if (cwd === undefined || !isAbsolute(cwd)) throw new Error("--cwd must be absolute");
  if (command === undefined || !isAbsolute(command)) throw new Error("command must be absolute");
  return { cwd, environmentNames, command, args: argv.slice(index + 2) };
}

function filteredEnvironment(names) {
  const environment = Object.create(null);
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  const executableDirectory = dirname(process.execPath);
  const inheritedPath = names.includes("PATH") ? process.env.PATH : undefined;
  const pathEntries = inheritedPath === undefined
    ? []
    : inheritedPath.split(delimiter).filter((entry) => entry !== "" && entry !== executableDirectory);
  environment.PATH = [executableDirectory, ...pathEntries].join(delimiter);
  return environment;
}

let invocation;
try {
  invocation = parse(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}

if (invocation !== undefined) {
  const child = spawn(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: filteredEnvironment(invocation.environmentNames),
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", (error) => fail(`failed to spawn command: ${error.message}`));
  child.once("exit", (code, signal) => {
    if (code !== null) {
      process.exitCode = code;
      return;
    }
    fail(`command exited from signal ${signal ?? "unknown"}`);
  });
}
