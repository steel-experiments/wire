import type {
  ExperimentBundle,
  ExperimentId,
  Hypothesis,
  HypothesisId,
  Run,
  RunId,
  TaskId,
} from "../shared/types.js";
import {
  experimentBundleSchema,
  hypothesisSchema,
  parseBoundary,
  runSchema,
} from "../shared/schemas.js";
import {
  atomicWriteJson,
  CorruptError,
  entityDir,
  entityPath,
  listJsonFiles,
  NotFoundError,
  readJsonFile,
} from "./atomic.js";

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

const RUNS_KIND = "runs";

function runFilePath(root: string, id: RunId): string {
  return entityPath(root, RUNS_KIND, id);
}

export async function saveRun(root: string, run: Run): Promise<void> {
  await atomicWriteJson(runFilePath(root, run.id), run);
}

export async function loadRun(root: string, runId: RunId): Promise<Run> {
  const path = runFilePath(root, runId);

  const raw = await readJsonFile(path);
  if (raw === undefined) {
    throw new NotFoundError(RUNS_KIND, runId);
  }

  try {
    return parseBoundary<Run>(runSchema, raw, "run");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}

export async function listRuns(root: string, taskId?: TaskId): Promise<Run[]> {
  const dir = entityDir(root, RUNS_KIND);
  const files = await listJsonFiles(dir);

  const runs: Run[] = [];

  for (const name of files) {
    const id = name.replace(/\.json$/u, "") as RunId;
    const path = entityPath(root, RUNS_KIND, id);

    let raw: unknown;
    try {
      raw = await readJsonFile(path);
    } catch {
      continue;
    }

    let run: Run;
    try {
      run = parseBoundary<Run>(runSchema, raw, "run");
    } catch {
      continue;
    }

    if (taskId === undefined || run.taskId === taskId) {
      runs.push(run);
    }
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Hypotheses
// ---------------------------------------------------------------------------

const HYPOTHESES_KIND = "hypotheses";

function hypothesisFilePath(root: string, id: HypothesisId): string {
  return entityPath(root, HYPOTHESES_KIND, id);
}

export async function saveHypothesis(root: string, hypothesis: Hypothesis): Promise<void> {
  await atomicWriteJson(hypothesisFilePath(root, hypothesis.id), hypothesis);
}

export async function loadHypothesis(root: string, id: HypothesisId): Promise<Hypothesis> {
  const path = hypothesisFilePath(root, id);

  const raw = await readJsonFile(path);
  if (raw === undefined) {
    throw new NotFoundError(HYPOTHESES_KIND, id);
  }

  try {
    return parseBoundary<Hypothesis>(hypothesisSchema, raw, "hypothesis");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}

// ---------------------------------------------------------------------------
// Experiment bundles
// ---------------------------------------------------------------------------

const EXPERIMENTS_KIND = "experiments";

function experimentFilePath(root: string, id: ExperimentId): string {
  return entityPath(root, EXPERIMENTS_KIND, id);
}

export async function saveExperimentBundle(
  root: string,
  bundle: ExperimentBundle,
): Promise<void> {
  await atomicWriteJson(experimentFilePath(root, bundle.id), bundle);
}

export async function loadExperimentBundle(
  root: string,
  id: ExperimentId,
): Promise<ExperimentBundle> {
  const path = experimentFilePath(root, id);

  const raw = await readJsonFile(path);
  if (raw === undefined) {
    throw new NotFoundError(EXPERIMENTS_KIND, id);
  }

  try {
    return parseBoundary<ExperimentBundle>(experimentBundleSchema, raw, "experiment-bundle");
  } catch (err) {
    throw new CorruptError(path, "schema validation failed", err);
  }
}
