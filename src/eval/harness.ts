import { createId } from "../shared/ids.js";
import type {
  Artifact,
  Run,
  Task,
  TaskMode,
  TraceEvent,
} from "../shared/types.js";
import { computeTaskMetrics, aggregateMetrics, formatEvaluationReport } from "./metrics.js";
import type { TaskMetrics, AggregateMetrics } from "./metrics.js";

// ---------------------------------------------------------------------------
// Benchmark task definition
// ---------------------------------------------------------------------------

export interface BenchmarkTask {
  id: string;
  title: string;
  mode: TaskMode;
  objective: string;
  constraints: string[];
  successCriteria: string[];
  expectedClassification?: string;
  maxSteps: number;
}

// ---------------------------------------------------------------------------
// Evaluation result
// ---------------------------------------------------------------------------

export interface EvaluationResult {
  id: string;
  benchmarkId: string;
  metrics: TaskMetrics;
  passed: boolean;
  notes: string[];
}

// ---------------------------------------------------------------------------
// Evaluate a single benchmark
// ---------------------------------------------------------------------------

export function evaluateRun(
  benchmark: BenchmarkTask,
  run: Run,
  events: TraceEvent[],
  artifacts: Artifact[],
): EvaluationResult {
  const metrics = computeTaskMetrics(run, events, artifacts.length);
  const notes: string[] = [];
  let passed = true;

  // Check expected classification if specified
  if (benchmark.expectedClassification) {
    if (metrics.classification !== benchmark.expectedClassification) {
      passed = false;
      notes.push(
        `Expected ${benchmark.expectedClassification}, got ${metrics.classification}`,
      );
    }
  }

  // Check step count against budget
  if (metrics.stepCount > benchmark.maxSteps) {
    passed = false;
    notes.push(`Exceeded max steps: ${metrics.stepCount} > ${benchmark.maxSteps}`);
  }

  // Check for unexpected errors
  if (metrics.errors > 5 && metrics.classification !== "infra-error") {
    notes.push(`High error count: ${metrics.errors}`);
  }

  return {
    id: createId("experiment"),
    benchmarkId: benchmark.id,
    metrics,
    passed,
    notes,
  };
}

// ---------------------------------------------------------------------------
// Evaluate multiple benchmarks
// ---------------------------------------------------------------------------

export interface BatchEvaluationResult {
  results: EvaluationResult[];
  aggregate: AggregateMetrics;
  passRate: number;
  report: string;
}

export function evaluateBatch(
  benchmarks: BenchmarkTask[],
  runs: Run[],
  getEvents: (runId: string) => TraceEvent[],
  getArtifacts: (runId: string) => Artifact[],
): BatchEvaluationResult {
  const results: EvaluationResult[] = [];

  for (let i = 0; i < benchmarks.length; i++) {
    const benchmark = benchmarks[i]!;
    const run = runs[i];
    if (!run) continue;

    const events = getEvents(run.id);
    const artifacts = getArtifacts(run.id);
    results.push(evaluateRun(benchmark, run, events, artifacts));
  }

  const metrics = results.map((r) => r.metrics);
  const aggregate = aggregateMetrics(metrics);
  const passRate = results.length > 0
    ? results.filter((r) => r.passed).length / results.length
    : 0;

  return {
    results,
    aggregate,
    passRate,
    report: formatEvaluationReport(metrics, aggregate),
  };
}

// ---------------------------------------------------------------------------
// Sample benchmark tasks
// ---------------------------------------------------------------------------

export const SAMPLE_BENCHMARKS: BenchmarkTask[] = [
  {
    id: "bench-navigation",
    title: "Navigate to a URL and verify page loads",
    mode: "task",
    objective: "Navigate to https://example.com and verify the page title contains 'Example'",
    constraints: [],
    successCriteria: ["Page title contains 'Example'", "URL is https://example.com"],
    expectedClassification: "task-complete",
    maxSteps: 10,
  },
  {
    id: "bench-form-fill",
    title: "Fill a form and submit",
    mode: "task",
    objective: "Fill a login form with username and password fields",
    constraints: ["Do not submit real credentials"],
    successCriteria: ["Form fields are filled", "Submit button is visible"],
    expectedClassification: "partial-success",
    maxSteps: 20,
  },
  {
    id: "bench-data-extract",
    title: "Extract data from a table",
    mode: "task",
    objective: "Extract all rows from a data table on the page",
    constraints: [],
    successCriteria: ["Table data is extracted as JSON", "All rows are captured"],
    maxSteps: 15,
  },
  {
    id: "bench-investigate",
    title: "Investigate a slow-loading page",
    mode: "investigate",
    objective: "Investigate why a page takes more than 5 seconds to load",
    constraints: [],
    successCriteria: ["Root cause identified", "Evidence collected"],
    maxSteps: 30,
  },
  {
    id: "bench-auth-wall",
    title: "Handle an auth wall gracefully",
    mode: "task",
    objective: "Navigate to a protected page and detect the login requirement",
    constraints: ["Do not attempt to bypass authentication"],
    successCriteria: ["Auth wall detected", "User notified"],
    expectedClassification: "blocked-auth",
    maxSteps: 5,
  },
];
