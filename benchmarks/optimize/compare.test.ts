import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { atomicWriteJson } from "../../src/storage/atomic.js";
import {
  createPairedSchedule,
  evaluatePaired,
  harnessArguments,
  harnessOutputPath,
  preparationSandboxRequest,
  spawnChild,
  type ChildInvocation,
  type ChildResult,
  type ChildRunner,
} from "./compare.js";
import {
  attemptSchema,
  campaignSpecSchema,
  campaignStateSchema,
  type Attempt,
  type CampaignSpec,
  type CampaignState,
} from "./model.js";
import {
  campaignPaths,
  loadAttempt,
  saveAttempt,
  saveCampaignState,
  sha256Path,
  type CampaignPaths,
} from "./state.js";

const roots: string[] = [];
const baseCommit = "a".repeat(40);
const candidateCommit = "b".repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  root: string;
  baseWorktree: string;
  candidateWorktree: string;
  spec: CampaignSpec;
  state: CampaignState;
  paths: CampaignPaths;
  env: NodeJS.ProcessEnv;
}

async function fixture(options: { pairedSlots?: number; maxPhysicalRuns?: number } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "wire-opt-compare-"));
  roots.push(root);
  const baseWorktree = join(root, "base");
  const candidateWorktree = join(root, "candidate");
  const suitePath = join(root, "suite.json");
  const skillSnapshot = join(root, "snapshot");
  await Promise.all([
    mkdir(baseWorktree, { recursive: true }),
    mkdir(candidateWorktree, { recursive: true }),
    mkdir(skillSnapshot, { recursive: true }),
  ]);
  await writeFile(suitePath, JSON.stringify([
    { id: "task-a", objective: "Return A", maxSteps: 4 },
    { id: "task-b", objective: "Return B", maxSteps: 5 },
  ]));
  await writeFile(join(skillSnapshot, "site.md"), "---\nid: site\n---\n# Site\n");

  const spec = campaignSpecSchema.parse({
    version: 1,
    id: "compare-fixture",
    baseCommit,
    suite: { path: suitePath, sha256: await sha256Path(suitePath) },
    judge: { model: "judge-model", threshold: 0.7 },
    wire: { provider: "anthropic", model: "wire-model", timeoutMs: 10_000 },
    cohorts: {
      smoke: { taskIds: ["task-a"], pairedSlots: 1 },
      targeted: { taskIds: ["task-a", "task-b"], pairedSlots: options.pairedSlots ?? 2 },
      broad: { taskIds: ["task-a", "task-b"], pairedSlots: 2 },
    },
    budget: {
      maxPhysicalRuns: options.maxPhysicalRuns ?? 20,
      maxCandidates: 2,
      maxWallClockMs: 1_000_000,
      maxConcurrency: 1,
    },
    skillSnapshot: { path: skillSnapshot, sha256: await sha256Path(skillSnapshot) },
    seed: "fixture-seed",
    gates: {
      minimumTargetedSuccessDelta: 2,
      minimumMeanJudgeDelta: 0.05,
      maxSimplificationJudgeRegression: 0.02,
      maxSmokeSuccessRegression: 0,
      maxBroadSuccessRegression: 0,
    },
  });
  const paths = campaignPaths(join(root, "optimizer"), spec.id);
  await Promise.all([
    paths.attempts,
    paths.traces,
    paths.skills,
    paths.autopsies,
    paths.candidates,
    paths.packets,
    paths.reports,
    paths.worktrees,
  ].map((path) => mkdir(path, { recursive: true })));
  await atomicWriteJson(paths.resolvedCampaign, spec);
  const state = campaignStateSchema.parse({
    version: 1,
    campaignId: spec.id,
    baseCommit: spec.baseCommit,
    campaignSpecSha256: await sha256Path(paths.resolvedCampaign),
    phase: "candidate-ingested",
    createdAt: "2026-07-17T12:00:00.000Z",
    updatedAt: "2026-07-17T12:00:00.000Z",
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
  await saveCampaignState(paths, state);
  return {
    root,
    baseWorktree,
    candidateWorktree,
    spec,
    state,
    paths,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: join(root, "home"),
      STEEL_API_KEY: "fixture-steel-key",
      ANTHROPIC_API_KEY: "fixture-anthropic-key",
      UNRELATED_TOKEN: "must-not-reach-candidate",
    },
  };
}

function successfulChild(wallMs: number): ChildResult {
  return {
    code: 0,
    signal: null,
    stdout: "console output must not be parsed",
    stderr: "api_key=abcdefghijklmnopq",
    timedOut: false,
    wallMs,
  };
}

function flag(args: string[], name: string): string {
  const index = args.indexOf(name);
  assert.notEqual(index, -1, `missing ${name}`);
  return args[index + 1]!;
}

function harnessRecord(input: {
  taskId: string;
  objective: string;
  runId: string | null;
  judgeScore?: number | null;
  success?: boolean;
}): Record<string, unknown> {
  const judgeScore = input.judgeScore === undefined ? 0.9 : input.judgeScore;
  return {
    task: input.taskId,
    objective: input.objective,
    arm: "wire",
    rep: 1,
    ok: true,
    wallMs: 80,
    judgeScore,
    success: input.success ?? (judgeScore !== null && judgeScore >= 0.7),
    answer: "answer containing sk-abcdefghijklmnopqrstuvwxyz",
    native: {
      runId: input.runId,
      status: "succeeded",
      classification: "task-complete",
      confidence: 0.9,
      summary: "done",
      provider: "anthropic",
      model: "wire-model",
      costUsd: null,
    },
    note: "bearer abcdefghijklmnopqrstuvwxyz",
  };
}

function persistedRun(
  runId: string,
  result = "answer containing sk-abcdefghijklmnopqrstuvwxyz",
  status = "succeeded",
  classification = "task-complete",
): Record<string, unknown> {
  return {
    id: runId,
    taskId: "task_fixture",
    status,
    result,
    classification: { kind: classification, confidence: 0.9 },
  };
}

