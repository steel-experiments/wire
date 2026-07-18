import * as assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";

import { withCampaignLock } from "./lock.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "wire-opt-lock-"));
  roots.push(root);
  return join(root, "optimizer");
}

function lockDirectory(optimizerRoot: string): string {
  return join(optimizerRoot, ".campaign-locks");
}

function lockPath(optimizerRoot: string, campaignId: string): string {
  return join(lockDirectory(optimizerRoot), `${campaignId}.lock`);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

describe("campaign lock", () => {
  it("publishes bounded process identity, returns the action result, and releases", async () => {
    const optimizerRoot = await fixture();
    const sentinel = "secret-value-must-not-be-recorded";
    const result = await withCampaignLock(optimizerRoot, "campaign-a", "evaluate", async () => {
      const path = lockPath(optimizerRoot, "campaign-a");
      const raw = await readFile(path, "utf8");
      const owner = JSON.parse(raw) as Record<string, unknown>;
      assert.deepEqual(Object.keys(owner).sort(), [
        "acquiredAt",
        "action",
        "ownerId",
        "pid",
        "processIdentity",
        "version",
      ]);
      assert.equal(owner.version, 1);
      assert.equal(owner.pid, process.pid);
      assert.equal(owner.action, "evaluate");
      assert.match(String(owner.ownerId), /^[a-f0-9-]{36}$/u);
      assert.match(String(owner.processIdentity), /^(?:linux:|fallback-start:)/u);
      assert.doesNotMatch(raw, new RegExp(sentinel, "u"));
      if (process.platform !== "win32") {
        assert.equal((await lstat(path)).mode & 0o777, 0o600);
      }
      return 42;
    });

    assert.equal(result, 42);
    assert.equal(await pathExists(lockPath(optimizerRoot, "campaign-a")), false);
  });

  it("rejects a live owner immediately while allowing another campaign", async () => {
    const optimizerRoot = await fixture();
    let nestedRan = false;
    await withCampaignLock(optimizerRoot, "campaign-a", "evaluate", async () => {
      const original = await readFile(lockPath(optimizerRoot, "campaign-a"), "utf8");
      await assert.rejects(
        withCampaignLock(optimizerRoot, "campaign-a", "holdout", () => {
          nestedRan = true;
        }),
        new RegExp(`locked by live PID ${String(process.pid)}`, "u"),
      );
      assert.equal(nestedRan, false);
      assert.equal(await readFile(lockPath(optimizerRoot, "campaign-a"), "utf8"), original);
      assert.equal(
        await withCampaignLock(optimizerRoot, "campaign-b", "baseline", () => "independent"),
        "independent",
      );
    });
  });

  it("releases in finally when the action rejects", async () => {
    const optimizerRoot = await fixture();
    await assert.rejects(
      withCampaignLock(optimizerRoot, "campaign-a", "evaluate", async () => {
        throw new Error("action failed");
      }),
      /action failed/u,
    );
    assert.equal(await pathExists(lockPath(optimizerRoot, "campaign-a")), false);
    assert.equal(
      await withCampaignLock(optimizerRoot, "campaign-a", "evaluate", () => "reacquired"),
      "reacquired",
    );
  });

  it("reclaims one well-formed lock whose recorded process is dead", async () => {
    const optimizerRoot = await fixture();
    const directory = lockDirectory(optimizerRoot);
    await mkdir(directory, { recursive: true });
    await writeFile(lockPath(optimizerRoot, "campaign-a"), JSON.stringify({
      version: 1,
      ownerId: randomUUID(),
      pid: 2_147_483_647,
      processIdentity: "fallback-start:0",
      action: "evaluate",
      acquiredAt: "2026-07-17T12:00:00.000Z",
    }), { mode: 0o600 });

    let replacementPid: unknown;
    await withCampaignLock(optimizerRoot, "campaign-a", "holdout", async () => {
      const replacement = JSON.parse(
        await readFile(lockPath(optimizerRoot, "campaign-a"), "utf8"),
      ) as Record<string, unknown>;
      replacementPid = replacement.pid;
      assert.equal(replacement.action, "holdout");
    });
    assert.equal(replacementPid, process.pid);
    assert.equal(await pathExists(lockPath(optimizerRoot, "campaign-a")), false);
  });

  it("uses process identity to reclaim a reused live PID", async () => {
    if (process.platform !== "linux") return;
    const optimizerRoot = await fixture();
    let liveRecord: Record<string, unknown> | undefined;
    await withCampaignLock(optimizerRoot, "campaign-a", "evaluate", async () => {
      liveRecord = JSON.parse(
        await readFile(lockPath(optimizerRoot, "campaign-a"), "utf8"),
      ) as Record<string, unknown>;
    });
    assert.ok(liveRecord);
    const identity = String(liveRecord.processIdentity);
    const parts = identity.split(":");
    parts[parts.length - 1] = String(Number(parts.at(-1)) + 1);
    await writeFile(lockPath(optimizerRoot, "campaign-a"), JSON.stringify({
      ...liveRecord,
      processIdentity: parts.join(":"),
    }), { mode: 0o600 });

    assert.equal(
      await withCampaignLock(optimizerRoot, "campaign-a", "evaluate", () => "reclaimed"),
      "reclaimed",
    );
  });

  it("refuses malformed or non-regular locks instead of reclaiming ambiguously", async () => {
    const optimizerRoot = await fixture();
    await mkdir(lockDirectory(optimizerRoot), { recursive: true });
    const path = lockPath(optimizerRoot, "campaign-a");
    await writeFile(path, "{}", { mode: 0o600 });
    await assert.rejects(
      withCampaignLock(optimizerRoot, "campaign-a", "evaluate", () => undefined),
      /invalid owner record; refusing unsafe reclaim/u,
    );
    assert.equal(await readFile(path, "utf8"), "{}");
  });

  it("rejects unsafe campaign ids, roots, and action labels before touching disk", async () => {
    const optimizerRoot = await fixture();
    for (const campaignId of ["", ".", "../escape", "UPPER", "campaign/a"]) {
      await assert.rejects(
        withCampaignLock(optimizerRoot, campaignId, "evaluate", () => undefined),
        /Unsafe campaign id/u,
      );
    }
    await assert.rejects(
      withCampaignLock(" ", "campaign-a", "evaluate", () => undefined),
      /Optimizer root must be a non-empty/u,
    );
    await assert.rejects(
      withCampaignLock(optimizerRoot, "campaign-a", "evaluate with secret", () => undefined),
      /Unsafe campaign lock action/u,
    );
    assert.equal(await pathExists(lockDirectory(optimizerRoot)), false);
  });

  it("rejects a lock root reached through a symlinked optimizer ancestor", async () => {
    const optimizerRoot = await fixture();
    const redirected = `${optimizerRoot}-redirected`;
    await mkdir(redirected);
    await symlink(redirected, optimizerRoot, "dir");

    await assert.rejects(
      withCampaignLock(optimizerRoot, "campaign-a", "evaluate", () => undefined),
      /symlinked ancestor/u,
    );
    assert.deepEqual(await readdir(redirected), []);
  });
});
