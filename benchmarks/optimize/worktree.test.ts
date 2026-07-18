import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { strict as assert } from "node:assert";
import { test } from "node:test";

import type { CandidateResponse } from "./model.js";
import { sha256Path } from "./state.js";
import {
  cleanupCampaignWorktrees,
  createClaudeJudgeShim,
  createDetachedBaseWorktree,
  createDetachedCandidateWorktree,
  createWireShim,
  harnessEnvironment,
  prepareAttemptIsolation,
  spawnGit,
  validateCandidateWorktree,
  type GitRequest,
} from "./worktree.js";

interface RepositoryFixture {
  parent: string;
  repositoryRoot: string;
  baseCommit: string;
  frozenSuitePath: string;
  worktrees: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await spawnGit({ cwd, args });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

async function write(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function makeRepository(): Promise<RepositoryFixture> {
  const parent = await mkdtemp(join(tmpdir(), "wire-optimize-worktree-"));
  const repositoryRoot = join(parent, "repository");
  await mkdir(repositoryRoot);
  await git(repositoryRoot, ["init", "-b", "main"]);
  await git(repositoryRoot, ["config", "user.name", "Wire Optimizer Test"]);
  await git(repositoryRoot, ["config", "user.email", "optimizer@example.invalid"]);
  await write(join(repositoryRoot, ".gitignore"), ".wire/\ndist/\nnode_modules/\n");
  await write(join(repositoryRoot, "src", "core.ts"), "export const value = 1;\n");
  await write(join(repositoryRoot, "src", "core.test.ts"), "export const tested = true;\n");
  await write(join(repositoryRoot, "skills", "site", "SKILL.md"), "# Site\nKeep this\nRemove this\n");
  await write(join(repositoryRoot, "benchmarks", "compare", "run-compare.ts"), "export {};\n");
  await write(join(repositoryRoot, "benchmarks", "benchmark_tasks.json"), "{}\n");
  await write(join(repositoryRoot, "benchmarks", "benchmark_tasks.schema.json"), "{}\n");
  const frozenSuitePath = join(repositoryRoot, "benchmarks", "frozen-suite.json");
  await write(frozenSuitePath, "[]\n");
  await write(join(repositoryRoot, "package.json"), "{\"private\":true}\n");
  await write(join(repositoryRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await git(repositoryRoot, ["add", "-A"]);
  await git(repositoryRoot, ["commit", "-m", "initial"]);
  const baseCommit = await git(repositoryRoot, ["rev-parse", "HEAD"]);
  return {
    parent,
    repositoryRoot,
    baseCommit,
    frozenSuitePath,
    worktrees: join(repositoryRoot, ".wire", "optimizer", "campaign-1", "worktrees"),
  };
}

async function makeCandidate(
  fixture: RepositoryFixture,
  changes: Readonly<Record<string, string>>,
): Promise<{ path: string; commit: string; changedFiles: string[] }> {
  const path = join(fixture.parent, "candidate");
  await git(fixture.repositoryRoot, [
    "worktree",
    "add",
    "-b",
    "candidate",
    path,
    fixture.baseCommit,
  ]);
  for (const [name, content] of Object.entries(changes)) {
    await write(join(path, name), content);
  }
  await git(path, ["add", "-A"]);
  await git(path, ["commit", "-m", "candidate"]);
  return {
    path,
    commit: await git(path, ["rev-parse", "HEAD"]),
    changedFiles: Object.keys(changes).sort((left, right) => left.localeCompare(right)),
  };
}

function responseFor(
  fixture: RepositoryFixture,
  candidate: { path: string; commit: string; changedFiles: string[] },
  changedFiles = candidate.changedFiles,
): CandidateResponse {
  return {
    version: 1,
    campaignId: "campaign-1",
    requestId: "request-1",
    candidateId: "candidate-1",
    baseCommit: fixture.baseCommit,
    worktreePath: candidate.path,
    candidateCommit: candidate.commit,
    hypothesis: "Replace the demonstrated behavior with the smaller cross-site implementation.",
    recommendedHome: "core",
    changedFiles,
    testsRun: ["pnpm check", "pnpm optimize:test"],
  };
}

async function removeFixture(fixture: RepositoryFixture): Promise<void> {
  await rm(fixture.parent, { recursive: true, force: true });
}

test("creates one recorded detached base worktree with argument-array Git calls", async () => {
  const fixture = await makeRepository();
  const requests: GitRequest[] = [];
  const runner = async (request: GitRequest) => {
    requests.push({ cwd: request.cwd, args: [...request.args] });
    return spawnGit(request);
  };
  const now = () => new Date("2026-07-17T12:00:00.000Z");
  try {
    const created = await createDetachedBaseWorktree({
      repositoryRoot: fixture.repositoryRoot,
      paths: { worktrees: fixture.worktrees },
      baseCommit: fixture.baseCommit,
      runner,
      now,
    });
    assert.equal(created.path, join(fixture.worktrees, "base"));
    assert.equal(created.commit, fixture.baseCommit);
    assert.equal(created.status, "active");
    assert.ok(requests.some((request) => (
      request.args[0] === "worktree"
      && request.args[1] === "add"
      && request.args[2] === "--detach"
      && request.args[3] === created.path
      && request.args[4] === fixture.baseCommit
      && request.args.length === 5
    )));

    const symbolic = await spawnGit({ cwd: created.path, args: ["symbolic-ref", "-q", "HEAD"] });
    assert.equal(symbolic.code, 1);
    const registry = JSON.parse(await readFile(join(fixture.worktrees, "created-worktrees.json"), "utf8")) as {
      worktrees: Array<{ path: string; status: string }>;
    };
    assert.deepEqual(registry.worktrees, [{
      id: "base",
      kind: "base",
      repositoryRoot: fixture.repositoryRoot,
      path: created.path,
      commit: fixture.baseCommit,
      status: "active",
      createdAt: "2026-07-17T12:00:00.000Z",
      updatedAt: "2026-07-17T12:00:00.000Z",
    }]);

    const reopened = await createDetachedBaseWorktree({
      repositoryRoot: fixture.repositoryRoot,
      paths: { worktrees: fixture.worktrees },
      baseCommit: fixture.baseCommit,
      runner,
      now,
    });
    assert.deepEqual(reopened, created);
    assert.equal(requests.filter((request) => request.args[0] === "worktree" && request.args[1] === "add").length, 1);
  } finally {
    await removeFixture(fixture);
  }
});

test("evaluates a submitted candidate from a detached controller-owned worktree", async () => {
  const fixture = await makeRepository();
  const requests: GitRequest[] = [];
  const runner = async (request: GitRequest) => {
    requests.push({ cwd: request.cwd, args: [...request.args] });
    return spawnGit(request);
  };
  try {
    const submitted = await makeCandidate(fixture, {
      "src/core.ts": "export const value = 2;\n",
    });
    const submittedNodeModules = join(submitted.path, "node_modules", "fake-package", "index.js");
    const submittedDist = join(submitted.path, "dist", "stale.js");
    await write(submittedNodeModules, "module.exports = 'submitted only';\n");
    await write(submittedDist, "export const stale = true;\n");
    assert.equal(await git(submitted.path, ["status", "--porcelain=v1", "--untracked-files=all"]), "");

    const evaluation = await createDetachedCandidateWorktree({
      repositoryRoot: fixture.repositoryRoot,
      paths: { worktrees: fixture.worktrees },
      candidateId: "candidate-1",
      candidateCommit: submitted.commit,
      runner,
    });
    assert.equal(evaluation.kind, "candidate");
    assert.equal(evaluation.id, "candidate-1");
    assert.equal(evaluation.path, join(fixture.worktrees, "candidates", "candidate-1"));
    assert.equal(await git(evaluation.path, ["rev-parse", "HEAD"]), submitted.commit);
    const symbolic = await spawnGit({ cwd: evaluation.path, args: ["symbolic-ref", "-q", "HEAD"] });
    assert.equal(symbolic.code, 1);
    assert.equal(await readFile(join(evaluation.path, "src", "core.ts"), "utf8"), "export const value = 2;\n");
    await assert.rejects(access(join(evaluation.path, "node_modules")), { code: "ENOENT" });
    await assert.rejects(access(join(evaluation.path, "dist")), { code: "ENOENT" });
    await access(submittedNodeModules);
    await access(submittedDist);

    const reopened = await createDetachedCandidateWorktree({
      repositoryRoot: fixture.repositoryRoot,
      paths: { worktrees: fixture.worktrees },
      candidateId: "candidate-1",
      candidateCommit: submitted.commit,
      runner,
    });
    assert.deepEqual(reopened, evaluation);
    assert.equal(
      requests.filter((request) => request.args[0] === "worktree" && request.args[1] === "add").length,
      1,
    );

    assert.deepEqual(await cleanupCampaignWorktrees({
      repositoryRoot: fixture.repositoryRoot,
      paths: { worktrees: fixture.worktrees },
      runner,
    }), [evaluation.path]);
    await assert.rejects(access(evaluation.path), { code: "ENOENT" });
    await access(submitted.path);
    await access(submittedNodeModules);
    await access(submittedDist);
    assert.equal(await git(submitted.path, ["rev-parse", "HEAD"]), submitted.commit);
  } finally {
    await removeFixture(fixture);
  }
});

test("validates candidate provenance and reports production churn and existing test edits", async () => {
  const fixture = await makeRepository();
  try {
    const candidate = await makeCandidate(fixture, {
      "src/core.ts": [
        "export const value = 2;",
        "export const another = 3;",
        "export const final = 4;",
        "",
      ].join("\n"),
      "src/core.test.ts": "export const tested = 'updated';\n",
    });
    const response = responseFor(fixture, candidate);
    const validation = await validateCandidateWorktree({
      repositoryRoot: fixture.repositoryRoot,
      campaignId: "campaign-1",
      baseCommit: fixture.baseCommit,
      frozenSuitePath: fixture.frozenSuitePath,
      response,
    });
    assert.deepEqual(validation.changedFiles, ["src/core.test.ts", "src/core.ts"]);
    assert.equal(validation.changedProductionLines, 4);
    assert.equal(validation.productionLineDelta, 2);
    assert.deepEqual(validation.changedTestFiles, ["src/core.test.ts"]);
    assert.deepEqual(validation.existingTestFilesChanged, ["src/core.test.ts"]);

    await assert.rejects(
      validateCandidateWorktree({
        repositoryRoot: fixture.repositoryRoot,
        campaignId: "campaign-1",
        baseCommit: fixture.baseCommit,
        frozenSuitePath: fixture.frozenSuitePath,
        response: responseFor(fixture, candidate, ["src/core.ts"]),
      }),
      /changedFiles mismatch/u,
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("counts durable skill content in the behavioral simplicity metric", async () => {
  const fixture = await makeRepository();
  try {
    const candidate = await makeCandidate(fixture, {
      "skills/site/SKILL.md": "# Site\n",
    });
    const validation = await validateCandidateWorktree({
      repositoryRoot: fixture.repositoryRoot,
      campaignId: "campaign-1",
      baseCommit: fixture.baseCommit,
      frozenSuitePath: fixture.frozenSuitePath,
      response: responseFor(fixture, candidate),
    });

    assert.equal(validation.changedProductionLines, 2);
    assert.equal(validation.productionLineDelta, -2);
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects protected evaluator inputs, frozen suites, dependencies, and lockfiles", async () => {
  const fixture = await makeRepository();
  try {
    const candidate = await makeCandidate(fixture, {
      "benchmarks/compare/run-compare.ts": "export const altered = true;\n",
      "benchmarks/benchmark_tasks.json": "{\"altered\":true}\n",
      "benchmarks/frozen-suite.json": "[{\"id\":\"altered\"}]\n",
      "packages/tool/package.json": "{\"dependencies\":{\"left-pad\":\"1.0.0\"}}\n",
      "yarn.lock": "altered\n",
      ".env": "OPENAI_API_KEY=not-a-real-key\n",
      ".npmrc": "registry=https://attacker.invalid\n",
      ".pnpmfile.cjs": "module.exports = { hooks: {} };\n",
      "pnpm-workspace.yaml": "packages: ['malicious/*']\n",
      ".gitattributes": "* diff=malicious\n",
    });
    await assert.rejects(
      validateCandidateWorktree({
        repositoryRoot: fixture.repositoryRoot,
        campaignId: "campaign-1",
        baseCommit: fixture.baseCommit,
        frozenSuitePath: fixture.frozenSuitePath,
        response: responseFor(fixture, candidate),
      }),
      (error: unknown) => {
        assert.match(String(error), /benchmarks\/compare\/run-compare\.ts/u);
        assert.match(String(error), /benchmarks\/benchmark_tasks\.json/u);
        assert.match(String(error), /benchmarks\/frozen-suite\.json/u);
        assert.match(String(error), /packages\/tool\/package\.json/u);
        assert.match(String(error), /yarn\.lock/u);
        assert.match(String(error), /\.pnpmfile\.cjs/u);
        assert.match(String(error), /pnpm-workspace\.yaml/u);
        return true;
      },
    );
  } finally {
    await removeFixture(fixture);
  }
});

test("rejects changed symbolic links and gitlinks as mutable candidate inputs", async () => {
  const symlinkFixture = await makeRepository();
  try {
    const candidatePath = join(symlinkFixture.parent, "candidate");
    await git(symlinkFixture.repositoryRoot, [
      "worktree",
      "add",
      "-b",
      "candidate",
      candidatePath,
      symlinkFixture.baseCommit,
    ]);
    const externalSource = join(symlinkFixture.parent, "external-core.ts");
    await write(externalSource, "export const value = 99;\n");
    await symlink(externalSource, join(candidatePath, "src", "external-core.ts"));
    await git(candidatePath, ["add", "-A"]);
    await git(candidatePath, ["commit", "-m", "symlink candidate"]);
    const candidate = {
      path: candidatePath,
      commit: await git(candidatePath, ["rev-parse", "HEAD"]),
      changedFiles: ["src/external-core.ts"],
    };

    await assert.rejects(
      validateCandidateWorktree({
        repositoryRoot: symlinkFixture.repositoryRoot,
        campaignId: "campaign-1",
        baseCommit: symlinkFixture.baseCommit,
        frozenSuitePath: symlinkFixture.frozenSuitePath,
        response: responseFor(symlinkFixture, candidate),
      }),
      /src\/external-core\.ts \(symbolic link\)/u,
    );
  } finally {
    await removeFixture(symlinkFixture);
  }

  const gitlinkFixture = await makeRepository();
  try {
    const externalRepository = join(gitlinkFixture.parent, "external-repository");
    await mkdir(externalRepository);
    await git(externalRepository, ["init", "-b", "main"]);
    await git(externalRepository, ["config", "user.name", "Wire Optimizer Test"]);
    await git(externalRepository, ["config", "user.email", "optimizer@example.invalid"]);
    await write(join(externalRepository, "index.ts"), "export const external = true;\n");
    await git(externalRepository, ["add", "-A"]);
    await git(externalRepository, ["commit", "-m", "external"]);

    const candidatePath = join(gitlinkFixture.parent, "candidate");
    await git(gitlinkFixture.repositoryRoot, [
      "worktree",
      "add",
      "-b",
      "candidate",
      candidatePath,
      gitlinkFixture.baseCommit,
    ]);
    await git(candidatePath, [
      "-c",
      "protocol.file.allow=always",
      "submodule",
      "add",
      "--",
      externalRepository,
      "src/external",
    ]);
    await git(candidatePath, ["commit", "-m", "gitlink candidate"]);
    const candidate = {
      path: candidatePath,
      commit: await git(candidatePath, ["rev-parse", "HEAD"]),
      changedFiles: [".gitmodules", "src/external"],
    };

    await assert.rejects(
      validateCandidateWorktree({
        repositoryRoot: gitlinkFixture.repositoryRoot,
        campaignId: "campaign-1",
        baseCommit: gitlinkFixture.baseCommit,
        frozenSuitePath: gitlinkFixture.frozenSuitePath,
        response: responseFor(gitlinkFixture, candidate),
      }),
      /src\/external \(gitlink\)/u,
    );
  } finally {
    await removeFixture(gitlinkFixture);
  }
});

test("rejects dirty candidates and commits that do not descend from the selected base", async () => {
  const dirtyFixture = await makeRepository();
  try {
    const candidate = await makeCandidate(dirtyFixture, {
      "src/core.ts": "export const value = 2;\n",
    });
    await write(join(candidate.path, "uncommitted.txt"), "dirty\n");
    await assert.rejects(
      validateCandidateWorktree({
        repositoryRoot: dirtyFixture.repositoryRoot,
        campaignId: "campaign-1",
        baseCommit: dirtyFixture.baseCommit,
        frozenSuitePath: dirtyFixture.frozenSuitePath,
        response: responseFor(dirtyFixture, candidate),
      }),
      /not clean/u,
    );
  } finally {
    await removeFixture(dirtyFixture);
  }

  const ancestryFixture = await makeRepository();
  try {
    const tree = await git(ancestryFixture.repositoryRoot, ["rev-parse", `${ancestryFixture.baseCommit}^{tree}`]);
    const unrelatedCommit = await git(ancestryFixture.repositoryRoot, ["commit-tree", tree, "-m", "unrelated root"]);
    const candidatePath = join(ancestryFixture.parent, "candidate");
    await git(ancestryFixture.repositoryRoot, ["worktree", "add", "--detach", candidatePath, unrelatedCommit]);
    const candidate = { path: candidatePath, commit: unrelatedCommit, changedFiles: ["src/core.ts"] };
    await assert.rejects(
      validateCandidateWorktree({
        repositoryRoot: ancestryFixture.repositoryRoot,
        campaignId: "campaign-1",
        baseCommit: ancestryFixture.baseCommit,
        frozenSuitePath: ancestryFixture.frozenSuitePath,
        response: responseFor(ancestryFixture, candidate),
      }),
      /does not descend from base/u,
    );
  } finally {
    await removeFixture(ancestryFixture);
  }
});

test("cleanup refuses dirty campaign worktrees and never removes unrecorded operator worktrees", async () => {
  const fixture = await makeRepository();
  try {
    const base = await createDetachedBaseWorktree({
      repositoryRoot: fixture.repositoryRoot,
      paths: { worktrees: fixture.worktrees },
      baseCommit: fixture.baseCommit,
    });
    const operatorPath = join(fixture.parent, "operator-worktree");
    await git(fixture.repositoryRoot, [
      "worktree",
      "add",
      "-b",
      "operator-candidate",
      operatorPath,
      fixture.baseCommit,
    ]);
    await write(join(base.path, "src/core.ts"), "export const value = 99;\n");
    await assert.rejects(
      cleanupCampaignWorktrees({
        repositoryRoot: fixture.repositoryRoot,
        paths: { worktrees: fixture.worktrees },
      }),
      /not clean/u,
    );
    await access(base.path);
    await access(operatorPath);

    await write(join(base.path, "src/core.ts"), "export const value = 1;\n");
    await write(join(base.path, ".wire", "private.log"), "unknown ignored residue\n");
    await assert.rejects(
      cleanupCampaignWorktrees({
        repositoryRoot: fixture.repositoryRoot,
        paths: { worktrees: fixture.worktrees },
      }),
      /unknown ignored residue/u,
    );
    await access(join(base.path, ".wire", "private.log"));
    await rm(join(base.path, ".wire"), { recursive: true });
    await write(join(base.path, "dist", "generated.js"), "ignored build product\n");
    const removed = await cleanupCampaignWorktrees({
      repositoryRoot: fixture.repositoryRoot,
      paths: { worktrees: fixture.worktrees },
    });
    assert.deepEqual(removed, [base.path]);
    await assert.rejects(access(base.path), { code: "ENOENT" });
    await access(operatorPath);
    assert.deepEqual(await cleanupCampaignWorktrees({
      repositoryRoot: fixture.repositoryRoot,
      paths: { worktrees: fixture.worktrees },
    }), []);
  } finally {
    await removeFixture(fixture);
  }
});

test("cleanup rechecks the real worktree path before removing ignored outputs", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await makeRepository();
  try {
    const base = await createDetachedBaseWorktree({
      repositoryRoot: fixture.repositoryRoot,
      paths: { worktrees: fixture.worktrees },
      baseCommit: fixture.baseCommit,
    });
    const operatorPath = join(fixture.parent, "operator-worktree");
    await git(fixture.repositoryRoot, [
      "worktree",
      "add",
      "--detach",
      operatorPath,
      fixture.baseCommit,
    ]);
    const operatorOutput = join(operatorPath, "dist", "must-survive.txt");
    await write(operatorOutput, "operator-owned ignored output\n");

    let ordinaryStatusCalls = 0;
    const displacedPath = join(fixture.parent, "displaced-controller-worktree");
    const racingRunner = async (request: GitRequest) => {
      const result = await spawnGit(request);
      if (
        request.cwd === base.path
        && request.args[0] === "status"
        && !request.args.includes("--ignored=matching")
        && ++ordinaryStatusCalls === 2
      ) {
        await rename(base.path, displacedPath);
        await symlink(operatorPath, base.path, "dir");
      }
      return result;
    };

    await assert.rejects(
      cleanupCampaignWorktrees({
        repositoryRoot: fixture.repositoryRoot,
        paths: { worktrees: fixture.worktrees },
        runner: racingRunner,
      }),
      /Worktree path is not a real directory/u,
    );
    assert.equal(await readFile(operatorOutput, "utf8"), "operator-owned ignored output\n");
  } finally {
    await removeFixture(fixture);
  }
});

test("allocates isolated attempt roots from the same snapshot and pins wire to the exact worktree", async () => {
  const parent = await mkdtemp(join(tmpdir(), "wire-optimize-isolation-"));
  try {
    const snapshot = join(parent, "snapshot");
    await write(join(snapshot, "example", "SKILL.md"), "# Stable snapshot\n");
    const snapshotHash = await sha256Path(snapshot);
    const paths = {
      traces: join(parent, "campaign", "traces"),
      skills: join(parent, "campaign", "skills"),
    };
    const base = await prepareAttemptIsolation({
      paths,
      slotId: "slot-1",
      arm: "base",
      skillSnapshotPath: snapshot,
      skillSnapshotHash: snapshotHash,
    });
    const candidate = await prepareAttemptIsolation({
      paths,
      slotId: "slot-1",
      arm: "candidate",
      skillSnapshotPath: snapshot,
      skillSnapshotHash: snapshotHash,
    });
    assert.notEqual(base.wireRoot, candidate.wireRoot);
    assert.notEqual(base.skillRoot, candidate.skillRoot);
    assert.equal(base.skillSnapshotHash, candidate.skillSnapshotHash);
    await write(join(base.skillRoot, "example", "SKILL.md"), "# Mutated base copy\n");
    assert.equal(
      await readFile(join(candidate.skillRoot, "example", "SKILL.md"), "utf8"),
      "# Stable snapshot\n",
    );
    await assert.rejects(
      prepareAttemptIsolation({
        paths,
        slotId: "slot-1",
        arm: "base",
        skillSnapshotPath: snapshot,
        skillSnapshotHash: snapshotHash,
      }),
      /already exists/u,
    );

    const builtWorktree = join(parent, "built-worktree");
    const wireEntry = join(builtWorktree, "dist", "index.js");
    await write(wireEntry, [
      "const crypto = require('node:crypto');",
      "console.log(JSON.stringify({ entry: process.argv[1], args: process.argv.slice(2), hash: crypto.createHash('sha256').update('candidate').digest('hex'), allowed: process.env.SELECTED_KEY, secret: process.env.SECRET_DO_NOT_PERSIST }));",
      "",
    ].join("\n"));
    const launcherDirectory = join(parent, "attempts", "launchers", "slot-1", "candidate");
    const binDir = await createWireShim(candidate, builtWorktree, {
      launcherDirectory,
      candidateEnvironment: {
        HOME: join(candidate.wireRoot, "home"),
        PATH: dirname(process.execPath),
        WIRE_ROOT: candidate.wireRoot,
        WIRE_SKILLS: candidate.skillRoot,
        SELECTED_KEY: "selected-secret-do-not-copy",
      },
      forwardedEnvironmentKeys: ["SELECTED_KEY"],
      timeoutMs: 10_000,
    });
    const launcher = await readFile(join(binDir, "wire"), "utf8");
    assert.match(launcher, new RegExp(wireEntry.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(launcher, /systemd-run/u);
    assert.match(launcher, /KillMode=control-group/u);
    assert.match(launcher, /ProtectHome=tmpfs/u);
    assert.match(launcher, /--setenv=SELECTED_KEY/u);
    assert.doesNotMatch(launcher, /selected-secret-do-not-copy|SECRET_DO_NOT_PERSIST|blocked/u);

    const harnessHome = join(launcherDirectory, "home");
    await mkdir(harnessHome, { recursive: true });
    const controllerClaude = join(parent, "controller-bin", "claude-pinned");
    await write(controllerClaude, "#!/bin/sh\nexit 0\n");
    await chmod(controllerClaude, 0o755);
    await createClaudeJudgeShim({
      launcherDirectory,
      claudeExecutable: controllerClaude,
      harnessHome,
    });
    const judgeLauncher = await readFile(join(launcherDirectory, "claude"), "utf8");
    assert.match(judgeLauncher, new RegExp(controllerClaude.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(judgeLauncher, /ANTHROPIC_API_KEY/u);
    assert.match(judgeLauncher, /spawnSync\(target, process\.argv\.slice\(2\)/u);
    assert.match(judgeLauncher, /stdio: 'inherit'/u);
    assert.doesNotMatch(
      judgeLauncher,
      /STEEL_API_KEY|STEEL_BASE_URL|WIRE_ROOT|WIRE_SKILLS|WIRE_PROVIDER|OPENAI_API_KEY|ZAI_API_KEY|SELECTED_KEY|selected-secret-do-not-copy|blocked/u,
    );

    const environment = harnessEnvironment({
      isolation: candidate,
      launcherDirectory,
      harnessHome,
      inheritedEnv: { PATH: "/operator/bin", SECRET_DO_NOT_PERSIST: "present" },
    });
    assert.equal(environment.WIRE_ROOT, candidate.wireRoot);
    assert.equal(environment.WIRE_SKILLS, candidate.skillRoot);
    assert.deepEqual(environment.PATH?.split(delimiter), [
      binDir,
      dirname(process.execPath),
    ]);
    assert.equal(environment.HOME, harnessHome);
    assert.equal(environment.SECRET_DO_NOT_PERSIST, undefined);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
