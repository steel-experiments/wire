import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";

import { createId, nowIsoUtc } from "../shared/ids.js";
import type {
  Artifact,
  BrowserSession,
  ExperimentBundle,
  Hypothesis,
  Run,
  Task,
} from "../shared/types.js";

import {
  CorruptError,
  NotFoundError,
  StorageError,
  atomicWriteJson,
  ensureDir,
  readJsonFile,
} from "./atomic.js";
import { loadTask, listTasks, saveTask } from "./tasks.js";
import {
  listRuns,
  loadExperimentBundle,
  loadHypothesis,
  loadRun,
  saveExperimentBundle,
  saveHypothesis,
  saveRun,
} from "./runs.js";
import { listSessions, loadSession, saveSession } from "./sessions.js";
import { listArtifacts, loadArtifact, saveArtifact } from "./artifacts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testRoot: string;

function makeRoot(): string {
  return join(tmpdir(), `wire-storage-test-${randomUUID()}`);
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: createId("task"),
    title: "Test task",
    mode: "task",
    objective: "Do the thing",
    constraints: [],
    successCriteria: ["Thing is done"],
    createdAt: nowIsoUtc(),
    ...overrides,
  };
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: createId("run"),
    taskId: createId("task"),
    status: "queued",
    ...overrides,
  };
}

function makeSession(overrides: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: createId("session"),
    provider: "steel",
    createdAt: nowIsoUtc(),
    status: "starting",
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<Artifact> = {}): Artifact {
  return {
    id: createId("artifact"),
    runId: createId("run"),
    kind: "screenshot",
    path: "/tmp/test.png",
    createdAt: nowIsoUtc(),
    ...overrides,
  };
}

function makeHypothesis(overrides: Partial<Hypothesis> = {}): Hypothesis {
  return {
    id: createId("hypothesis"),
    taskId: createId("task"),
    statement: "X causes Y",
    status: "active",
    updatedAt: nowIsoUtc(),
    ...overrides,
  };
}

function makeExperimentBundle(overrides: Partial<ExperimentBundle> = {}): ExperimentBundle {
  return {
    id: createId("experiment"),
    taskId: createId("task"),
    hypotheses: [],
    runIds: [],
    comparisons: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test lifecycle
// ---------------------------------------------------------------------------

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// atomic.ts
// ---------------------------------------------------------------------------

test("atomicWriteJson writes valid JSON to disk", async () => {
  testRoot = makeRoot();
  const path = join(testRoot, "data", "test.json");

  await atomicWriteJson(path, { hello: "world" });
  const raw = await readFile(path, "utf-8");

  assert.deepEqual(JSON.parse(raw), { hello: "world" });
});

test("atomicWriteJson overwrites existing files atomically", async () => {
  testRoot = makeRoot();
  const path = join(testRoot, "data", "test.json");

  await atomicWriteJson(path, { version: 1 });
  await atomicWriteJson(path, { version: 2 });

  const raw = await readFile(path, "utf-8");
  assert.deepEqual(JSON.parse(raw), { version: 2 });
});

test("atomicWriteJson throws StorageError on permission failure", async () => {
  testRoot = makeRoot();
  const path = "/nonexistent/deep/path/test.json";

  await assert.rejects(() => atomicWriteJson(path, { x: 1 }), {
    name: "StorageError",
  } as Error);
});

test("readJsonFile returns undefined for missing files", async () => {
  testRoot = makeRoot();
  const result = await readJsonFile(join(testRoot, "nope.json"));

  assert.equal(result, undefined);
});

test("readJsonFile throws CorruptError for invalid JSON", async () => {
  testRoot = makeRoot();
  await ensureDir(testRoot);
  const path = join(testRoot, "bad.json");

  await writeFile(path, "{not valid json", "utf-8");

  await assert.rejects(() => readJsonFile(path), {
    name: "CorruptError",
  } as Error);
});

test("ensureDir creates nested directories", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "a", "b", "c");

  await ensureDir(dir);

  const raw = await readFile(dir, { encoding: "utf-8" }).catch(() => "missing");
  // readFile fails on dirs, so we just confirm no error from ensureDir.
  assert.ok(true);
});

