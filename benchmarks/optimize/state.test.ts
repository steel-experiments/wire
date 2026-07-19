import * as assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  campaignPaths,
  initializeCampaign,
  listAttempts,
  loadCampaign,
  saveAttempt,
  saveCampaignState,
  saveCandidateResponse,
  sha256Path,
  verifyFrozenInputs,
} from "./state.js";

const roots: string[] = [];
const commit = "b".repeat(40);

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{
  root: string;
  optimizerRoot: string;
  recipePath: string;
  suitePath: string;
  skillsPath: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "wire-opt-state-"));
  roots.push(root);
  const suitePath = join(root, "suite.json");
  const skillsPath = join(root, "skills");
  await mkdir(skillsPath);
  await writeFile(suitePath, JSON.stringify([
    { id: "task-a", objective: "A", maxSteps: 2 },
    { id: "task-b", objective: "B", maxSteps: 2 },
  ]));
  await writeFile(join(skillsPath, "site.md"), "# durable skill\n");
  const recipePath = join(root, "recipe.json");
  await writeFile(recipePath, JSON.stringify({
    version: 1,
    id: "fixture-campaign",
    baseCommit: commit,
    suite: { path: "suite.json", sha256: await sha256Path(suitePath) },
    judge: { model: "judge", threshold: 0.7 },
    wire: { provider: "anthropic", model: "wire", timeoutMs: 60_000 },
    cohorts: {
      smoke: { taskIds: ["task-a"], pairedSlots: 1 },
      targeted: { taskIds: ["task-a"], pairedSlots: 2 },
      broad: { taskIds: ["task-a", "task-b"], pairedSlots: 2 },
    },
    budget: {
      maxPhysicalRuns: 20,
      maxCandidates: 2,
      maxWallClockMs: 1_000_000,
      maxConcurrency: 1,
    },
    skillSnapshot: { path: "skills", sha256: await sha256Path(skillsPath) },
    seed: "fixture-seed",
    gates: {
      minimumTargetedSuccessDelta: 2,
      minimumMeanJudgeDelta: 0.05,
      maxSimplificationJudgeRegression: 0.02,
      maxSmokeSuccessRegression: 0,
      maxBroadSuccessRegression: 0,
    },
  }, null, 2));
  return { root, optimizerRoot: join(root, "optimizer"), recipePath, suitePath, skillsPath };
}

