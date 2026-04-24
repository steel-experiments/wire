import type {
  Artifact,
  ComparisonDimension,
  ComparisonSpec,
  Run,
  TraceEvent,
} from "../shared/types.js";

// ---------------------------------------------------------------------------
// Compare-view data generation
// ---------------------------------------------------------------------------

export interface RunComparison {
  spec: ComparisonSpec;
  lhs: {
    status: Run["status"];
    classification?: Run["classification"];
    stepCount: number;
    durationMs?: number;
    artifactCount: number;
  };
  rhs: {
    status: Run["status"];
    classification?: Run["classification"];
    stepCount: number;
    durationMs?: number;
    artifactCount: number;
  };
  dimensions: ComparisonDimension[];
}

export function compareRuns(
  spec: ComparisonSpec,
  lhsRun: Run,
  rhsRun: Run,
  lhsEvents: TraceEvent[],
  rhsEvents: TraceEvent[],
  lhsArtifacts: Artifact[],
  rhsArtifacts: Artifact[],
): RunComparison {
  const lhs: RunComparison["lhs"] = {
    status: lhsRun.status,
    stepCount: lhsEvents.length,
    artifactCount: lhsArtifacts.length,
  };
  if (lhsRun.classification) lhs.classification = lhsRun.classification;
  const lhsDur = computeDuration(lhsEvents);
  if (lhsDur !== undefined) lhs.durationMs = lhsDur;

  const rhs: RunComparison["rhs"] = {
    status: rhsRun.status,
    stepCount: rhsEvents.length,
    artifactCount: rhsArtifacts.length,
  };
  if (rhsRun.classification) rhs.classification = rhsRun.classification;
  const rhsDur = computeDuration(rhsEvents);
  if (rhsDur !== undefined) rhs.durationMs = rhsDur;

  return { spec, lhs, rhs, dimensions: spec.dimensions };
}

function computeDuration(events: TraceEvent[]): number | undefined {
  if (events.length < 2) return undefined;
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  const first = Date.parse(sorted[0]!.ts);
  const last = Date.parse(sorted[sorted.length - 1]!.ts);
  return last - first;
}