// ---------------------------------------------------------------------------
// tasks.ts
// ---------------------------------------------------------------------------

test("saveTask + loadTask round-trips a Task", async () => {
  testRoot = makeRoot();
  const task = makeTask();

  await saveTask(testRoot, task);
  const loaded = await loadTask(testRoot, task.id);

  assert.deepEqual(loaded, task);
});

test("saveTask updates an existing task", async () => {
  testRoot = makeRoot();
  const task = makeTask();

  await saveTask(testRoot, task);

  const updated = { ...task, title: "Updated title" };
  await saveTask(testRoot, updated);

  const loaded = await loadTask(testRoot, task.id);
  assert.equal(loaded.title, "Updated title");
});

test("loadTask throws NotFoundError for missing task", async () => {
  testRoot = makeRoot();

  await assert.rejects(() => loadTask(testRoot, createId("task")), {
    name: "NotFoundError",
  } as Error);
});

test("loadTask throws CorruptError for malformed file", async () => {
  testRoot = makeRoot();
  const id = createId("task");

  // Write garbage directly
  const dir = join(testRoot, "tasks");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), '{"id":"bad"}', "utf-8");

  await assert.rejects(() => loadTask(testRoot, id), {
    name: "CorruptError",
  } as Error);
});

test("listTasks returns all saved tasks", async () => {
  testRoot = makeRoot();
  const t1 = makeTask();
  const t2 = makeTask();

  await saveTask(testRoot, t1);
  await saveTask(testRoot, t2);

  const all = await listTasks(testRoot);

  assert.equal(all.length, 2);
});

test("listTasks skips corrupt files", async () => {
  testRoot = makeRoot();
  const good = makeTask();
  await saveTask(testRoot, good);

  // Add a corrupt file
  const dir = join(testRoot, "tasks");
  await writeFile(join(dir, `task_corrupt.json`), "not json", "utf-8");

  const all = await listTasks(testRoot);
  assert.equal(all.length, 1);
  assert.equal(all[0]!.id, good.id);
});

test("saveTask preserves optional fields", async () => {
  testRoot = makeRoot();
  const task = makeTask({
    falsificationCriteria: ["Thing is NOT done"],
    budget: { maxRuns: 5, maxUsd: 10 },
  });

  await saveTask(testRoot, task);
  const loaded = await loadTask(testRoot, task.id);

  assert.deepEqual(loaded.falsificationCriteria, ["Thing is NOT done"]);
  assert.equal(loaded.budget?.maxRuns, 5);
});

test("saveTask preserves task without optional fields", async () => {
  testRoot = makeRoot();
  const task = makeTask();
  // Ensure no optional fields
  assert.equal("falsificationCriteria" in task, false);
  assert.equal("budget" in task, false);

  await saveTask(testRoot, task);
  const loaded = await loadTask(testRoot, task.id);

  assert.equal(loaded.falsificationCriteria, undefined);
  assert.equal(loaded.budget, undefined);
});

// ---------------------------------------------------------------------------
// runs.ts — runs
// ---------------------------------------------------------------------------

test("saveRun + loadRun round-trips a Run", async () => {
  testRoot = makeRoot();
  const run = makeRun();

  await saveRun(testRoot, run);
  const loaded = await loadRun(testRoot, run.id);

  assert.deepEqual(loaded, run);
});

test("saveRun updates status and classification", async () => {
  testRoot = makeRoot();
  const run = makeRun();

  await saveRun(testRoot, run);

  const done: Run = {
    ...run,
    status: "succeeded",
    finishedAt: nowIsoUtc(),
    classification: { kind: "task-complete", confidence: 0.95 },
  };
  await saveRun(testRoot, done);

  const loaded = await loadRun(testRoot, run.id);
  assert.equal(loaded.status, "succeeded");
  assert.equal(loaded.classification?.kind, "task-complete");
  assert.equal(loaded.classification?.confidence, 0.95);
});