type CompareMode =
  | "success"
  | "no-output"
  | "empty"
  | "malformed"
  | "multiple"
  | "missing-run-id"
  | "traversal-run-id"
  | "missing-run-file"
  | "null-judge"
  | "wrong-task"
  | "nonzero"
  | "timeout";

function fakeRunner(f: Fixture, mode: CompareMode = "success"): {
  calls: ChildInvocation[];
  runner: ChildRunner;
} {
  const calls: ChildInvocation[] = [];
  let runSequence = 0;
  const objectives = new Map([
    ["task-a", "Return A"],
    ["task-b", "Return B"],
  ]);
  return {
    calls,
    runner: async (invocation) => {
      calls.push(invocation);
      if (invocation.kind === "install") return successfulChild(2);
      if (invocation.kind === "build") {
        await mkdir(join(invocation.cwd, "dist"), { recursive: true });
        await writeFile(join(invocation.cwd, "dist", "index.js"), "// built fixture\n");
        return successfulChild(5);
      }

      runSequence += 1;
      const taskId = flag(invocation.args, "--tasks");
      const stamp = flag(invocation.args, "--stamp");
      const output = harnessOutputPath(invocation.cwd, stamp);
      const wireRoot = invocation.env.WIRE_ROOT!;
      const runId = `run_fixture-${runSequence}`;
      await mkdir(dirname(output), { recursive: true });
      await mkdir(join(wireRoot, "runs"), { recursive: true });
      if (mode !== "missing-run-file") {
        await writeFile(join(wireRoot, "runs", `${runId}.json`), JSON.stringify(persistedRun(runId)));
      }

      const record = harnessRecord({
        taskId: mode === "wrong-task" ? "other-task" : taskId,
        objective: objectives.get(taskId)!,
        runId: mode === "missing-run-id"
          ? null
          : mode === "traversal-run-id" ? "run_../../campaign-state" : runId,
        ...(mode === "null-judge" ? { judgeScore: null } : {}),
      });
      if (mode === "empty") await writeFile(output, "");
      else if (mode === "malformed") await writeFile(output, "not-json\n");
      else if (mode === "multiple") await writeFile(output, `${JSON.stringify(record)}\n${JSON.stringify(record)}\n`);
      else if (mode !== "no-output") await writeFile(output, `${JSON.stringify(record)}\n`);

      if (mode === "nonzero") return { ...successfulChild(100), code: 1 };
      if (mode === "timeout") return { ...successfulChild(100), timedOut: true, signal: "SIGKILL" };
      return successfulChild(100);
    },
  };
}

function tickingClock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 17, 12, 0, tick++));
}

function evaluationOptions(f: Fixture, state: CampaignState, runner: ChildRunner) {
  return {
    spec: f.spec,
    state,
    paths: f.paths,
    candidateId: "candidate-1",
    cohort: "targeted" as const,
    base: { commit: baseCommit, worktreePath: f.baseWorktree },
    candidate: { commit: candidateCommit, worktreePath: f.candidateWorktree },
    runner,
    verifyRevision: async () => {},
    env: f.env,
    now: tickingClock(),
  };
}

async function writeForgedCompletedAttempt(
  f: Fixture,
  slot: ReturnType<typeof createPairedSchedule>[number],
): Promise<Attempt> {
  const results: Attempt["results"] = [];
  for (const arm of slot.order) {
    const runId = `run_forged-${arm}`;
    const runResult = `forged ${arm} result`;
    const wireRoot = join(f.paths.traces, slot.slotId, arm);
    const skillRoot = join(f.paths.skills, f.spec.skillSnapshot.sha256, slot.slotId, arm);
    const outputPath = join(f.paths.attempts, "raw", `${slot.slotId}-${arm}-forged.jsonl`);
    await Promise.all([
      mkdir(join(wireRoot, "runs"), { recursive: true }),
      mkdir(skillRoot, { recursive: true }),
      mkdir(dirname(outputPath), { recursive: true }),
    ]);
    await writeFile(
      join(wireRoot, "runs", `${runId}.json`),
      JSON.stringify(persistedRun(runId, runResult)),
    );
    await writeFile(outputPath, `${JSON.stringify({
      version: 1,
      sourceSha256: null,
      record: {
        ok: true,
        wallMs: 80,
        judgeScore: 0.99,
        success: true,
        runId,
        answerSha256: createHash("sha256").update(runResult).digest("hex"),
        nativeStatus: "succeeded",
        nativeClassification: "task-complete",
      },
      subprocess: { exitCode: 0, signal: null, timedOut: false, wallMs: 100 },
      diagnostic: "forged but internally consistent future evidence",
    })}\n`);
    results.push({
      arm,
      status: "completed",
      runId,
      judgeScore: 0.99,
      success: true,
      wallMs: 80,
      nativeStatus: "succeeded",
      nativeClassification: "task-complete",
      harnessOutputPath: outputPath,
      harnessOutputSha256: await sha256Path(outputPath),
      subprocess: { exitCode: 0, signal: null, timedOut: false, wallMs: 100 },
      commit: arm === "base" ? baseCommit : candidateCommit,
      wireRoot,
      skillRoot,
      startedAt: "2026-07-17T12:00:00.000Z",
      finishedAt: "2026-07-17T12:00:01.000Z",
      stderr: "",
    });
  }
  const attempt = attemptSchema.parse({
    version: 1,
    campaignId: f.spec.id,
    candidateId: "candidate-1",
    cohort: "targeted",
    slotId: slot.slotId,
    slotIndex: slot.slotIndex,
    taskId: slot.taskId,
    repetition: slot.repetition,
    order: slot.order,
    results,
    complete: true,
  });
  await saveAttempt(f.paths, attempt);
  return attempt;
}

