import * as assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  harnessOutputPath,
  type ChildInvocation,
  type ChildResult,
  type ChildRunner,
} from "./compare.js";
import {
  runCli,
  type CliContext,
  type CommandInvocation,
  type CommandRunner,
} from "./cli.js";
import type { ScoreSummary } from "./model.js";
import {
  SystemdSandboxUnsupportedError,
  type SystemdSandboxRequest,
} from "./sandbox.js";
import {
  listAttempts,
  loadCampaign,
  saveAttempt,
  saveCampaignState,
  sha256Path,
} from "./state.js";
import { spawnGit } from "./worktree.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  parent: string;
  repositoryRoot: string;
  optimizerRoot: string;
  recipePath: string;
  baseCommit: string;
  candidatePath: string;
  candidateCommit: string;
  changedFiles: string[];
  commandCalls: CommandInvocation[];
  compareCalls: ChildInvocation[];
  outputs: string[];
  context: CliContext;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await spawnGit({ cwd, args });
  if (result.code !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

function successfulChild(wallMs: number): ChildResult {
  return {
    code: 0,
    signal: null,
    stdout: "fixture output is ignored",
    stderr: "",
    timedOut: false,
    wallMs,
  };
}

function passingScore(pairedSlots: number): ScoreSummary {
  return {
    pairedSlots,
    baseSuccesses: 0,
    candidateSuccesses: pairedSlots,
    successDelta: pairedSlots,
    meanBaseJudge: 0.25,
    meanCandidateJudge: 0.75,
    meanJudgeDelta: 0.5,
    taskVarianceBase: 0,
    taskVarianceCandidate: 0,
    baseMedianWallMs: 80,
    candidateMedianWallMs: 70,
    baseP90WallMs: 80,
    candidateP90WallMs: 70,
    baseFailures: pairedSlots,
    candidateFailures: 0,
    scorable: true,
  };
}

function flag(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return args[index + 1]!;
}

function fakeCompareRunner(
  basePath: string,
  candidatePath: string,
  calls: ChildInvocation[],
): ChildRunner {
  let sequence = 0;
  const objectives = new Map([
    ["task-a", "Return A"],
    ["task-b", "Return B"],
    ["sealed-secret-task", "Never reveal this prompt"],
  ]);
  return async (invocation) => {
    calls.push(invocation);
    if (invocation.kind === "install") return successfulChild(2);
    if (invocation.kind === "build") {
      await write(join(invocation.cwd, "dist", "index.js"), "// offline fixture build\n");
      return successfulChild(5);
    }

    sequence += 1;
    const taskId = flag(invocation.args, "--tasks");
    const stamp = flag(invocation.args, "--stamp");
    const output = harnessOutputPath(invocation.cwd, stamp);
    const wireRoot = invocation.env.WIRE_ROOT!;
    const runId = `run_cli-${sequence}`;
    const candidateArm = invocation.cwd === candidatePath;
    assert.ok(invocation.cwd === basePath || candidateArm);
    const judgeScore = candidateArm ? 0.95 : 0.4;
    const answer = candidateArm ? "A" : "not complete";
    const classification = candidateArm ? "task-complete" : "ambiguous";
    await write(join(wireRoot, "runs", `${runId}.json`), JSON.stringify({
      id: runId,
      taskId: "task_fixture",
      status: "succeeded",
      result: answer,
      classification: { kind: classification, confidence: 0.9 },
    }));
    await write(output, `${JSON.stringify({
      task: taskId,
      objective: objectives.get(taskId),
      arm: "wire",
      rep: 1,
      ok: true,
      wallMs: candidateArm ? 70 : 80,
      judgeScore,
      success: candidateArm,
      answer,
      native: {
        runId,
        status: "succeeded",
        classification,
        confidence: 0.9,
        summary: candidateArm ? "done" : "stalled",
        provider: "anthropic",
        model: "wire-model",
        costUsd: null,
      },
    })}\n`);
    return successfulChild(100);
  };
}

function tickingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 17, 12, 0, tick++));
}