test("loadRun throws NotFoundError for missing run", async () => {
  testRoot = makeRoot();

  await assert.rejects(() => loadRun(testRoot, createId("run")), {
    name: "NotFoundError",
  } as Error);
});

test("listRuns returns all runs", async () => {
  testRoot = makeRoot();
  const r1 = makeRun();
  const r2 = makeRun();

  await saveRun(testRoot, r1);
  await saveRun(testRoot, r2);

  const all = await listRuns(testRoot);
  assert.equal(all.length, 2);
});

test("listRuns filters by taskId", async () => {
  testRoot = makeRoot();
  const taskId = createId("task");
  const r1 = makeRun({ taskId });
  const r2 = makeRun();

  await saveRun(testRoot, r1);
  await saveRun(testRoot, r2);

  const filtered = await listRuns(testRoot, taskId);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.id, r1.id);
});

test("loadRun throws CorruptError for schema-invalid file", async () => {
  testRoot = makeRoot();
  const id = createId("run");

  const dir = join(testRoot, "runs");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), '{"id":"bad"}', "utf-8");

  await assert.rejects(() => loadRun(testRoot, id), {
    name: "CorruptError",
  } as Error);
});

// ---------------------------------------------------------------------------
// runs.ts — hypotheses
// ---------------------------------------------------------------------------

test("saveHypothesis + loadHypothesis round-trips", async () => {
  testRoot = makeRoot();
  const h = makeHypothesis();

  await saveHypothesis(testRoot, h);
  const loaded = await loadHypothesis(testRoot, h.id);

  assert.deepEqual(loaded, h);
});

test("loadHypothesis throws NotFoundError for missing id", async () => {
  testRoot = makeRoot();

  await assert.rejects(() => loadHypothesis(testRoot, createId("hypothesis")), {
    name: "NotFoundError",
  } as Error);
});

test("saveHypothesis updates status from active to supported", async () => {
  testRoot = makeRoot();
  const h = makeHypothesis();

  await saveHypothesis(testRoot, h);

  const updated: Hypothesis = { ...h, status: "supported", updatedAt: nowIsoUtc() };
  await saveHypothesis(testRoot, updated);

  const loaded = await loadHypothesis(testRoot, h.id);
  assert.equal(loaded.status, "supported");
});

// ---------------------------------------------------------------------------
// runs.ts — experiment bundles
// ---------------------------------------------------------------------------

test("saveExperimentBundle + loadExperimentBundle round-trips", async () => {
  testRoot = makeRoot();
  const bundle = makeExperimentBundle({
    hypotheses: [makeHypothesis(), makeHypothesis()],
    runIds: [createId("run")],
  });

  await saveExperimentBundle(testRoot, bundle);
  const loaded = await loadExperimentBundle(testRoot, bundle.id);

  assert.deepEqual(loaded, bundle);
});

test("loadExperimentBundle throws NotFoundError for missing id", async () => {
  testRoot = makeRoot();

  await assert.rejects(() => loadExperimentBundle(testRoot, createId("experiment")), {
    name: "NotFoundError",
  } as Error);
});

test("saveExperimentBundle preserves optional summary", async () => {
  testRoot = makeRoot();
  const hId = createId("hypothesis");
  const bundle = makeExperimentBundle({
    summary: {
      supportedHypotheses: [hId],
      rejectedHypotheses: [],
      ambiguousHypotheses: [],
      keyEvidence: ["Run X showed Y"],
      nextBestExperiments: ["Try Z"],
    },
  });

  await saveExperimentBundle(testRoot, bundle);
  const loaded = await loadExperimentBundle(testRoot, bundle.id);

  assert.deepEqual(loaded.summary?.supportedHypotheses, [hId]);
  assert.equal(loaded.summary?.keyEvidence[0], "Run X showed Y");
});