describe("paired comparison scheduling", () => {
  it("is seeded, deterministic, alternating, and balances task repetitions", () => {
    const input = {
      campaignId: "campaign",
      candidateId: "candidate",
      cohort: "targeted" as const,
      seed: "seed",
      taskIds: ["a", "b"],
      pairedSlots: 5,
    };
    const first = createPairedSchedule(input);
    assert.deepEqual(createPairedSchedule(input), first);
    for (let index = 1; index < first.length; index += 1) {
      assert.notEqual(first[index]!.order[0], first[index - 1]!.order[0]);
    }
    assert.deepEqual(first.map((slot) => slot.taskId), ["a", "b", "a", "b", "a"]);
    assert.deepEqual(first.map((slot) => slot.repetition), [1, 1, 2, 2, 3]);
    assert.equal(new Set(first.map((slot) => slot.slotId)).size, first.length);
  });

  it("constructs only the frozen harness flags and rejects unsafe stamps", async () => {
    const f = await fixture();
    assert.deepEqual(harnessArguments({
      spec: f.spec,
      suitePath: f.spec.suite.path,
      taskId: "task-a",
      stamp: "slot-safe-base",
    }), [
      "--arms", "wire",
      "--suite", f.spec.suite.path,
      "--tasks", "task-a",
      "--reps", "1",
      "--stamp", "slot-safe-base",
      "--skip-build",
      "--judge-model", "judge-model",
      "--judge-threshold", "0.7",
      "--wire-provider", "anthropic",
      "--wire-model", "wire-model",
      "--timeout", "10000",
    ]);
    assert.throws(() => harnessOutputPath(f.baseWorktree, "../escape"), /Unsafe harness stamp/u);
  });
});

describe("child supervision", () => {
  it("confines production preparation writes to the revision and isolated HOME", () => {
    const root = "/tmp/wire-opt-sandbox-contract";
    const invocation: ChildInvocation = {
      kind: "build",
      command: process.execPath,
      args: ["--version"],
      cwd: join(root, "revision"),
      env: {
        HOME: join(root, "offline-home"),
        PATH: "/usr/bin",
        SECRET_DO_NOT_PERSIST: "never-in-argv",
      },
      timeoutMs: 500,
    };
    const request = preparationSandboxRequest(invocation);
    assert.equal(request.command, process.execPath);
    assert.deepEqual(request.readWritePaths, [invocation.cwd, invocation.env.HOME]);
    assert.ok(request.readOnlyPaths.includes("/usr"));
    assert.ok(request.environmentNames.includes("SECRET_DO_NOT_PERSIST"));
    assert.throws(
      () => preparationSandboxRequest({ ...invocation, kind: "compare" }),
      /Only candidate-controlled preparation commands/u,
    );
  });

  it("times out and terminates a real long-running child promptly", async () => {
    const root = await mkdtemp(join(tmpdir(), "wire-opt-child-"));
    roots.push(root);

    const result = await spawnChild({
      kind: "compare",
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1_000)"],
      cwd: root,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
      timeoutMs: 75,
    });

    assert.equal(result.timedOut, true);
    assert.equal(result.code, null);
    assert.equal(result.signal, "SIGKILL");
    assert.ok(result.wallMs >= 50, `expected timeout debit, got ${result.wallMs}ms`);
    assert.ok(result.wallMs < 2_000, `child supervisor took ${result.wallMs}ms to terminate`);
  });

  it("kills descendant process groups after normal parent exit and timeout", {
    skip: process.platform === "win32",
  }, async () => {
    const root = await mkdtemp(join(tmpdir(), "wire-opt-descendant-"));
    roots.push(root);

    for (const mode of ["exit", "timeout"] as const) {
      const marker = join(root, `${mode}.marker`);
      const descendantSource = [
        "const { writeFileSync } = require('node:fs');",
        `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'survived'), 300);`,
      ].join("\n");
      const parentSource = [
        "const { spawn } = require('node:child_process');",
        `const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantSource)}], { stdio: 'ignore' });`,
        "descendant.unref();",
        ...(mode === "timeout" ? ["setInterval(() => {}, 1_000);"] : []),
      ].join("\n");

      const result = await spawnChild({
        kind: "compare",
        command: process.execPath,
        args: ["-e", parentSource],
        cwd: root,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        timeoutMs: mode === "timeout" ? 75 : 1_000,
      });
      assert.equal(result.timedOut, mode === "timeout", mode);
      if (mode === "exit") assert.equal(result.code, 0);

      await new Promise((resolveDelay) => setTimeout(resolveDelay, 450));
      await assert.rejects(readFile(marker, "utf8"), { code: "ENOENT" }, mode);
    }
  });
});