async function fixture(options: { mutateRecipeDuringInit?: boolean } = {}): Promise<Fixture> {
  const parent = await mkdtemp(join(tmpdir(), "wire-opt-cli-"));
  roots.push(parent);
  const repositoryRoot = join(parent, "repository");
  await mkdir(repositoryRoot);
  await git(repositoryRoot, ["init", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.name", "Wire Optimizer Test"]);
  await git(repositoryRoot, ["config", "user.email", "optimizer@example.invalid"]);
  await write(join(repositoryRoot, ".gitignore"), [
    ".wire/",
    "dist/",
    "node_modules/",
    "benchmarks/compare/results/",
    "",
  ].join("\n"));
  await write(join(repositoryRoot, "src", "core.ts"), "export const value = 1;\n");
  await write(join(repositoryRoot, "src", "core.test.ts"), "export const tested = true;\n");
  await write(join(repositoryRoot, "benchmarks", "compare", "run-compare.ts"), "export {};\n");
  const suitePath = join(repositoryRoot, "benchmarks", "fixture-suite.json");
  await write(suitePath, JSON.stringify([
    { id: "task-a", objective: "Return A", maxSteps: 2 },
    { id: "task-b", objective: "Return B", maxSteps: 2 },
  ]));
  const skillPath = join(repositoryRoot, "skills");
  await write(join(skillPath, "site.md"), "# Offline fixture skill\n");
  await write(join(repositoryRoot, "package.json"), "{\"private\":true}\n");
  await write(join(repositoryRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await git(repositoryRoot, ["add", "-A"]);
  await git(repositoryRoot, ["commit", "-m", "fixture base"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);

  const holdoutPath = join(parent, "sealed-holdout-do-not-packetize.json");
  await write(holdoutPath, JSON.stringify([
    { id: "sealed-secret-task", objective: "Never reveal this prompt", maxSteps: 2 },
  ]));
  const recipePath = join(parent, "recipe.json");
  await write(recipePath, JSON.stringify({
    version: 1,
    id: "cli-campaign",
    baseCommit,
    suite: { path: suitePath, sha256: await sha256Path(suitePath) },
    judge: { model: "judge-model", threshold: 0.7 },
    wire: { provider: "anthropic", model: "wire-model", timeoutMs: 10_000 },
    cohorts: {
      smoke: { taskIds: ["task-a"], pairedSlots: 1 },
      targeted: { taskIds: ["task-a"], pairedSlots: 2 },
      broad: { taskIds: ["task-a", "task-b"], pairedSlots: 2 },
      holdout: {
        externalSuitePath: holdoutPath,
        sha256: await sha256Path(holdoutPath),
        slots: 1,
      },
    },
    budget: {
      maxPhysicalRuns: 20,
      maxCandidates: 1,
      maxWallClockMs: 1_000_000,
      maxConcurrency: 1,
    },
    skillSnapshot: { path: skillPath, sha256: await sha256Path(skillPath) },
    seed: "offline-cli-seed",
    gates: {
      minimumTargetedSuccessDelta: 2,
      minimumMeanJudgeDelta: 0.05,
      maxSimplificationJudgeRegression: 0.02,
      maxSmokeSuccessRegression: 0,
      maxBroadSuccessRegression: 0,
    },
  }, null, 2));

  const optimizerRoot = join(repositoryRoot, ".wire", "optimizer");
  const commandCalls: CommandInvocation[] = [];
  const commandRunner: CommandRunner = async (invocation) => {
    commandCalls.push(invocation);
    return { code: 0, signal: null, stdout: "ok", stderr: "", timedOut: false, wallMs: 3 };
  };
  const compareCalls: ChildInvocation[] = [];
  const outputs: string[] = [];
  const context: CliContext = {
    repositoryRoot,
    optimizerRoot,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(parent, "fixture-home"),
      STEEL_API_KEY: "fixture-steel-key",
      ANTHROPIC_API_KEY: "fixture-anthropic-key",
    },
    now: tickingClock(),
    pnpmCommand: "pnpm",
    commandRunner,
    write: (text) => outputs.push(text),
  };

  if (options.mutateRecipeDuringInit === true) {
    let mutated = false;
    context.gitRunner = async (request) => {
      if (!mutated) {
        mutated = true;
        const changed = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, unknown>;
        changed.id = "swapped-campaign";
        await writeFile(recipePath, JSON.stringify(changed), "utf8");
      }
      return spawnGit(request);
    };
  }

  assert.equal(await runCli(["init", "--campaign", recipePath, "--base", "HEAD"], context), 0);
  const initialized = await loadCampaign(optimizerRoot, "cli-campaign");
  const basePath = join(initialized.paths.worktrees, "base");

  const candidatePath = join(parent, "candidate");
  await git(repositoryRoot, ["worktree", "add", "-b", "candidate", candidatePath, baseCommit]);
  await write(join(candidatePath, "src", "core.ts"), "export const value = 2;\n");
  await write(join(candidatePath, "src", "core.test.ts"), "export const tested = 'updated';\n");
  await git(candidatePath, ["add", "-A"]);
  await git(candidatePath, ["commit", "-m", "candidate improvement"]);
  const candidateCommit = await git(candidatePath, ["rev-parse", "HEAD"]);
  context.compareRunner = fakeCompareRunner(
    basePath,
    join(initialized.paths.worktrees, "candidates", "candidate-1"),
    compareCalls,
  );
  return {
    parent,
    repositoryRoot,
    optimizerRoot,
    recipePath,
    baseCommit,
    candidatePath,
    candidateCommit,
    changedFiles: ["src/core.test.ts", "src/core.ts"],
    commandCalls,
    compareCalls,
    outputs,
    context,
  };
}

async function ingestFixtureCandidate(f: Fixture): Promise<Awaited<ReturnType<typeof loadCampaign>>> {
  assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
  let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
  const responsePath = join(campaign.paths.packets, "0001-response.json");
  await write(responsePath, JSON.stringify({
    version: 1,
    campaignId: "cli-campaign",
    requestId: campaign.state.pendingPacket!.requestId,
    candidateId: "candidate-1",
    baseCommit: f.baseCommit,
    worktreePath: f.candidatePath,
    candidateCommit: f.candidateCommit,
    hypothesis: "A small site-independent change improves the frozen failure.",
    recommendedHome: "core",
    changedFiles: f.changedFiles,
    testsRun: ["untrusted self-report"],
  }));
  assert.equal(await runCli([
    "ingest", "--campaign", "cli-campaign", "--response", responsePath,
  ], f.context), 0);
  campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
  return campaign;
}

async function advanceFixtureCandidateToHoldout(
  f: Fixture,
): Promise<Awaited<ReturnType<typeof loadCampaign>>> {
  await evaluateFixtureCandidateTargeted(f);
  assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
  assert.equal(await runCli([
    "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "smoke",
  ], f.context), 0);
  assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
  assert.equal(await runCli([
    "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "broad",
  ], f.context), 0);
  assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
  return loadCampaign(f.optimizerRoot, "cli-campaign");
}

async function evaluateFixtureCandidateTargeted(
  f: Fixture,
): Promise<Awaited<ReturnType<typeof loadCampaign>>> {
  await ingestFixtureCandidate(f);
  assert.equal(await runCli([
    "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "targeted",
  ], f.context), 0);
  return loadCampaign(f.optimizerRoot, "cli-campaign");
}

describe("optimizer CLI argument boundary", () => {
  it("rejects unknown, duplicate, positional, and invalid cohort arguments", async () => {
    await assert.rejects(runCli([]), /Missing command/u);
    await assert.rejects(runCli(["--", "status"]), /Missing required option for status/u);
    await assert.rejects(runCli(["status", "--campaign", "a", "--campaign", "b"]), /Duplicate option/u);
    await assert.rejects(runCli(["next", "campaign"]), /Unexpected argument/u);
    await assert.rejects(
      runCli(["evaluate", "--campaign", "a", "--candidate", "b", "--cohort", "holdout"]),
      /targeted, smoke, or broad/u,
    );
  });
});

describe("offline campaign lifecycle", () => {
  it("uses one immutable recipe read for lock selection and initialization", async () => {
    const f = await fixture({ mutateRecipeDuringInit: true });
    const campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.spec.id, "cli-campaign");
    await assert.rejects(loadCampaign(f.optimizerRoot, "swapped-campaign"), /Campaign not found/u);
  });

  it("routes default verification through a scrubbed systemd sandbox and removes its offline home", async () => {
    const f = await fixture();
    const sandboxCalls: SystemdSandboxRequest[] = [];
    const trustedBin = join(f.parent, "trusted-bin");
    await mkdir(trustedBin);
    await symlink(process.execPath, join(trustedBin, "tsx"));
    const { commandRunner: _commandRunner, ...defaultContext } = f.context;
    const context: CliContext = {
      ...defaultContext,
      // The relative entry resolves to this repository's executable tsx shim.
      // Only the absolute controller directory may participate in resolution.
      env: { ...defaultContext.env, PATH: `node_modules/.bin${delimiter}${trustedBin}` },
      pnpmCommand: "tsx",
      systemdSandboxRunner: async (request) => {
        sandboxCalls.push(request);
        return {
          unitName: `fixture-unit-${String(sandboxCalls.length)}`,
          code: 0,
          signal: null,
          stdout: "ok",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          timedOut: false,
          wallMs: 3,
        };
      },
    };

    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], context), 0);
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const responsePath = join(campaign.paths.packets, "0001-response.json");
    await write(responsePath, JSON.stringify({
      version: 1,
      campaignId: "cli-campaign",
      requestId: campaign.state.pendingPacket!.requestId,
      candidateId: "candidate-1",
      baseCommit: f.baseCommit,
      worktreePath: f.candidatePath,
      candidateCommit: f.candidateCommit,
      hypothesis: "Verify the candidate in a controller-owned offline sandbox.",
      recommendedHome: "core",
      changedFiles: f.changedFiles,
      testsRun: ["untrusted self-report"],
    }));
    assert.equal(await runCli([
      "ingest", "--campaign", "cli-campaign", "--response", responsePath,
    ], context), 0);

    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const candidateRoot = join(campaign.paths.worktrees, "candidates", "candidate-1");
    const canonicalCommand = await realpath(process.execPath);
    assert.deepEqual(sandboxCalls.map((call) => call.args), [
      ["install", "--frozen-lockfile"],
      ["check"],
      ["optimize:test"],
    ]);
    assert.ok(sandboxCalls.every((call) => call.command === canonicalCommand));
    assert.ok(sandboxCalls.every((call) => call.cwd === candidateRoot));
    assert.ok(sandboxCalls.every((call) => call.readOnlyPaths.length === 0));
    const verificationHome = sandboxCalls[0]!.environment.HOME!;
    assert.ok(verificationHome.startsWith(`${campaign.paths.root}/offline-home-`));
    assert.ok(sandboxCalls.every((call) => (
      call.environment.HOME === verificationHome
      && call.environment.PATH === undefined
      && call.environment.WIRE_HOME === undefined
      && call.environment.WIRE_ROOT === undefined
      && call.environment.WIRE_SKILLS === undefined
      && call.environment.STEEL_API_KEY === undefined
      && call.environment.ANTHROPIC_API_KEY === undefined
      && call.readWritePaths[0] === candidateRoot
      && call.readWritePaths[1] === verificationHome
    )));
    assert.ok(sandboxCalls.every((call) => (
      JSON.stringify(call.environmentNames)
      === JSON.stringify(["CI", "HOME", "NO_COLOR"])
    )));
    await assert.rejects(realpath(verificationHome), { code: "ENOENT" });
  });

  it("keeps an explicitly injected verification runner outside the sandbox seam", async () => {
    const f = await fixture();
    let sandboxCalls = 0;
    f.context.systemdSandboxRunner = async () => {
      sandboxCalls += 1;
      throw new Error("systemd sandbox seam should not run");
    };
    const campaign = await ingestFixtureCandidate(f);
    assert.equal(campaign.state.candidates["candidate-1"]?.status, "ingested");
    assert.equal(sandboxCalls, 0);
    assert.deepEqual(f.commandCalls.map((call) => call.command), ["pnpm", "pnpm", "pnpm"]);
  });

  it("stops after the first failed required candidate check", async () => {
    const f = await fixture();
    const calls: string[] = [];
    f.context.commandRunner = async (invocation) => {
      const script = invocation.args[0]!;
      calls.push(script);
      return {
        code: script === "check" ? 1 : 0,
        signal: null,
        stdout: "fixture output",
        stderr: "",
        timedOut: false,
        wallMs: 3,
      };
    };
    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const responsePath = join(campaign.paths.packets, "0001-response.json");
    await write(responsePath, JSON.stringify({
      version: 1,
      campaignId: "cli-campaign",
      requestId: campaign.state.pendingPacket!.requestId,
      candidateId: "candidate-1",
      baseCommit: f.baseCommit,
      worktreePath: f.candidatePath,
      candidateCommit: f.candidateCommit,
      hypothesis: "Reject a candidate whose required check fails.",
      recommendedHome: "core",
      changedFiles: f.changedFiles,
      testsRun: [],
    }));
    assert.equal(await runCli([
      "ingest", "--campaign", "cli-campaign", "--response", responsePath,
    ], f.context), 1);

    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const record = campaign.state.candidates["candidate-1"]!;
    assert.deepEqual(calls, ["install", "check"]);
    assert.deepEqual(record.verifiedTests, []);
    assert.match(record.rejectionReasons.join("\n"), /pnpm check failed/u);
    assert.equal(campaign.state.inFlight, undefined);
  });

  it("fails closed and cleans the offline home when the systemd sandbox is unsupported", async () => {
    const f = await fixture();
    let attemptedRequest: SystemdSandboxRequest | undefined;
    const { commandRunner: _commandRunner, ...defaultContext } = f.context;
    const context: CliContext = {
      ...defaultContext,
      pnpmCommand: process.execPath,
      systemdSandboxRunner: async (request) => {
        attemptedRequest = request;
        throw new SystemdSandboxUnsupportedError("fixture user manager unavailable");
      },
    };
    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], context), 0);
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const responsePath = join(campaign.paths.packets, "0001-response.json");
    await write(responsePath, JSON.stringify({
      version: 1,
      campaignId: "cli-campaign",
      requestId: campaign.state.pendingPacket!.requestId,
      candidateId: "candidate-1",
      baseCommit: f.baseCommit,
      worktreePath: f.candidatePath,
      candidateCommit: f.candidateCommit,
      hypothesis: "Fail closed when candidate verification cannot be isolated.",
      recommendedHome: "core",
      changedFiles: f.changedFiles,
      testsRun: [],
    }));
    await assert.rejects(
      runCli(["ingest", "--campaign", "cli-campaign", "--response", responsePath], context),
      /Systemd user-service sandbox is unsupported/u,
    );

    assert.ok(attemptedRequest !== undefined);
    const verificationHome = attemptedRequest.environment.HOME!;
    await assert.rejects(realpath(verificationHome), { code: "ENOENT" });
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(campaign.state.inFlight, undefined);
    assert.match(campaign.state.stopReason!, /Systemd user-service sandbox is unsupported/u);
    assert.equal(campaign.state.candidates["candidate-1"]?.status, "rejected");
  });

  it("revalidates candidate provenance after each verification command", async () => {
    const f = await fixture();
    let commandCalls = 0;
    f.context.commandRunner = async (invocation) => {
      commandCalls += 1;
      await write(join(invocation.cwd, "src", "core.ts"), "export const value = 'tampered';\n");
      return { code: 0, signal: null, stdout: "ok", stderr: "", timedOut: false, wallMs: 3 };
    };

    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const responsePath = join(campaign.paths.packets, "0001-response.json");
    await write(responsePath, JSON.stringify({
      version: 1,
      campaignId: "cli-campaign",
      requestId: campaign.state.pendingPacket!.requestId,
      candidateId: "candidate-1",
      baseCommit: f.baseCommit,
      worktreePath: f.candidatePath,
      candidateCommit: f.candidateCommit,
      hypothesis: "Reject verification that mutates its checked-out candidate.",
      recommendedHome: "core",
      changedFiles: f.changedFiles,
      testsRun: [],
    }));
    assert.equal(await runCli([
      "ingest", "--campaign", "cli-campaign", "--response", responsePath,
    ], f.context), 1);

    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(commandCalls, 1);
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(campaign.state.inFlight, undefined);
    assert.match(campaign.state.stopReason!, /candidate provenance changed during pnpm install/u);
    assert.match(
      campaign.state.candidates["candidate-1"]!.rejectionReasons.join("\n"),
      /Worktree is not clean/u,
    );
  });

  it("runs init -> next -> ingest -> evaluate -> next, resumes, and rejects a stale response", async () => {
    const f = await fixture();
    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const firstPacket = campaign.state.pendingPacket;
    assert.ok(firstPacket);
    const packetText = await readFile(firstPacket.path, "utf8");
    assert.doesNotMatch(packetText, /sealed-holdout|sealed-secret-task|Never reveal this prompt/u);

    const responsePath = join(campaign.paths.packets, "0001-response.json");
    await write(responsePath, JSON.stringify({
      version: 1,
      campaignId: "cli-campaign",
      requestId: firstPacket.requestId,
      candidateId: "candidate-1",
      baseCommit: f.baseCommit,
      worktreePath: f.candidatePath,
      candidateCommit: f.candidateCommit,
      hypothesis: "A small site-independent change improves the frozen failure.",
      recommendedHome: "core",
      changedFiles: f.changedFiles,
      testsRun: ["not trusted self-report"],
    }));
    assert.equal(await runCli([
      "ingest", "--campaign", "cli-campaign", "--response", responsePath,
    ], f.context), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const ingested = campaign.state.candidates["candidate-1"]!;
    assert.equal(ingested.status, "ingested");
    assert.deepEqual(ingested.verifiedTests, ["pnpm check", "pnpm optimize:test"]);
    assert.deepEqual(ingested.existingTestFilesChanged, ["src/core.test.ts"]);
    assert.match(ingested.reviewWarnings[0]!, /human review required/u);
    assert.deepEqual(f.commandCalls.map((call) => [call.command, call.args]), [
      ["pnpm", ["install", "--frozen-lockfile"]],
      ["pnpm", ["check"]],
      ["pnpm", ["optimize:test"]],
    ]);
    assert.ok(f.commandCalls.every((call) => (
      call.cwd === join(campaign.paths.worktrees, "candidates", "candidate-1")
    )));
    assert.ok(f.commandCalls.every((call) => call.cwd !== f.candidatePath));
    assert.ok(f.commandCalls.every((call) => (
      call.env.STEEL_API_KEY === undefined
      && call.env.ANTHROPIC_API_KEY === undefined
      && call.env.HOME?.startsWith(f.optimizerRoot) === true
    )));
    assert.equal(campaign.state.pendingPacket?.requestId, "request-0002");
    assert.match(
      await readFile(campaign.state.pendingPacket!.path, "utf8"),
      /evaluate-targeted/u,
    );

    assert.equal(await runCli([
      "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "targeted",
    ], f.context), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.candidates["candidate-1"]!.status, "survives-targeted");
    assert.equal(campaign.state.candidates["candidate-1"]!.scores.targeted?.successDelta, 2);
    assert.equal(campaign.state.physicalRunsUsed, 4);
    assert.equal(f.compareCalls.filter((call) => call.kind === "compare").length, 4);
    const attempts = await readFile(join(campaign.paths.attempts, campaign.state.completedSlots[0] + ".json"), "utf8");
    assert.match(attempts, /"wireRoot"/u);

    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.packetSequence, 3);
    assert.equal(campaign.state.pendingPacket?.requestId, "request-0003");
    const secondPacketPath = campaign.state.pendingPacket!.path;
    const secondPacketText = await readFile(secondPacketPath, "utf8");
    assert.match(secondPacketText, /evaluate-smoke/u);
    assert.doesNotMatch(secondPacketText, /sealed-holdout|sealed-secret-task|Never reveal this prompt/u);

    // A fresh context simulates a new controller process. `next` recovers the
    // same unanswered packet instead of emitting a duplicate sequence.
    const restarted: CliContext = { ...f.context, write: (text) => f.outputs.push(text) };
    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], restarted), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.packetSequence, 3);
    assert.equal(campaign.state.pendingPacket?.path, secondPacketPath);

    await assert.rejects(
      runCli(["ingest", "--campaign", "cli-campaign", "--response", responsePath], restarted),
      /stale or altered/u,
    );

    assert.equal(await runCli([
      "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "smoke",
    ], restarted), 0);
    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], restarted), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.pendingPacket?.requestId, "request-0004");
    assert.match(await readFile(campaign.state.pendingPacket!.path, "utf8"), /evaluate-broad/u);

    assert.equal(await runCli([
      "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "broad",
    ], restarted), 0);
    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], restarted), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.pendingPacket?.requestId, "request-0005");
    const holdoutPacket = await readFile(campaign.state.pendingPacket!.path, "utf8");
    assert.match(holdoutPacket, /run-holdout/u);
    assert.doesNotMatch(holdoutPacket, /sealed-holdout|sealed-secret-task|Never reveal this prompt/u);

    assert.equal(await runCli([
      "holdout", "--campaign", "cli-campaign", "--candidate", "candidate-1",
    ], restarted), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.candidates["candidate-1"]!.status, "recommend-promote");
    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], restarted), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const stopPacket = await readFile(campaign.state.pendingPacket!.path, "utf8");
    assert.match(stopPacket, /"action": "stop"/u);
    assert.doesNotMatch(stopPacket, /sealed-holdout|sealed-secret-task|Never reveal this prompt/u);
    assert.doesNotMatch(f.outputs.join("\n"), /sealed-holdout|sealed-secret-task|Never reveal this prompt/u);
    const finalReport = await readFile(
      join(campaign.paths.reports, `${String(campaign.state.packetSequence).padStart(4, "0")}-action.md`),
      "utf8",
    );
    assert.match(finalReport, /Isolated run roots/u);
    assert.match(finalReport, /WIRE_ROOT/u);
    assert.match(finalReport, /WIRE_SKILLS/u);
    assert.match(finalReport, /sealed-holdout roots? withheld/u);
    assert.doesNotMatch(finalReport, /sealed-secret-task|Never reveal this prompt/u);

    const statusOutput: string[] = [];
    assert.equal(await runCli(
      ["status", "--campaign", "cli-campaign", "--json"],
      { ...restarted, write: (text) => statusOutput.push(text) },
    ), 0);
    assert.equal(JSON.parse(statusOutput.join(""))?.campaignId, "cli-campaign");
  });

  it("runs base-vs-base calibration without creating a candidate", async () => {
    const f = await fixture();
    assert.equal(await runCli(["baseline", "--campaign", "cli-campaign"], f.context), 0);
    const campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.physicalRunsUsed, 2);
    assert.equal(campaign.state.candidatesUsed, 0);
    assert.deepEqual(campaign.state.candidates, {});
    const compareCwds = f.compareCalls.filter((call) => call.kind === "compare").map((call) => call.cwd);
    assert.equal(new Set(compareCwds).size, 1);
    const callsBeforeRepeat = f.compareCalls.length;
    await assert.rejects(
      runCli(["baseline", "--campaign", "cli-campaign"], f.context),
      /fresh initialized campaign/u,
    );
    assert.equal(f.compareCalls.length, callsBeforeRepeat);
  });

  it("resumes baseline calibration from a stale partial compare without duplicating finished work", async () => {
    const f = await fixture();
    assert.equal(await runCli(["baseline", "--campaign", "cli-campaign"], f.context), 0);
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const [attempt] = await listAttempts(campaign.paths);
    assert.ok(attempt);
    const [finished, interrupted] = attempt.results;
    assert.ok(finished);
    assert.ok(interrupted);
    const finishedRunId = finished.runId;

    await Promise.all([
      rm(interrupted.wireRoot, { recursive: true, force: true }),
      rm(interrupted.skillRoot, { recursive: true, force: true }),
      rm(interrupted.harnessOutputPath, { force: true }),
    ]);
    await saveAttempt(campaign.paths, {
      ...attempt,
      results: [finished],
      complete: false,
    });
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      phase: "evaluating",
      physicalRunsUsed: 1,
      wallClockMsUsed: campaign.state.buildWallClockMsUsed + finished.subprocess.wallMs,
      completedSlots: [],
      inFlight: {
        kind: "compare",
        commit: finished.commit,
        startedAt: finished.startedAt,
        slotId: attempt.slotId,
        arm: finished.arm,
      },
    });
    const callsBeforeResume = f.compareCalls.filter((call) => call.kind === "compare").length;

    assert.equal(await runCli(["baseline", "--campaign", "cli-campaign"], f.context), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "initialized");
    assert.equal(campaign.state.physicalRunsUsed, 2);
    assert.equal(campaign.state.inFlight, undefined);
    assert.equal(campaign.state.completedSlots.length, 1);
    assert.equal(
      f.compareCalls.filter((call) => call.kind === "compare").length,
      callsBeforeResume + 1,
    );
    const [resumed] = await listAttempts(campaign.paths);
    assert.equal(resumed?.complete, true);
    assert.equal(resumed?.results[0]?.runId, finishedRunId);
  });

  it("rejects baseline behind a packet and cleanup before a terminal state", async () => {
    const f = await fixture();
    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
    await assert.rejects(
      runCli(["baseline", "--campaign", "cli-campaign"], f.context),
      /fresh initialized campaign/u,
    );
    await assert.rejects(
      runCli(["cleanup", "--campaign", "cli-campaign"], f.context),
      /Cleanup requires a stopped campaign/u,
    );
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      phase: "stopped",
      stopReason: "fixture terminal state",
      inFlight: {
        kind: "install",
        commit: f.baseCommit,
        startedAt: "2026-07-17T12:00:00.000Z",
      },
    });
    await assert.rejects(
      runCli(["cleanup", "--campaign", "cli-campaign"], f.context),
      /no in-flight work/u,
    );
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    await saveCampaignState(campaign.paths, { ...campaign.state, inFlight: undefined });
    assert.equal(await runCli(["cleanup", "--campaign", "cli-campaign"], f.context), 0);
    assert.equal(f.compareCalls.length, 0);
  });

  it("acknowledges a provenance rejection instead of stranding its evaluate packet", async () => {
    const f = await fixture();
    let campaign = await ingestFixtureCandidate(f);
    const evaluationPath = join(campaign.paths.worktrees, "candidates", "candidate-1");
    await write(join(evaluationPath, "src", "core.ts"), "export const value = 'dirty';\n");

    await assert.rejects(
      runCli([
        "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "targeted",
      ], f.context),
      /Candidate provenance changed before evaluation.*Worktree is not clean/u,
    );
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.candidates["candidate-1"]?.status, "rejected");
    assert.equal(campaign.state.pendingPacket, undefined);
    assert.equal(f.compareCalls.filter((call) => call.kind === "compare").length, 0);

    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.match(await readFile(campaign.state.pendingPacket!.path, "utf8"), /"action": "stop"/u);
  });

  it("stops before more live work when a prior score no longer matches attested attempts", async () => {
    const f = await fixture();
    let campaign = await ingestFixtureCandidate(f);
    assert.equal(await runCli([
      "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "targeted",
    ], f.context), 0);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const candidate = campaign.state.candidates["candidate-1"]!;
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      candidates: {
        ...campaign.state.candidates,
        "candidate-1": {
          ...candidate,
          scores: {
            ...candidate.scores,
            targeted: {
              ...candidate.scores.targeted!,
              meanBaseJudge: 0.4,
              meanCandidateJudge: 0.41,
              meanJudgeDelta: 0.01,
            },
          },
        },
      },
    });
    const callsBefore = f.compareCalls.filter((call) => call.kind === "compare").length;
    await assert.rejects(
      runCli(["next", "--campaign", "cli-campaign"], f.context),
      /does not match re-attested evidence/u,
    );
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(campaign.state.stopReason, "campaign routing evidence failed re-attestation");
    assert.equal(f.compareCalls.filter((call) => call.kind === "compare").length, callsBefore);
  });

  it("rejects forged response and Git-derived candidate metadata before routing", async () => {
    const responseForgery = await fixture();
    let campaign = await evaluateFixtureCandidateTargeted(responseForgery);
    let candidate = campaign.state.candidates["candidate-1"]!;
    const responsePacketFiles = await readdir(campaign.paths.packets);
    const responseSequence = campaign.state.packetSequence;
    const responseCalls = responseForgery.compareCalls.filter((call) => call.kind === "compare").length;
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      candidates: {
        ...campaign.state.candidates,
        "candidate-1": {
          ...candidate,
          response: {
            ...candidate.response,
            hypothesis: "Simplify by deleting unnecessary code that the commit does not remove.",
          },
        },
      },
    });

    await assert.rejects(
      runCli(["next", "--campaign", "cli-campaign"], responseForgery.context),
      { message: "Candidate candidate-1 response does not match its durable provenance" },
    );
    campaign = await loadCampaign(responseForgery.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(campaign.state.stopReason, "campaign routing evidence failed re-attestation");
    assert.equal(campaign.state.packetSequence, responseSequence);
    assert.equal(campaign.state.pendingPacket, undefined);
    assert.deepEqual(await readdir(campaign.paths.packets), responsePacketFiles);
    assert.equal(
      responseForgery.compareCalls.filter((call) => call.kind === "compare").length,
      responseCalls,
    );

    const metadataForgery = await fixture();
    campaign = await evaluateFixtureCandidateTargeted(metadataForgery);
    candidate = campaign.state.candidates["candidate-1"]!;
    assert.notEqual(candidate.productionLineDelta, -100);
    const metadataPacketFiles = await readdir(campaign.paths.packets);
    const metadataSequence = campaign.state.packetSequence;
    const metadataCalls = metadataForgery.compareCalls.filter((call) => call.kind === "compare").length;
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      candidates: {
        ...campaign.state.candidates,
        "candidate-1": {
          ...candidate,
          changedProductionLines: 0,
          productionLineDelta: -100,
        },
      },
    });

    await assert.rejects(
      runCli(["next", "--campaign", "cli-campaign"], metadataForgery.context),
      { message: "Candidate candidate-1 metadata does not match its revalidated commit" },
    );
    campaign = await loadCampaign(metadataForgery.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(campaign.state.stopReason, "campaign routing evidence failed re-attestation");
    assert.equal(campaign.state.packetSequence, metadataSequence);
    assert.equal(campaign.state.pendingPacket, undefined);
    assert.deepEqual(await readdir(campaign.paths.packets), metadataPacketFiles);
    assert.equal(
      metadataForgery.compareCalls.filter((call) => call.kind === "compare").length,
      metadataCalls,
    );
    const evaluationPath = join(campaign.paths.worktrees, "candidates", "candidate-1");
    assert.equal(await git(evaluationPath, ["status", "--porcelain"]), "");
    assert.equal(await git(evaluationPath, ["rev-parse", "HEAD"]), metadataForgery.candidateCommit);
  });

  it("rejects non-exact stage score prefixes before live work or sealed holdout access", async () => {
    const unexpected = await fixture();
    let campaign = await ingestFixtureCandidate(unexpected);
    let candidate = campaign.state.candidates["candidate-1"]!;
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      candidates: {
        ...campaign.state.candidates,
        "candidate-1": {
          ...candidate,
          scores: { holdout: passingScore(1) },
        },
      },
    });

    await assert.rejects(
      runCli([
        "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "targeted",
      ], unexpected.context),
      /targeted evaluation requires exactly the prior score prefix: none/u,
    );
    assert.equal(unexpected.compareCalls.filter((call) => call.kind === "compare").length, 0);
    campaign = await loadCampaign(unexpected.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "candidate-ingested");
    assert.equal(campaign.state.pendingPacket?.requestId, "request-0002");

    const missing = await fixture();
    campaign = await ingestFixtureCandidate(missing);
    candidate = campaign.state.candidates["candidate-1"]!;
    await write(
      campaign.spec.cohorts.holdout!.externalSuitePath,
      JSON.stringify([{ id: "sealed-secret-task", objective: "drifted", maxSteps: 2 }]),
    );
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      candidates: {
        ...campaign.state.candidates,
        "candidate-1": {
          ...candidate,
          status: "survives-broad",
          scores: {
            smoke: passingScore(1),
            broad: passingScore(2),
          },
        },
      },
    });

    await assert.rejects(
      runCli(["holdout", "--campaign", "cli-campaign", "--candidate", "candidate-1"], missing.context),
      /holdout evaluation requires exactly the prior score prefix: targeted, smoke, broad/u,
    );
    assert.equal(missing.compareCalls.filter((call) => call.kind === "compare").length, 0);
    campaign = await loadCampaign(missing.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "candidate-ingested");
    assert.equal(campaign.state.stopReason, undefined);
    assert.equal(campaign.state.pendingPacket?.requestId, "request-0002");
  });

  it("re-attests forged public scores before opening a malformed sealed holdout", async () => {
    const f = await fixture();
    let campaign = await advanceFixtureCandidateToHoldout(f);
    const sealedTaskId = "sealed-prior-stage-secret-task";
    await write(campaign.spec.cohorts.holdout!.externalSuitePath, `{"id":"${sealedTaskId}"`);
    await Promise.all((await readdir(campaign.paths.attempts)).map((name) => (
      rm(join(campaign.paths.attempts, name), { recursive: true, force: true })
    )));
    const packetFilesBefore = await readdir(campaign.paths.packets);
    const callsBefore = f.compareCalls.filter((call) => call.kind === "compare").length;

    await assert.rejects(
      runCli(["holdout", "--campaign", "cli-campaign", "--candidate", "candidate-1"], f.context),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Prior public-stage evidence failed re-attestation before sealed holdout access",
        );
        assert.doesNotMatch(error.message, new RegExp(sealedTaskId, "u"));
        return true;
      },
    );
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(
      campaign.state.stopReason,
      "persisted prior evaluation evidence failed re-attestation",
    );
    assert.doesNotMatch(campaign.state.stopReason, new RegExp(sealedTaskId, "u"));
    assert.deepEqual(await readdir(campaign.paths.packets), packetFilesBefore);
    assert.equal(f.compareCalls.filter((call) => call.kind === "compare").length, callsBefore);
    assert.doesNotMatch(f.outputs.join("\n"), new RegExp(sealedTaskId, "u"));
  });

  it("re-attests a forged terminal recommendation and stops without routing promotion", async () => {
    const f = await fixture();
    let campaign = await advanceFixtureCandidateToHoldout(f);
    const candidate = campaign.state.candidates["candidate-1"]!;
    const sealedTaskId = "sealed-terminal-secret-task";
    await write(campaign.spec.cohorts.holdout!.externalSuitePath, `{"id":"${sealedTaskId}"`);
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      phase: "candidate-ingested",
      pendingPacket: undefined,
      candidates: {
        ...campaign.state.candidates,
        "candidate-1": {
          ...candidate,
          status: "recommend-promote",
          scores: {
            ...candidate.scores,
            holdout: passingScore(1),
          },
        },
      },
    });
    const packetFilesBefore = await readdir(campaign.paths.packets);
    const sequenceBefore = campaign.state.packetSequence;
    const callsBefore = f.compareCalls.filter((call) => call.kind === "compare").length;

    await assert.rejects(
      runCli(["next", "--campaign", "cli-campaign"], f.context),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(
          error.message,
          "Sealed holdout evidence failed re-attestation; inspect local campaign state",
        );
        assert.doesNotMatch(error.message, new RegExp(sealedTaskId, "u"));
        return true;
      },
    );
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(campaign.state.stopReason, "campaign routing evidence failed re-attestation");
    assert.equal(campaign.state.packetSequence, sequenceBefore);
    assert.equal(campaign.state.pendingPacket, undefined);
    assert.deepEqual(await readdir(campaign.paths.packets), packetFilesBefore);
    assert.equal(f.compareCalls.filter((call) => call.kind === "compare").length, callsBefore);
    assert.doesNotMatch(f.outputs.join("\n"), new RegExp(sealedTaskId, "u"));
  });

  it("evaluates a committed skill change as the candidate-arm treatment", async () => {
    const f = await fixture();
    await write(join(f.candidatePath, "skills", "site.md"), "# Offline fixture skill\n# Candidate treatment\n");
    await git(f.candidatePath, ["add", "-A"]);
    await git(f.candidatePath, ["commit", "-m", "candidate skill treatment"]);
    const candidateCommit = await git(f.candidatePath, ["rev-parse", "HEAD"]);

    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const responsePath = join(campaign.paths.packets, "0001-response.json");
    await write(responsePath, JSON.stringify({
      version: 1,
      campaignId: "cli-campaign",
      requestId: campaign.state.pendingPacket!.requestId,
      candidateId: "candidate-1",
      baseCommit: f.baseCommit,
      worktreePath: f.candidatePath,
      candidateCommit,
      hypothesis: "Simplify site-specific behavior by refining the durable skill.",
      recommendedHome: "skill",
      changedFiles: ["skills/site.md", ...f.changedFiles],
      testsRun: ["pnpm check", "pnpm optimize:test"],
    }));
    assert.equal(await runCli([
      "ingest", "--campaign", "cli-campaign", "--response", responsePath,
    ], f.context), 0);
    assert.equal(await runCli([
      "evaluate", "--campaign", "cli-campaign", "--candidate", "candidate-1", "--cohort", "targeted",
    ], f.context), 0);

    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const candidateRoot = join(campaign.paths.worktrees, "candidates", "candidate-1");
    const frozenHash = campaign.spec.skillSnapshot.sha256;
    const candidateHash = await sha256Path(join(candidateRoot, "skills"));
    assert.notEqual(candidateHash, frozenHash);
    for (const call of f.compareCalls.filter((entry) => entry.kind === "compare")) {
      assert.equal(
        await sha256Path(call.env.WIRE_SKILLS!),
        call.cwd === candidateRoot ? candidateHash : frozenHash,
      );
    }
  });

  it("reports sanitized recovery state and preserves operator holdout errors", async () => {
    const f = await fixture();
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    await saveCampaignState(campaign.paths, {
      ...campaign.state,
      phase: "stopped",
      inFlight: {
        kind: "install",
        commit: f.baseCommit,
        startedAt: "2026-07-17T12:00:00.000Z",
      },
      stopReason: "operator stopped token_abcdefghijklmnopqrstuvwxyz",
    });

    const jsonOutput: string[] = [];
    assert.equal(await runCli(
      ["status", "--campaign", "cli-campaign", "--json"],
      { ...f.context, write: (text) => jsonOutput.push(text) },
    ), 0);
    const status = JSON.parse(jsonOutput.join("")) as Record<string, any>;
    assert.deepEqual(status.inFlight, {
      kind: "install",
      commit: f.baseCommit,
      startedAt: "2026-07-17T12:00:00.000Z",
    });
    assert.match(status.stopReason, /\[REDACTED\]/u);
    assert.doesNotMatch(status.stopReason, /abcdefghijklmnopqrstuvwxyz/u);

    const textOutput: string[] = [];
    assert.equal(await runCli(
      ["status", "--campaign", "cli-campaign"],
      { ...f.context, write: (text) => textOutput.push(text) },
    ), 0);
    assert.match(textOutput.join(""), /in-flight install/u);
    assert.match(textOutput.join(""), /stop: operator stopped \[REDACTED\]/u);

    await assert.rejects(
      runCli(["holdout", "--campaign", "cli-campaign", "--candidate", "missing"], f.context),
      /Campaign is stopped: operator stopped/u,
    );
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.stopReason, "operator stopped token_abcdefghijklmnopqrstuvwxyz");

    const active = await fixture();
    await assert.rejects(
      runCli(["holdout", "--campaign", "cli-campaign", "--candidate", "missing"], active.context),
      /Unknown candidate: missing/u,
    );
    campaign = await loadCampaign(active.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "initialized");
    assert.equal(campaign.state.stopReason, undefined);
  });

  it("durably stops before live work when credentials are missing or frozen inputs drift", async () => {
    const missing = await fixture();
    const { compareRunner: _compareRunner, ...withoutCompareRunner } = missing.context;
    await assert.rejects(
      runCli(
        ["baseline", "--campaign", "cli-campaign"],
        {
          ...withoutCompareRunner,
          env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        },
      ),
      /Missing required live credentials/u,
    );
    let campaign = await loadCampaign(missing.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(campaign.state.stopReason, "required live credentials are missing");
    assert.equal(missing.compareCalls.length, 0);

    const drifted = await fixture();
    await write(
      join(drifted.repositoryRoot, "benchmarks", "fixture-suite.json"),
      JSON.stringify([{ id: "task-a", objective: "changed", maxSteps: 2 }]),
    );
    await assert.rejects(
      runCli(["next", "--campaign", "cli-campaign"], drifted.context),
      /hash mismatch/u,
    );
    campaign = await loadCampaign(drifted.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(campaign.state.stopReason, "a frozen campaign input hash changed");
    assert.equal(drifted.compareCalls.length, 0);
  });

  it("rejects a protected-path candidate and durably stops its campaign", async () => {
    const f = await fixture();
    assert.equal(await runCli(["next", "--campaign", "cli-campaign"], f.context), 0);
    let campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    const pending = campaign.state.pendingPacket!;
    await write(
      join(f.candidatePath, "benchmarks", "compare", "run-compare.ts"),
      "export const forged = true;\n",
    );
    await git(f.candidatePath, ["add", "-A"]);
    await git(f.candidatePath, ["commit", "-m", "forge evaluator"]);
    const protectedCommit = await git(f.candidatePath, ["rev-parse", "HEAD"]);
    const responsePath = join(campaign.paths.packets, "0001-response.json");
    await write(responsePath, JSON.stringify({
      version: 1,
      campaignId: "cli-campaign",
      requestId: pending.requestId,
      candidateId: "candidate-protected",
      baseCommit: f.baseCommit,
      worktreePath: f.candidatePath,
      candidateCommit: protectedCommit,
      hypothesis: "Change the evaluator to pass.",
      recommendedHome: "core",
      changedFiles: ["benchmarks/compare/run-compare.ts", ...f.changedFiles],
      testsRun: [],
    }));
    assert.equal(await runCli([
      "ingest", "--campaign", "cli-campaign", "--response", responsePath,
    ], f.context), 1);
    campaign = await loadCampaign(f.optimizerRoot, "cli-campaign");
    assert.equal(campaign.state.phase, "stopped");
    assert.equal(
      campaign.state.stopReason,
      "candidate changed a protected campaign or evaluator input",
    );
    assert.equal(campaign.state.candidates["candidate-protected"]?.status, "rejected");
    assert.equal(f.commandCalls.length, 0);
    assert.match(await readFile(campaign.state.pendingPacket!.path, "utf8"), /"action": "stop"/u);
  });
});
