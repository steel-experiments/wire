import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createId, nowIsoUtc } from "../shared/ids.js";
import type { ApprovalRequest, RunCheckpoint, SessionId } from "../shared/types.js";
import { saveApprovalRequest } from "../storage/approvals.js";
import { saveRunCheckpoint, loadRunCheckpoint } from "../storage/checkpoints.js";
import type { BrowserProvider } from "../browser/bridge.js";

import { createExperimentBundleFromRuns, reapExpiredApprovals, resolveCriticalPointReview, resolveProviderSelection, resolveSkillDir } from "./runner.js";

test("resolveCriticalPointReview defaults on in every mode", () => {
  assert.equal(resolveCriticalPointReview("task", undefined), true);
  assert.equal(resolveCriticalPointReview("investigate", undefined), true);
  assert.equal(resolveCriticalPointReview("experiment", undefined), true);
  assert.equal(resolveCriticalPointReview(undefined, undefined), true);
});

test("resolveCriticalPointReview honors an explicit choice over the default", () => {
  assert.equal(resolveCriticalPointReview("task", false), false);
  assert.equal(resolveCriticalPointReview("experiment", true), true);
});

test("resolveProviderSelection uses explicit provider", () => {
  assert.equal(resolveProviderSelection("anthropic", "claude-sonnet-4-6"), "anthropic");
});

test("resolveProviderSelection infers openai from model", () => {
  assert.equal(resolveProviderSelection(undefined, "gpt-5.4-mini"), "openai");
});

test("resolveProviderSelection infers anthropic from model", () => {
  assert.equal(resolveProviderSelection(undefined, "claude-sonnet-4-6"), "anthropic");
});

test("resolveProviderSelection rejects mismatched provider and model", () => {
  assert.throws(
    () => resolveProviderSelection("anthropic", "gpt-5.4-mini"),
    /does not match provider/u,
  );
});

test("resolveProviderSelection defaults to openai when both keys exist", () => {
  const originalOpenAi = process.env.OPENAI_API_KEY;
  const originalAnthropic = process.env.ANTHROPIC_API_KEY;
  process.env.OPENAI_API_KEY = "openai-test-key";
  process.env.ANTHROPIC_API_KEY = "anthropic-test-key";

  try {
    // No explicit provider or model: prefer openai, then anthropic.
    assert.equal(resolveProviderSelection(undefined, undefined), "openai");

    // openai key removed -> fall back to anthropic.
    delete process.env.OPENAI_API_KEY;
    assert.equal(resolveProviderSelection(undefined, undefined), "anthropic");
  } finally {
    if (originalOpenAi === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAi;
    }
    if (originalAnthropic === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropic;
    }
  }
});

test("resolveSkillDir prefers explicit option over env over default", () => {
  // Regression: default was hardcoded to "./skills" (cwd-relative). When a
  // supervisor spawned wire from a tmpdir, it silently created an empty
  // ./skills and zero skills loaded for the entire run group.
  assert.equal(resolveSkillDir("./my-skills", { WIRE_SKILLS: "/etc/wire/skills" }), "./my-skills");
  assert.equal(resolveSkillDir(undefined, { WIRE_SKILLS: "/etc/wire/skills" }), "/etc/wire/skills");
  assert.equal(resolveSkillDir(undefined, {}), join(homedir(), ".wire", "skills"));
});

test("reapExpiredApprovals stops sessions and marks approvals expired", async () => {
  const root = await mkdtemp(join(tmpdir(), "wire-reap-"));
  try {
    const runId = createId("run");
    const sessionId = createId("session") as unknown as SessionId;
    const expiredReq: ApprovalRequest = {
      id: createId("approval"),
      runId,
      actionId: createId("action"),
      summary: "Stale approval",
      consequences: ["Execute action"],
      expiresAt: nowIsoUtc(new Date(Date.now() - 60_000)),
      status: "pending",
    };
    const freshReq: ApprovalRequest = {
      id: createId("approval"),
      runId: createId("run"),
      actionId: createId("action"),
      summary: "Fresh approval",
      consequences: ["Execute action"],
      expiresAt: nowIsoUtc(new Date(Date.now() + 60_000)),
      status: "pending",
    };
    await saveApprovalRequest(root, expiredReq);
    await saveApprovalRequest(root, freshReq);

    const checkpoint: RunCheckpoint = {
      runId,
      task: { id: createId("task"), title: "t", mode: "task", objective: "o", constraints: [], successCriteria: ["done"], createdAt: nowIsoUtc() },
      run: { id: runId, taskId: createId("task"), status: "awaiting-approval", startedAt: nowIsoUtc() },
      sessionId,
      events: [],
      stepCount: 0,
      startedAt: nowIsoUtc(),
      pendingAction: { kind: "exec", summary: "x", payload: { code: "x" } },
      approvalRequestId: expiredReq.id,
      savedAt: nowIsoUtc(),
    };
    await saveRunCheckpoint(root, checkpoint);

    const stopped: SessionId[] = [];
    const provider = {
      async stopSession(id: SessionId) { stopped.push(id); },
    } as unknown as BrowserProvider;

    const reaped = await reapExpiredApprovals(root, provider);
    assert.equal(reaped, 1);
    assert.deepEqual(stopped, [sessionId]);

    // Checkpoint deleted, approval marked expired.
    await assert.rejects(loadRunCheckpoint(root, runId));
    const approvals = await import("../storage/approvals.js").then((m) => m.listApprovalRequests(root));
    const reapedApproval = approvals.find((a) => a.id === expiredReq.id);
    assert.equal(reapedApproval?.status, "expired");
    const freshApproval = approvals.find((a) => a.id === freshReq.id);
    assert.equal(freshApproval?.status, "pending");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("createExperimentBundleFromRuns creates comparisons and summary", () => {
  const taskId = createId("task");
  const runs = [
    {
      id: createId("run"),
      taskId,
      status: "succeeded" as const,
      startedAt: nowIsoUtc(),
      finishedAt: nowIsoUtc(),
      classification: { kind: "task-complete" as const, confidence: 0.8 },
      outcomeSummary: "Run one succeeded",
    },
    {
      id: createId("run"),
      taskId,
      branchLabel: "alternative-approach",
      status: "failed" as const,
      startedAt: nowIsoUtc(),
      finishedAt: nowIsoUtc(),
      classification: { kind: "site-error" as const, confidence: 0.7 },
      outcomeSummary: "Run two failed",
    },
  ];

  const bundle = createExperimentBundleFromRuns(taskId, runs);
  assert.equal(bundle.taskId, taskId);
  assert.equal(bundle.hypotheses.length, 1);
  assert.equal(bundle.runIds.length, 2);
  assert.equal(bundle.comparisons.length, 1);
  assert.equal(bundle.comparisons[0]!.lhsRunId, runs[0]!.id);
  assert.equal(bundle.comparisons[0]!.rhsRunId, runs[1]!.id);
  assert.ok(bundle.summary);
});