describe("paired harness execution", () => {
  it("builds revisions once, verifies launchers, isolates every arm, and persists normalized pairs", async () => {
    const f = await fixture({ pairedSlots: 2 });
    const fake = fakeRunner(f);
    const result = await evaluatePaired(evaluationOptions(f, f.state, fake.runner));
    assert.equal(result.stopped, false);
    assert.equal(result.state.physicalRunsUsed, 4);
    assert.equal(result.state.wallClockMsUsed, 414);
    assert.equal(result.state.buildWallClockMsUsed, 14);
    assert.deepEqual(
      new Set(result.state.builtRevisions.map((revision) => revision.commit)),
      new Set([baseCommit, candidateCommit]),
    );
    assert.equal(result.state.completedSlots.length, 2);
    assert.equal(result.attempts.filter((attempt) => attempt.candidateId === "candidate-1").length, 2);
    assert.ok(result.attempts.every((attempt) => attempt.complete));
    assert.ok(result.attempts.every((attempt) => attempt.results.every((entry) => (
      entry.harnessOutputSha256 !== null
      && entry.subprocess.exitCode === 0
      && entry.subprocess.wallMs === 100
    ))));

    const builds = fake.calls.filter((call) => call.kind === "build");
    const installs = fake.calls.filter((call) => call.kind === "install");
    const compares = fake.calls.filter((call) => call.kind === "compare");
    assert.deepEqual(installs.map((call) => call.args), [
      ["install", "--frozen-lockfile"],
      ["install", "--frozen-lockfile"],
    ]);
    assert.deepEqual(builds.map((call) => call.args), [["run", "build"], ["run", "build"]]);
    assert.ok(fake.calls.every((call) => call.env.UNRELATED_TOKEN === undefined));
    assert.equal(compares.length, 4);
    const rootsSeen = new Set<string>();
    const skillsSeen = new Set<string>();
    for (const call of compares) {
      assert.equal(call.command, process.execPath);
      assert.equal(call.args[0], "--experimental-strip-types");
      assert.equal(
        call.args[1],
        join(call.cwd, "benchmarks", "compare", "run-compare.ts"),
      );
      assert.equal(flag(call.args, "--arms"), "wire");
      assert.equal(flag(call.args, "--suite"), f.spec.suite.path);
      assert.equal(flag(call.args, "--reps"), "1");
      assert.equal(flag(call.args, "--judge-model"), f.spec.judge.model);
      assert.equal(flag(call.args, "--judge-threshold"), String(f.spec.judge.threshold));
      assert.equal(flag(call.args, "--wire-provider"), f.spec.wire.provider);
      assert.equal(flag(call.args, "--wire-model"), f.spec.wire.model);
      assert.equal(flag(call.args, "--timeout"), String(f.spec.wire.timeoutMs));
      assert.ok(call.args.includes("--skip-build"));
      assert.ok(call.env.WIRE_ROOT?.startsWith(f.paths.traces));
      assert.ok(call.env.WIRE_SKILLS?.startsWith(f.paths.skills));
      assert.ok(call.env.WIRE_HOME?.startsWith(call.env.WIRE_ROOT!));
      assert.ok(call.env.HOME?.startsWith(join(f.paths.attempts, "launchers")));
      assert.notEqual(call.env.HOME, call.env.WIRE_HOME);
      assert.equal(call.env.WIRE_PROVIDER, f.spec.wire.provider);
      assert.equal(call.env.WIRE_MODEL, f.spec.wire.model);
      rootsSeen.add(call.env.WIRE_ROOT!);
      skillsSeen.add(call.env.WIRE_SKILLS!);
      assert.equal(await sha256Path(call.env.WIRE_SKILLS!), f.spec.skillSnapshot.sha256);

      const launcherDir = call.env.PATH!.split(delimiter)[0]!;
      assert.ok(launcherDir.startsWith(join(f.paths.attempts, "launchers")));
      assert.doesNotMatch(call.env.PATH!, /node_modules/u);
      const launcher = await readFile(join(launcherDir, "wire"), "utf8");
      const expectedWorktree = call.cwd;
      assert.match(launcher, new RegExp(join(expectedWorktree, "dist", "index.js").replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
      assert.match(launcher, /systemd-run/u);
      assert.match(launcher, /KillMode=control-group/u);
      assert.match(launcher, /ProtectSystem=strict/u);
      assert.doesNotMatch(launcher, /fixture-anthropic-key|fixture-steel-key/u);
    }
    assert.equal(rootsSeen.size, 4);
    assert.equal(skillsSeen.size, 4);

    const serialized = JSON.stringify(result.attempts);
    assert.doesNotMatch(serialized, /sk-abcdefghijklmnopqrstuvwxyz|abcdefghijklmnopq|bearer abcdef/iu);
    assert.doesNotMatch(serialized, /answer containing/u);
    assert.match(serialized, /\[REDACTED\]/u);
    for (const attempt of result.attempts) {
      for (const physical of attempt.results) {
        const durable = await readFile(physical.harnessOutputPath, "utf8");
        assert.doesNotMatch(durable, /answer containing|Return A|Return B|sk-abcdefghijklmnopqrstuvwxyz/u);
        assert.doesNotMatch(durable, /"(?:answer|objective|task)"/u);
      }
    }
    for (const call of compares) {
      await assert.rejects(
        readFile(harnessOutputPath(call.cwd, flag(call.args, "--stamp")), "utf8"),
        { code: "ENOENT" },
      );
    }

    const callsBeforeResume = fake.calls.length;
    const resumed = await evaluatePaired(evaluationOptions(f, result.state, fake.runner));
    assert.equal(resumed.stopped, false);
    assert.equal(fake.calls.length, callsBeforeResume, "completed slots and built commits must not rerun");
    assert.equal(resumed.state.physicalRunsUsed, 4);

    await writeFile(join(f.candidateWorktree, "dist", "index.js"), "// tampered after build\n");
    const beforeTamperCheck = fake.calls.length;
    const tampered = await evaluatePaired(evaluationOptions(f, resumed.state, fake.runner));
    assert.equal(tampered.stopped, true);
    assert.match(tampered.state.stopReason ?? "", /Built output changed/u);
    assert.equal(fake.calls.length, beforeTamperCheck);
  });

  it("uses a commit-derived candidate skill snapshot only for the candidate arm", async () => {
    const f = await fixture({ pairedSlots: 1 });
    const candidateSkills = join(f.candidateWorktree, "skills");
    await mkdir(candidateSkills, { recursive: true });
    await writeFile(join(candidateSkills, "site.md"), "---\nid: site\n---\n# Candidate treatment\n");
    const candidateSkillHash = await sha256Path(candidateSkills);
    const fake = fakeRunner(f);

    const result = await evaluatePaired({
      ...evaluationOptions(f, f.state, fake.runner),
      candidateSkillSnapshot: { path: candidateSkills, sha256: candidateSkillHash },
    });

    assert.equal(result.stopped, false);
    const compares = fake.calls.filter((call) => call.kind === "compare");
    assert.equal(compares.length, 2);
    for (const call of compares) {
      const actual = await sha256Path(call.env.WIRE_SKILLS!);
      assert.equal(
        actual,
        call.cwd === f.candidateWorktree ? candidateSkillHash : f.spec.skillSnapshot.sha256,
      );
    }
    const candidateResult = result.attempts[0]!.results.find((entry) => entry.arm === "candidate")!;
    assert.match(candidateResult.skillRoot, new RegExp(candidateSkillHash, "u"));
  });

  it("durably stops if preparation changes the immutable revision", async () => {
    const f = await fixture({ pairedSlots: 1 });
    const fake = fakeRunner(f);
    let candidateChecks = 0;
    const result = await evaluatePaired({
      ...evaluationOptions(f, f.state, fake.runner),
      verifyRevision: async (revision) => {
        if (revision.commit === candidateCommit && ++candidateChecks === 2) {
          throw new Error("Revision became dirty during preparation");
        }
      },
    });

    assert.equal(result.stopped, true);
    assert.match(result.state.stopReason ?? "", /became dirty during preparation/u);
    assert.equal(fake.calls.filter((call) => call.kind === "compare").length, 0);
  });

  it("stops after one explicit infrastructure result for malformed, missing, or failed children", async () => {
    const modes: CompareMode[] = [
      "no-output",
      "empty",
      "malformed",
      "multiple",
      "missing-run-id",
      "traversal-run-id",
      "missing-run-file",
      "null-judge",
      "wrong-task",
      "nonzero",
      "timeout",
    ];
    for (const mode of modes) {
      const f = await fixture({ pairedSlots: 2 });
      const fake = fakeRunner(f, mode);
      const result = await evaluatePaired(evaluationOptions(f, f.state, fake.runner));
      assert.equal(result.stopped, true, mode);
      assert.equal(result.state.physicalRunsUsed, 1, mode);
      assert.equal(fake.calls.filter((call) => call.kind === "compare").length, 1, mode);
      const attempt = result.attempts.find((entry) => entry.candidateId === "candidate-1")!;
      assert.equal(attempt.results.length, 1, mode);
      assert.equal(attempt.results[0]!.status, "infrastructure-failure", mode);
      assert.equal(attempt.complete, false, mode);
      assert.ok(attempt.results[0]!.failureReason, mode);
      assert.equal(attempt.results[0]!.success, null, mode);
    }
  });

  it("debits each launched arm exactly once and preserves a budget-limited partial pair", async () => {
    const f = await fixture({ pairedSlots: 2, maxPhysicalRuns: 1 });
    const fake = fakeRunner(f);
    const result = await evaluatePaired(evaluationOptions(f, f.state, fake.runner));
    assert.equal(result.stopped, true);
    assert.equal(result.state.physicalRunsUsed, 1);
    assert.equal(fake.calls.filter((call) => call.kind === "compare").length, 1);
    const partial = result.attempts.find((attempt) => attempt.results.length > 0)!;
    assert.equal(partial.results.length, 1);
    assert.equal(partial.results[0]!.status, "completed");
    assert.equal(partial.complete, false);

    const before = fake.calls.length;
    const resumed = await evaluatePaired(evaluationOptions(f, result.state, fake.runner));
    assert.equal(resumed.stopped, true);
    assert.equal(fake.calls.length, before, "budget exhaustion must not trigger a retry");
  });

  it("reconciles a persisted partial arm with stale in-flight state without rerunning it", async () => {
    const f = await fixture({ pairedSlots: 1 });
    await Promise.all([
      mkdir(join(f.baseWorktree, "dist"), { recursive: true }),
      mkdir(join(f.candidateWorktree, "dist"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(f.baseWorktree, "dist", "index.js"), "// base\n"),
      writeFile(join(f.candidateWorktree, "dist", "index.js"), "// candidate\n"),
    ]);
    const slot = createPairedSchedule({
      campaignId: f.spec.id,
      candidateId: "candidate-1",
      cohort: "targeted",
      seed: f.spec.seed,
      taskIds: f.spec.cohorts.targeted.taskIds,
      pairedSlots: 1,
    })[0]!;
    const completedArm = slot.order[0];
    const revision = completedArm === "base"
      ? { commit: baseCommit, worktreePath: f.baseWorktree }
      : { commit: candidateCommit, worktreePath: f.candidateWorktree };
    const previousWireRoot = join(f.paths.traces, slot.slotId, completedArm);
    const previousOutput = join(f.paths.attempts, "raw", "previous.jsonl");
    await mkdir(join(previousWireRoot, "runs"), { recursive: true });
    await writeFile(
      join(previousWireRoot, "runs", "run_previous.json"),
      JSON.stringify(persistedRun("run_previous", "previous result")),
    );
    await mkdir(dirname(previousOutput), { recursive: true });
    await writeFile(previousOutput, `${JSON.stringify({
      version: 1,
      sourceSha256: null,
      record: {
        ok: true,
        wallMs: 50,
        judgeScore: 0.8,
        success: true,
        runId: "run_previous",
        answerSha256: createHash("sha256").update("previous result").digest("hex"),
        nativeStatus: "succeeded",
        nativeClassification: "task-complete",
      },
      subprocess: { exitCode: 0, signal: null, timedOut: false, wallMs: 50 },
      diagnostic: "fixture",
    })}\n`);
    const partial = attemptSchema.parse({
      version: 1,
      campaignId: f.spec.id,
      candidateId: "candidate-1",
      cohort: "targeted",
      slotId: slot.slotId,
      slotIndex: slot.slotIndex,
      taskId: slot.taskId,
      repetition: slot.repetition,
      order: slot.order,
      results: [{
        arm: completedArm,
        status: "completed",
        runId: "run_previous",
        judgeScore: 0.8,
        success: true,
        wallMs: 50,
        nativeStatus: "succeeded",
        nativeClassification: "task-complete",
        harnessOutputPath: previousOutput,
        harnessOutputSha256: await sha256Path(previousOutput),
        subprocess: { exitCode: 0, signal: null, timedOut: false, wallMs: 50 },
        commit: revision.commit,
        wireRoot: previousWireRoot,
        skillRoot: join(f.paths.skills, f.spec.skillSnapshot.sha256, slot.slotId, completedArm),
        startedAt: "2026-07-17T12:00:00.000Z",
        finishedAt: "2026-07-17T12:00:01.000Z",
        stderr: "",
      }],
      complete: false,
    });
    await saveAttempt(f.paths, partial);
    const persistedState = campaignStateSchema.parse({
      ...f.state,
      phase: "evaluating",
      physicalRunsUsed: 1,
      wallClockMsUsed: 100,
      builtRevisions: [
        {
          commit: baseCommit,
          worktreePath: f.baseWorktree,
          distSha256: await sha256Path(join(f.baseWorktree, "dist")),
        },
        {
          commit: candidateCommit,
          worktreePath: f.candidateWorktree,
          distSha256: await sha256Path(join(f.candidateWorktree, "dist")),
        },
      ],
      inFlight: {
        kind: "compare",
        commit: revision.commit,
        startedAt: "2026-07-17T12:00:00.000Z",
        slotId: slot.slotId,
        arm: completedArm,
      },
    });
    await saveCampaignState(f.paths, persistedState);

    const fake = fakeRunner(f);
    const result = await evaluatePaired(evaluationOptions(f, persistedState, fake.runner));
    assert.equal(result.stopped, false);
    assert.equal(result.state.physicalRunsUsed, 2);
    assert.equal(result.state.inFlight, undefined);
    assert.equal(result.state.wallClockMsUsed, 150);
    assert.equal(fake.calls.filter((call) => call.kind === "build").length, 0);
    assert.equal(fake.calls.filter((call) => call.kind === "install").length, 0);
    assert.equal(fake.calls.filter((call) => call.kind === "compare").length, 1);
    const completed = await loadAttempt(f.paths, slot.slotId);
    assert.equal(completed?.complete, true);
    assert.deepEqual(completed?.results.map((entry) => entry.arm), slot.order);
  });

  it("re-attests persisted attempt evidence and durably stops on output tampering", async () => {
    const f = await fixture({ pairedSlots: 1 });
    const fake = fakeRunner(f);
    const completed = await evaluatePaired(evaluationOptions(f, f.state, fake.runner));
    assert.equal(completed.stopped, false);
    const physical = completed.attempts
      .find((attempt) => attempt.candidateId === "candidate-1")!
      .results[0]!;

    await chmod(physical.harnessOutputPath, 0o600);
    await writeFile(physical.harnessOutputPath, "{\"tampered\":true}\n");
    const callsBeforeResume = fake.calls.length;

    const resumed = await evaluatePaired(evaluationOptions(f, completed.state, fake.runner));
    assert.equal(resumed.stopped, true);
    assert.equal(resumed.state.phase, "stopped");
    assert.match(resumed.state.stopReason ?? "", /output hash changed/u);
    assert.equal(fake.calls.length, callsBeforeResume, "tampered evidence must never trigger a rerun");

    const persisted = campaignStateSchema.parse(JSON.parse(await readFile(f.paths.state, "utf8")) as unknown);
    assert.equal(persisted.phase, "stopped");
    assert.match(persisted.stopReason ?? "", /output hash changed/u);
  });

  it("re-attests score fields in attempt JSON and never reruns tampered evidence", async () => {
    const f = await fixture({ pairedSlots: 1 });
    const fake = fakeRunner(f);
    const completed = await evaluatePaired(evaluationOptions(f, f.state, fake.runner));
    assert.equal(completed.stopped, false);
    const attempt = completed.attempts[0]!;
    const path = join(f.paths.attempts, `${attempt.slotId}.json`);
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      results: Array<{ judgeScore: number | null }>;
    };
    raw.results[0]!.judgeScore = 0.01;
    await writeFile(path, `${JSON.stringify(raw)}\n`);
    const callsBeforeResume = fake.calls.length;

    const resumed = await evaluatePaired(evaluationOptions(f, completed.state, fake.runner));
    assert.equal(resumed.stopped, true);
    assert.match(resumed.state.stopReason ?? "", /fields changed/u);
    assert.equal(fake.calls.length, callsBeforeResume);
  });

  it("recomputes success from the frozen threshold during evidence re-attestation", async () => {
    const f = await fixture({ pairedSlots: 1 });
    const fake = fakeRunner(f);
    const completed = await evaluatePaired(evaluationOptions(f, f.state, fake.runner));
    const attempt = completed.attempts[0]!;
    const physical = attempt.results[0]!;
    await chmod(physical.harnessOutputPath, 0o600);
    const durable = JSON.parse(await readFile(physical.harnessOutputPath, "utf8")) as {
      record: { ok: boolean; success: boolean };
    };
    durable.record.ok = false;
    durable.record.success = true;
    await writeFile(physical.harnessOutputPath, `${JSON.stringify(durable)}\n`);
    await chmod(physical.harnessOutputPath, 0o400);
    const attemptPath = join(f.paths.attempts, `${attempt.slotId}.json`);
    const persisted = JSON.parse(await readFile(attemptPath, "utf8")) as {
      results: Array<{ harnessOutputSha256: string | null }>;
    };
    persisted.results[0]!.harnessOutputSha256 = await sha256Path(physical.harnessOutputPath);
    await writeFile(attemptPath, `${JSON.stringify(persisted)}\n`);
    const callsBefore = fake.calls.length;

    const resumed = await evaluatePaired(evaluationOptions(f, completed.state, fake.runner));

    assert.equal(resumed.stopped, true);
    assert.match(resumed.state.stopReason ?? "", /fields changed/u);
    assert.equal(fake.calls.length, callsBefore);
  });

  it("stops before another run when a measured child rewrites earlier stage evidence", async () => {
    const f = await fixture({ pairedSlots: 2 });
    const fake = fakeRunner(f);
    let physicalRuns = 0;
    const runner: ChildRunner = async (invocation) => {
      if (invocation.kind === "compare" && ++physicalRuns === 3) {
        let path: string | undefined;
        let raw: { complete: boolean; results: Array<{ judgeScore: number | null }> } | undefined;
        for (const name of (await readdir(f.paths.attempts)).filter((entry) => entry.endsWith(".json"))) {
          const candidatePath = join(f.paths.attempts, name);
          const candidate = JSON.parse(await readFile(candidatePath, "utf8")) as typeof raw;
          if (candidate?.complete === true) {
            path = candidatePath;
            raw = candidate;
            break;
          }
        }
        assert.ok(path);
        assert.ok(raw);
        raw.results[0]!.judgeScore = 0.01;
        await writeFile(path, `${JSON.stringify(raw)}\n`);
      }
      return fake.runner(invocation);
    };

    const result = await evaluatePaired(evaluationOptions(f, f.state, runner));

    assert.equal(result.stopped, true);
    assert.equal(fake.calls.filter((call) => call.kind === "compare").length, 3);
    assert.match(result.state.stopReason ?? "", /changed while candidate code was running/u);
    const trustedFirst = result.attempts.find((attempt) => attempt.slotIndex === 0)!;
    assert.notEqual(trustedFirst.results[0]?.judgeScore, 0.01);
  });

  it("stops after one child when it injects valid evidence for a future slot", async () => {
    const f = await fixture({ pairedSlots: 2 });
    const schedule = createPairedSchedule({
      campaignId: f.spec.id,
      candidateId: "candidate-1",
      cohort: "targeted",
      seed: f.spec.seed,
      taskIds: f.spec.cohorts.targeted.taskIds,
      pairedSlots: f.spec.cohorts.targeted.pairedSlots,
    });
    const future = schedule[1]!;
    const fake = fakeRunner(f);
    let compareRuns = 0;
    const runner: ChildRunner = async (invocation) => {
      const child = await fake.runner(invocation);
      if (invocation.kind === "compare" && ++compareRuns === 1) {
        await writeForgedCompletedAttempt(f, future);
      }
      return child;
    };

    const result = await evaluatePaired(evaluationOptions(f, f.state, runner));

    assert.equal(result.stopped, true);
    assert.equal(result.state.physicalRunsUsed, 1);
    assert.equal(fake.calls.filter((call) => call.kind === "compare").length, 1);
    assert.match(result.state.stopReason ?? "", /stage attempt set changed/u);
    assert.equal(result.attempts.length, 1, "returned evidence must use only the trusted in-memory view");
    assert.equal(result.attempts[0]!.slotId, schedule[0]!.slotId);
    assert.equal(result.attempts[0]!.results.length, 1);
    assert.ok(result.attempts.every((attempt) => attempt.slotId !== future.slotId));
    assert.equal((await loadAttempt(f.paths, future.slotId))?.complete, true);
  });

  it("clears stale in-flight state after a full slot was durably saved", async () => {
    const f = await fixture({ pairedSlots: 1 });
    const fake = fakeRunner(f);
    const completed = await evaluatePaired(evaluationOptions(f, f.state, fake.runner));
    assert.equal(completed.stopped, false);
    const attempt = completed.attempts[0]!;
    const last = attempt.results[1]!;
    const stale = campaignStateSchema.parse({
      ...completed.state,
      phase: "evaluating",
      inFlight: {
        kind: "compare",
        commit: last.commit,
        startedAt: last.startedAt,
        slotId: attempt.slotId,
        arm: last.arm,
      },
    });
    await saveCampaignState(f.paths, stale);
    const callsBeforeResume = fake.calls.length;

    const resumed = await evaluatePaired(evaluationOptions(f, stale, fake.runner));
    assert.equal(resumed.stopped, false);
    assert.equal(resumed.state.inFlight, undefined);
    assert.equal(fake.calls.length, callsBeforeResume);
  });

  it("accounts interrupted install/build wall time and stops without launching", async () => {
    for (const kind of ["install", "build"] as const) {
      const f = await fixture({ pairedSlots: 1 });
      const interrupted = campaignStateSchema.parse({
        ...f.state,
        phase: "evaluating",
        wallClockMsUsed: 125,
        buildWallClockMsUsed: 75,
        verificationWallClockMsUsed: 50,
        inFlight: {
          kind,
          commit: kind === "install" ? baseCommit : candidateCommit,
          startedAt: "2026-07-17T11:59:55.000Z",
        },
      });
      await saveCampaignState(f.paths, interrupted);
      const fake = fakeRunner(f);

      const result = await evaluatePaired(evaluationOptions(f, interrupted, fake.runner));
      assert.equal(result.stopped, true, kind);
      assert.equal(result.state.phase, "stopped", kind);
      assert.equal(result.state.inFlight, undefined, kind);
      assert.equal(result.state.wallClockMsUsed, 5_125, kind);
      assert.equal(result.state.buildWallClockMsUsed, 5_075, kind);
      assert.match(result.state.stopReason ?? "", new RegExp(`interrupted during ${kind}`, "u"), kind);
      assert.equal(fake.calls.length, 0, kind);

      const persisted = campaignStateSchema.parse(JSON.parse(await readFile(f.paths.state, "utf8")) as unknown);
      assert.equal(persisted.phase, "stopped", kind);
      assert.equal(persisted.wallClockMsUsed, 5_125, kind);
      assert.equal(persisted.buildWallClockMsUsed, 5_075, kind);
    }
  });

  it("recovers the final-budget reserved arm as infrastructure failure without spending it twice", async () => {
    const f = await fixture({ pairedSlots: 1, maxPhysicalRuns: 1 });
    await Promise.all([
      mkdir(join(f.baseWorktree, "dist"), { recursive: true }),
      mkdir(join(f.candidateWorktree, "dist"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(f.baseWorktree, "dist", "index.js"), "// base\n"),
      writeFile(join(f.candidateWorktree, "dist", "index.js"), "// candidate\n"),
    ]);
    const slot = createPairedSchedule({
      campaignId: f.spec.id,
      candidateId: "candidate-1",
      cohort: "targeted",
      seed: f.spec.seed,
      taskIds: f.spec.cohorts.targeted.taskIds,
      pairedSlots: 1,
    })[0]!;
    const reservedArm = slot.order[0];
    const revision = reservedArm === "base"
      ? { commit: baseCommit, worktreePath: f.baseWorktree }
      : { commit: candidateCommit, worktreePath: f.candidateWorktree };
    const attempt: Attempt = {
      version: 1,
      campaignId: f.spec.id,
      candidateId: "candidate-1",
      cohort: "targeted",
      slotId: slot.slotId,
      slotIndex: slot.slotIndex,
      taskId: slot.taskId,
      repetition: slot.repetition,
      order: slot.order,
      results: [],
      complete: false,
    };
    await saveAttempt(f.paths, attempt);
    const wireRoot = join(f.paths.traces, slot.slotId, reservedArm);
    const runId = "run_reserved";
    await mkdir(join(wireRoot, "runs"), { recursive: true });
    await writeFile(join(wireRoot, "runs", `${runId}.json`), JSON.stringify(persistedRun(runId)));
    const output = harnessOutputPath(revision.worktreePath, `${slot.slotId}-${reservedArm}`);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(harnessRecord({
      taskId: slot.taskId,
      objective: slot.taskId === "task-a" ? "Return A" : "Return B",
      runId,
    }))}\n`);
    const reservedState = campaignStateSchema.parse({
      ...f.state,
      phase: "evaluating",
      physicalRunsUsed: 1,
      inFlight: {
        kind: "compare",
        commit: revision.commit,
        startedAt: "2026-07-17T12:00:00.000Z",
        slotId: slot.slotId,
        arm: reservedArm,
      },
      builtRevisions: [
        {
          commit: baseCommit,
          worktreePath: f.baseWorktree,
          distSha256: await sha256Path(join(f.baseWorktree, "dist")),
        },
        {
          commit: candidateCommit,
          worktreePath: f.candidateWorktree,
          distSha256: await sha256Path(join(f.candidateWorktree, "dist")),
        },
      ],
    });
    await saveCampaignState(f.paths, reservedState);

    const fake = fakeRunner(f);
    const result = await evaluatePaired(evaluationOptions(f, reservedState, fake.runner));
    assert.equal(result.stopped, true);
    assert.equal(result.state.physicalRunsUsed, 1);
    assert.equal(fake.calls.filter((call) => call.kind === "compare").length, 0);
    const completed = await loadAttempt(f.paths, slot.slotId);
    assert.equal(completed?.results[0]?.runId, runId);
    assert.equal(completed?.results[0]?.subprocess.exitCode, null);
    assert.equal(completed?.results[0]?.status, "infrastructure-failure");
    assert.match(completed?.results[0]?.failureReason ?? "", /exit.*attested/u);
    assert.equal(completed?.complete, false);
  });

  it("reserves before isolation preparation and records a preparation failure once", async () => {
    const f = await fixture({ pairedSlots: 1, maxPhysicalRuns: 1 });
    const slot = createPairedSchedule({
      campaignId: f.spec.id,
      candidateId: "candidate-1",
      cohort: "targeted",
      seed: f.spec.seed,
      taskIds: f.spec.cohorts.targeted.taskIds,
      pairedSlots: f.spec.cohorts.targeted.pairedSlots,
    })[0]!;
    await writeFile(join(f.paths.traces, slot.slotId), "not a directory\n");
    const fake = fakeRunner(f);

    const result = await evaluatePaired(evaluationOptions(f, f.state, fake.runner));

    assert.equal(result.stopped, true);
    assert.equal(result.state.physicalRunsUsed, 1);
    assert.equal(result.state.inFlight, undefined);
    assert.equal(fake.calls.filter((call) => call.kind === "compare").length, 0);
    const failed = result.attempts.find((attempt) => attempt.results.length === 1);
    assert.equal(failed?.results[0]?.status, "infrastructure-failure");
    assert.match(failed?.results[0]?.failureReason ?? "", /preparation failed/u);

    const persisted = campaignStateSchema.parse(JSON.parse(await readFile(f.paths.state, "utf8")) as unknown);
    assert.equal(persisted.physicalRunsUsed, 1);
    assert.equal(persisted.inFlight, undefined);
  });

  it("supports ZAI, rejects ignored .env inputs, and excludes candidate PATH shadows", async () => {
    const zai = await fixture();
    const zaiSpec = campaignSpecSchema.parse({
      ...zai.spec,
      wire: { ...zai.spec.wire, provider: "zai" },
    });
    const zaiFake = fakeRunner(zai);
    const zaiResult = await evaluatePaired({
      ...evaluationOptions(zai, zai.state, zaiFake.runner),
      spec: zaiSpec,
      env: { ...zai.env, ZAI_API_KEY: "fixture-zai-key" },
    });
    assert.equal(zaiResult.stopped, false);
    assert.equal(zaiFake.calls.filter((call) => call.kind === "compare").length, 4);
    assert.ok(zaiFake.calls.filter((call) => call.kind === "compare").every((call) => (
      call.env.ZAI_API_KEY === "fixture-zai-key" && call.env.WIRE_PROVIDER === "zai"
    )));

    const localEnv = await fixture();
    await writeFile(join(localEnv.candidateWorktree, ".env.local"), "WIRE_ROOT=/tmp/not-isolated\n");
    const envFake = fakeRunner(localEnv);
    const envResult = await evaluatePaired(evaluationOptions(localEnv, localEnv.state, envFake.runner));
    assert.equal(envResult.stopped, true);
    assert.match(envResult.state.stopReason ?? "", /revision-local \.env/u);
    assert.equal(envFake.calls.length, 0);

    const shadow = await fixture({ pairedSlots: 1 });
    const shadowBin = join(shadow.candidateWorktree, "node_modules", ".bin");
    await mkdir(shadowBin, { recursive: true });
    for (const name of ["claude", "node", "wire"]) {
      await writeFile(join(shadowBin, name), "#!/bin/sh\nexit 99\n", { mode: 0o755 });
    }
    shadow.env.PATH = `${shadowBin}${delimiter}${shadow.env.PATH ?? ""}`;
    const shadowFake = fakeRunner(shadow);
    const shadowResult = await evaluatePaired(evaluationOptions(shadow, shadow.state, shadowFake.runner));
    assert.equal(shadowResult.stopped, false);
    const shadowCompares = shadowFake.calls.filter((call) => call.kind === "compare");
    assert.equal(shadowCompares.length, 2);
    assert.ok(shadowCompares.every((call) => (
      !call.env.PATH?.includes("node_modules")
      && call.command === process.execPath
      && call.args[0] === "--experimental-strip-types"
    )));
  });
});