describe("campaign initialization", () => {
  it("resolves paths, verifies inputs, and writes inspectable state atomically", async () => {
    const f = await fixture();
    const result = await initializeCampaign({
      optimizerRoot: f.optimizerRoot,
      recipePath: f.recipePath,
      baseCommit: commit,
      now: () => new Date("2026-07-17T12:00:00.000Z"),
    });
    assert.equal(result.reopened, false);
    assert.equal(result.spec.suite.path, f.suitePath);
    assert.equal(result.state.physicalRunsUsed, 0);
    const persisted = await readFile(result.paths.resolvedCampaign, "utf8");
    assert.equal(
      result.state.campaignSpecSha256,
      createHash("sha256").update(persisted).digest("hex"),
    );
    assert.doesNotMatch(persisted, /api[_-]?key|cookie|screenshot/iu);
    assert.deepEqual((await loadCampaign(f.optimizerRoot, "fixture-campaign")).state, result.state);
  });

  it("reopens the identical campaign idempotently", async () => {
    const f = await fixture();
    await initializeCampaign({ optimizerRoot: f.optimizerRoot, recipePath: f.recipePath, baseCommit: commit });
    const reopened = await initializeCampaign({
      optimizerRoot: f.optimizerRoot,
      recipePath: f.recipePath,
      baseCommit: commit,
    });
    assert.equal(reopened.reopened, true);
  });

  it("recovers when the resolved manifest exists but initial state write did not complete", async () => {
    const f = await fixture();
    const first = await initializeCampaign({
      optimizerRoot: f.optimizerRoot,
      recipePath: f.recipePath,
      baseCommit: commit,
    });
    await unlink(first.paths.state);
    const recovered = await initializeCampaign({
      optimizerRoot: f.optimizerRoot,
      recipePath: f.recipePath,
      baseCommit: commit,
    });
    assert.equal(recovered.reopened, false);
    assert.equal(recovered.state.campaignId, "fixture-campaign");
  });

  it("refuses a changed manifest under an existing campaign id", async () => {
    const f = await fixture();
    await initializeCampaign({ optimizerRoot: f.optimizerRoot, recipePath: f.recipePath, baseCommit: commit });
    const recipe = JSON.parse(await readFile(f.recipePath, "utf8")) as Record<string, unknown>;
    recipe.seed = "changed";
    await writeFile(f.recipePath, JSON.stringify(recipe));
    await assert.rejects(
      initializeCampaign({ optimizerRoot: f.optimizerRoot, recipePath: f.recipePath, baseCommit: commit }),
      /different manifest or base/u,
    );
  });

  it("rejects exact resolved-manifest drift even when campaign id and base stay unchanged", async () => {
    const mutations: Array<{
      label: string;
      mutate: (manifest: any, fixtureRoot: string) => void;
    }> = [
      {
        label: "gates",
        mutate: (manifest) => {
          manifest.gates.minimumTargetedSuccessDelta = 0;
        },
      },
      {
        label: "budget",
        mutate: (manifest) => {
          manifest.budget.maxPhysicalRuns += 100;
        },
      },
      {
        label: "suite path",
        mutate: (manifest, fixtureRoot) => {
          manifest.suite.path = join(fixtureRoot, "replacement-suite.json");
        },
      },
    ];

    for (const mutation of mutations) {
      const f = await fixture();
      const initialized = await initializeCampaign({
        optimizerRoot: f.optimizerRoot,
        recipePath: f.recipePath,
        baseCommit: commit,
      });
      const manifest = JSON.parse(
        await readFile(initialized.paths.resolvedCampaign, "utf8"),
      ) as any;
      mutation.mutate(manifest, f.root);
      await writeFile(initialized.paths.resolvedCampaign, JSON.stringify(manifest, null, 2));

      await assert.rejects(
        loadCampaign(f.optimizerRoot, "fixture-campaign"),
        new RegExp(`manifest digest mismatch`, "u"),
        mutation.label,
      );
      await assert.rejects(
        initializeCampaign({
          optimizerRoot: f.optimizerRoot,
          recipePath: f.recipePath,
          baseCommit: commit,
        }),
        new RegExp(`manifest digest mismatch`, "u"),
        `${mutation.label} reopen`,
      );
    }
  });

  it("rejects a selected base mismatch", async () => {
    const f = await fixture();
    await assert.rejects(
      initializeCampaign({
        optimizerRoot: f.optimizerRoot,
        recipePath: f.recipePath,
        baseCommit: "c".repeat(40),
      }),
      /does not match selected base/u,
    );
  });

  it("rejects hash drift and unknown cohort task ids", async () => {
    const f = await fixture();
    await writeFile(f.suitePath, "[]");
    await assert.rejects(
      initializeCampaign({ optimizerRoot: f.optimizerRoot, recipePath: f.recipePath, baseCommit: commit }),
      /hash mismatch/u,
    );

    const f2 = await fixture();
    const recipe = JSON.parse(await readFile(f2.recipePath, "utf8")) as any;
    recipe.cohorts.targeted.taskIds = ["missing-task"];
    await writeFile(f2.recipePath, JSON.stringify(recipe));
    await assert.rejects(
      initializeCampaign({ optimizerRoot: f2.optimizerRoot, recipePath: f2.recipePath, baseCommit: commit }),
      /Unknown targeted task id/u,
    );
  });

  it("detects input drift before a later stage", async () => {
    const f = await fixture();
    const { spec } = await initializeCampaign({
      optimizerRoot: f.optimizerRoot,
      recipePath: f.recipePath,
      baseCommit: commit,
    });
    await writeFile(join(f.skillsPath, "site.md"), "changed\n");
    await assert.rejects(verifyFrozenInputs(spec), /skill snapshot hash mismatch/u);
  });

  it("defers opening and hashing the sealed holdout until explicitly requested", async () => {
    const f = await fixture();
    const recipe = JSON.parse(await readFile(f.recipePath, "utf8")) as any;
    const holdoutPath = join(f.root, "sealed-holdout.json");
    await writeFile(holdoutPath, JSON.stringify([
      { id: "sealed-task", objective: "sealed objective", maxSteps: 2 },
    ]));
    recipe.cohorts.holdout = {
      externalSuitePath: "sealed-holdout.json",
      sha256: "0".repeat(64),
      slots: 1,
    };
    await writeFile(f.recipePath, JSON.stringify(recipe));

    const { spec } = await initializeCampaign({
      optimizerRoot: f.optimizerRoot,
      recipePath: f.recipePath,
      baseCommit: commit,
    });
    await assert.rejects(verifyFrozenInputs(spec, true), /holdout suite hash mismatch/u);
  });

  it("rejects symlinked and non-directory campaign-owned paths", async () => {
    const ancestor = await fixture();
    const redirectedOptimizer = join(ancestor.root, "redirected-optimizer");
    await mkdir(redirectedOptimizer);
    await symlink(redirectedOptimizer, ancestor.optimizerRoot, "dir");
    await assert.rejects(
      initializeCampaign({
        optimizerRoot: ancestor.optimizerRoot,
        recipePath: ancestor.recipePath,
        baseCommit: commit,
      }),
      /symlinked ancestor/u,
    );
    assert.deepEqual(await readdir(redirectedOptimizer), []);

    const linked = await fixture();
    const linkedPaths = campaignPaths(linked.optimizerRoot, "fixture-campaign");
    const redirect = join(linked.root, "redirected-campaign");
    await mkdir(linked.optimizerRoot, { recursive: true });
    await mkdir(redirect);
    await symlink(redirect, linkedPaths.root, "dir");
    await assert.rejects(
      initializeCampaign({
        optimizerRoot: linked.optimizerRoot,
        recipePath: linked.recipePath,
        baseCommit: commit,
      }),
      /not a real directory/u,
    );

    const blocked = await fixture();
    const blockedPaths = campaignPaths(blocked.optimizerRoot, "fixture-campaign");
    await mkdir(blockedPaths.root, { recursive: true });
    await writeFile(blockedPaths.attempts, "not a directory\n");
    await assert.rejects(
      initializeCampaign({
        optimizerRoot: blocked.optimizerRoot,
        recipePath: blocked.recipePath,
        baseCommit: commit,
      }),
      /not a real directory/u,
    );

    const replaced = await fixture();
    const initialized = await initializeCampaign({
      optimizerRoot: replaced.optimizerRoot,
      recipePath: replaced.recipePath,
      baseCommit: commit,
    });
    const replacement = join(replaced.root, "replacement-attempts");
    await mkdir(replacement);
    await rm(initialized.paths.attempts, { recursive: true });
    await symlink(replacement, initialized.paths.attempts, "dir");
    await assert.rejects(
      loadCampaign(replaced.optimizerRoot, "fixture-campaign"),
      /not a real directory/u,
    );
  });

  it("binds the requested campaign directory to the manifest campaign id", async () => {
    const f = await fixture();
    const initialized = await initializeCampaign({
      optimizerRoot: f.optimizerRoot,
      recipePath: f.recipePath,
      baseCommit: commit,
    });
    const spec = JSON.parse(await readFile(initialized.paths.resolvedCampaign, "utf8")) as Record<string, unknown>;
    const state = JSON.parse(await readFile(initialized.paths.state, "utf8")) as Record<string, unknown>;
    spec.id = "other-campaign";
    state.campaignId = "other-campaign";
    const serializedSpec = JSON.stringify(spec);
    state.campaignSpecSha256 = createHash("sha256").update(serializedSpec).digest("hex");
    await writeFile(initialized.paths.resolvedCampaign, serializedSpec);
    await writeFile(initialized.paths.state, JSON.stringify(state));

    await assert.rejects(
      loadCampaign(f.optimizerRoot, "fixture-campaign"),
      /state provenance does not match/u,
    );
  });

  it("rechecks every owned directory before state, attempt, and candidate persistence", async () => {
    const cases = ["state", "attempt", "candidate"] as const;
    for (const kind of cases) {
      const f = await fixture();
      const initialized = await initializeCampaign({
        optimizerRoot: f.optimizerRoot,
        recipePath: f.recipePath,
        baseCommit: commit,
      });
      const swappedPath = kind === "state"
        ? initialized.paths.packets
        : kind === "attempt"
          ? initialized.paths.attempts
          : initialized.paths.candidates;
      const redirect = join(f.root, `redirected-${kind}`);
      await mkdir(redirect);
      await rm(swappedPath, { recursive: true });
      await symlink(redirect, swappedPath, "dir");

      const operation = kind === "state"
        ? saveCampaignState(initialized.paths, initialized.state)
        : kind === "attempt"
          ? saveAttempt(initialized.paths, {
              version: 1,
              campaignId: initialized.spec.id,
              candidateId: "candidate-1",
              cohort: "targeted",
              slotId: "slot-targeted-0001-deadbeef",
              slotIndex: 0,
              taskId: "task-a",
              repetition: 1,
              order: ["base", "candidate"],
              results: [],
              complete: false,
            })
          : saveCandidateResponse(initialized.paths, {
              version: 1,
              campaignId: initialized.spec.id,
              requestId: "request-0001",
              candidateId: "candidate-1",
              baseCommit: initialized.spec.baseCommit,
              worktreePath: join(f.root, "candidate-worktree"),
              candidateCommit: "c".repeat(40),
              hypothesis: "Keep the candidate bounded.",
              recommendedHome: "core",
              changedFiles: ["src/example.ts"],
              testsRun: [],
            });
      await assert.rejects(operation, /not a real directory/u, kind);
      assert.deepEqual(await readdir(redirect), [], kind);
    }
  });

  it("rechecks campaign integrity before attempt reads", async () => {
    const f = await fixture();
    const initialized = await initializeCampaign({
      optimizerRoot: f.optimizerRoot,
      recipePath: f.recipePath,
      baseCommit: commit,
    });
    const redirect = join(f.root, "redirected-attempt-reads");
    await mkdir(redirect);
    await rm(initialized.paths.attempts, { recursive: true });
    await symlink(redirect, initialized.paths.attempts, "dir");

    await assert.rejects(listAttempts(initialized.paths), /not a real directory/u);
    assert.deepEqual(await readdir(redirect), []);
  });
});

describe("snapshot hashing", () => {
  it("hashes files as ordinary SHA-256", async () => {
    const f = await fixture();
    const expected = createHash("sha256").update(await readFile(f.suitePath)).digest("hex");
    assert.equal(await sha256Path(f.suitePath), expected);
  });

  it("hashes directory names and contents deterministically", async () => {
    const f = await fixture();
    const first = await sha256Path(f.skillsPath);
    await mkdir(join(f.skillsPath, "nested"));
    await writeFile(join(f.skillsPath, "nested", "other.md"), "content\n");
    assert.notEqual(await sha256Path(f.skillsPath), first);
  });

  it("rejects symbolic links in a snapshot", async () => {
    const f = await fixture();
    await symlink(join(f.skillsPath, "site.md"), join(f.skillsPath, "link.md"));
    await assert.rejects(sha256Path(f.skillsPath), /symbolic links/u);
  });

  it("constructs paths inside only the selected campaign", async () => {
    const f = await fixture();
    const paths = campaignPaths(f.optimizerRoot, "fixture-campaign");
    assert.equal(paths.root, join(f.optimizerRoot, "fixture-campaign"));
    assert.equal(paths.attempts, join(paths.root, "attempts"));
  });
});