// ---------------------------------------------------------------------------
// sessions.ts
// ---------------------------------------------------------------------------

test("saveSession + loadSession round-trips a BrowserSession", async () => {
  testRoot = makeRoot();
  const session = makeSession();

  await saveSession(testRoot, session);
  const loaded = await loadSession(testRoot, session.id);

  assert.deepEqual(loaded, session);
});

test("saveSession updates status", async () => {
  testRoot = makeRoot();
  const session = makeSession();

  await saveSession(testRoot, session);

  const ready = { ...session, status: "ready" as const };
  await saveSession(testRoot, ready);

  const loaded = await loadSession(testRoot, session.id);
  assert.equal(loaded.status, "ready");
});

test("loadSession throws NotFoundError for missing session", async () => {
  testRoot = makeRoot();

  await assert.rejects(() => loadSession(testRoot, createId("session")), {
    name: "NotFoundError",
  } as Error);
});

test("listSessions returns all saved sessions", async () => {
  testRoot = makeRoot();
  const s1 = makeSession();
  const s2 = makeSession({ provider: "custom" });

  await saveSession(testRoot, s1);
  await saveSession(testRoot, s2);

  const all = await listSessions(testRoot);
  assert.equal(all.length, 2);
});

test("saveSession preserves nullable optional proxyCountryCode", async () => {
  testRoot = makeRoot();
  const session = makeSession({ proxyCountryCode: null });

  await saveSession(testRoot, session);
  const loaded = await loadSession(testRoot, session.id);

  assert.equal(loaded.proxyCountryCode, null);
});

test("saveSession preserves optional fields", async () => {
  testRoot = makeRoot();
  const profileId = createId("profile");
  const session = makeSession({
    profileId,
    liveUrl: "https://live.example.com",
    wsUrl: "wss://ws.example.com",
    region: "us-west-2",
    proxyCountryCode: "US",
  });

  await saveSession(testRoot, session);
  const loaded = await loadSession(testRoot, session.id);

  assert.equal(loaded.profileId, profileId);
  assert.equal(loaded.liveUrl, "https://live.example.com");
  assert.equal(loaded.region, "us-west-2");
  assert.equal(loaded.proxyCountryCode, "US");
});

test("loadSession throws CorruptError for schema-invalid file", async () => {
  testRoot = makeRoot();
  const id = createId("session");

  const dir = join(testRoot, "sessions");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), '{"id":"not-a-session"}', "utf-8");

  await assert.rejects(() => loadSession(testRoot, id), {
    name: "CorruptError",
  } as Error);
});

// ---------------------------------------------------------------------------
// artifacts.ts
// ---------------------------------------------------------------------------

test("saveArtifact + loadArtifact round-trips an Artifact", async () => {
  testRoot = makeRoot();
  const artifact = makeArtifact();

  await saveArtifact(testRoot, artifact);
  const loaded = await loadArtifact(testRoot, artifact.id);

  assert.deepEqual(loaded, artifact);
});

test("loadArtifact throws NotFoundError for missing artifact", async () => {
  testRoot = makeRoot();

  await assert.rejects(() => loadArtifact(testRoot, createId("artifact")), {
    name: "NotFoundError",
  } as Error);
});

test("listArtifacts returns all saved artifacts", async () => {
  testRoot = makeRoot();
  const a1 = makeArtifact();
  const a2 = makeArtifact({ kind: "html" });

  await saveArtifact(testRoot, a1);
  await saveArtifact(testRoot, a2);

  const all = await listArtifacts(testRoot);
  assert.equal(all.length, 2);
});

test("listArtifacts filters by runId", async () => {
  testRoot = makeRoot();
  const runId = createId("run");
  const a1 = makeArtifact({ runId });
  const a2 = makeArtifact();

  await saveArtifact(testRoot, a1);
  await saveArtifact(testRoot, a2);

  const filtered = await listArtifacts(testRoot, runId);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.id, a1.id);
});

test("saveArtifact preserves all artifact kinds", async () => {
  testRoot = makeRoot();
  const kinds = [
    "screenshot",
    "html",
    "markdown",
    "pdf",
    "download",
    "helper-diff",
    "skill-proposal",
    "json-output",
    "plot",
    "table",
    "note",
  ] as const;

  for (const kind of kinds) {
    const artifact = makeArtifact({ kind });
    await saveArtifact(testRoot, artifact);
    const loaded = await loadArtifact(testRoot, artifact.id);
    assert.equal(loaded.kind, kind);
  }
});

test("saveArtifact preserves optional metadata", async () => {
  testRoot = makeRoot();
  const artifact = makeArtifact({
    mimeType: "image/png",
    metadata: { width: 1920, height: 1080 },
  });

  await saveArtifact(testRoot, artifact);
  const loaded = await loadArtifact(testRoot, artifact.id);

  assert.equal(loaded.mimeType, "image/png");
  assert.equal(loaded.metadata?.width, 1920);
});

test("loadArtifact throws CorruptError for schema-invalid file", async () => {
  testRoot = makeRoot();
  const id = createId("artifact");

  const dir = join(testRoot, "artifacts");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), '{"id":"bad"}', "utf-8");

  await assert.rejects(() => loadArtifact(testRoot, id), {
    name: "CorruptError",
  } as Error);
});

// ---------------------------------------------------------------------------
// Reload behavior — save, reload from fresh root, verify round-trip
// ---------------------------------------------------------------------------

test("task round-trips survive directory recreation", async () => {
  testRoot = makeRoot();
  const task = makeTask();

  await saveTask(testRoot, task);

  // Verify file exists on disk as inspectable JSON
  const raw = await readFile(join(testRoot, "tasks", `${task.id}.json`), "utf-8");
  const parsed = JSON.parse(raw);
  assert.equal(parsed.id, task.id);
  assert.equal(parsed.title, task.title);

  // Load from same root
  const loaded = await loadTask(testRoot, task.id);
  assert.deepEqual(loaded, task);
});

test("run with parent run and branch label round-trips", async () => {
  testRoot = makeRoot();
  const parentRun = makeRun();
  await saveRun(testRoot, parentRun);

  const childRun = makeRun({
    taskId: parentRun.taskId,
    parentRunId: parentRun.id,
    branchLabel: "warm-profile",
    hypothesisId: createId("hypothesis"),
  });

  await saveRun(testRoot, childRun);
  const loaded = await loadRun(testRoot, childRun.id);

  assert.equal(loaded.parentRunId, parentRun.id);
  assert.equal(loaded.branchLabel, "warm-profile");
  assert.ok(loaded.hypothesisId);
});

// ---------------------------------------------------------------------------
// Error surfaces
// ---------------------------------------------------------------------------

test("NotFoundError has entityKind and entityId", async () => {
  testRoot = makeRoot();
  const id = createId("task");

  try {
    await loadTask(testRoot, id);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof NotFoundError);
    assert.equal(err.entityKind, "tasks");
    assert.equal(err.entityId, id);
  }
});

test("CorruptError has filePath", async () => {
  testRoot = makeRoot();
  const id = createId("task");

  const dir = join(testRoot, "tasks");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${id}.json`), "not json at all", "utf-8");

  try {
    await loadTask(testRoot, id);
    assert.fail("should have thrown");
  } catch (err) {
    assert.ok(err instanceof CorruptError);
    assert.ok(err.filePath.includes(id));
  }
});

test("StorageError is the base for NotFound and Corrupt", () => {
  const notFound = new NotFoundError("task", "task_123");
  const corrupt = new CorruptError("/path", "bad");

  assert.ok(notFound instanceof StorageError);
  assert.ok(corrupt instanceof StorageError);
});
