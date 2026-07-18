import type {
  Attempt,
  CandidateRecord,
  CandidateStatus,
  CampaignSpec,
  CohortName,
  ScoreSummary,
} from "./model.js";

const simplificationHypothesisPatterns = [
  /\bsimplif(?:y|ies|ied|ication)\b/i,
  /\breduc(?:e|es|ed|ing|tion)\b.{0,40}\b(?:code|complexity|duplication|surface area|lines?)\b/i,
  /\b(?:remove|delete|eliminate)(?:s|d|ing)?\b.{0,40}\b(?:dead|duplicated?|redundant|unnecessary)\s+(?:code|logic)\b/i,
  /\bconsolidat(?:e|es|ed|ing|ion)\b.{0,40}\b(?:duplicated?|redundant)\s+(?:code|logic)\b/i,
];

/** A line-count reduction is an exception only when the candidate explains why it is a simplification. */
export function isDocumentedSimplification(
  record: Pick<CandidateRecord, "productionLineDelta" | "response">,
): boolean {
  return record.productionLineDelta < 0
    && simplificationHypothesisPatterns.some((pattern) => pattern.test(record.response.hypothesis));
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function variance(values: number[]): number | null {
  const average = mean(values);
  if (average === null) return null;
  return values.reduce((sum, value) => sum + (value - average) ** 2, 0) / values.length;
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((lhs, rhs) => lhs - rhs);
  const index = Math.min(sorted.length - 1, Math.ceil(quantile * sorted.length) - 1);
  return sorted[index] ?? null;
}

function taskRateVariance(attempts: Attempt[], arm: "base" | "candidate"): number | null {
  const byTask = new Map<string, boolean[]>();
  for (const attempt of attempts) {
    const result = attempt.results.find((candidate) => candidate.arm === arm);
    if (result?.status !== "completed" || result.success === null) continue;
    const values = byTask.get(attempt.taskId) ?? [];
    values.push(result.success);
    byTask.set(attempt.taskId, values);
  }
  const perTaskVariance = [...byTask.values()].map((values) => (
    variance(values.map((value) => Number(value))) ?? 0
  ));
  return mean(perTaskVariance);
}

export function scoreAttempts(attempts: Attempt[]): ScoreSummary {
  const baseSuccess: boolean[] = [];
  const candidateSuccess: boolean[] = [];
  const baseJudge: number[] = [];
  const candidateJudge: number[] = [];
  const baseWall: number[] = [];
  const candidateWall: number[] = [];
  let baseFailures = 0;
  let candidateFailures = 0;
  let pairedSlots = 0;
  let scorable = attempts.length > 0;

  for (const attempt of attempts) {
    const baseResults = attempt.results.filter((result) => result.arm === "base");
    const candidateResults = attempt.results.filter((result) => result.arm === "candidate");
    const base = baseResults.length === 1 ? baseResults[0] : undefined;
    const candidate = candidateResults.length === 1 ? candidateResults[0] : undefined;
    if (
      !attempt.complete
      || attempt.results.length !== 2
      || base === undefined
      || candidate === undefined
    ) {
      scorable = false;
      if (base === undefined || base.status !== "completed") baseFailures += 1;
      if (candidate === undefined || candidate.status !== "completed") candidateFailures += 1;
      continue;
    }
    pairedSlots += 1;
    for (const [result, successes, judges, walls, arm] of [
      [base, baseSuccess, baseJudge, baseWall, "base"],
      [candidate, candidateSuccess, candidateJudge, candidateWall, "candidate"],
    ] as const) {
      if (result.status !== "completed" || result.success === null || result.judgeScore === null) {
        scorable = false;
        if (arm === "base") baseFailures += 1;
        else candidateFailures += 1;
        continue;
      }
      successes.push(result.success);
      judges.push(result.judgeScore);
      walls.push(result.wallMs);
      if (!result.success) {
        if (arm === "base") baseFailures += 1;
        else candidateFailures += 1;
      }
    }
  }

  const meanBaseJudge = mean(baseJudge);
  const meanCandidateJudge = mean(candidateJudge);
  return {
    pairedSlots,
    baseSuccesses: baseSuccess.filter(Boolean).length,
    candidateSuccesses: candidateSuccess.filter(Boolean).length,
    successDelta: candidateSuccess.filter(Boolean).length - baseSuccess.filter(Boolean).length,
    meanBaseJudge,
    meanCandidateJudge,
    meanJudgeDelta: meanBaseJudge === null || meanCandidateJudge === null
      ? null
      : meanCandidateJudge - meanBaseJudge,
    taskVarianceBase: taskRateVariance(attempts, "base"),
    taskVarianceCandidate: taskRateVariance(attempts, "candidate"),
    baseMedianWallMs: percentile(baseWall, 0.5),
    candidateMedianWallMs: percentile(candidateWall, 0.5),
    baseP90WallMs: percentile(baseWall, 0.9),
    candidateP90WallMs: percentile(candidateWall, 0.9),
    baseFailures,
    candidateFailures,
    scorable,
  };
}

export interface GateInput {
  cohort: CohortName;
  score: ScoreSummary;
  expectedPairedSlots: number;
  spec: CampaignSpec;
  hardValidityReasons?: string[];
  documentedSimplification?: boolean;
  priorScores?: Partial<Record<CohortName, ScoreSummary>>;
}

export interface GateDecision {
  status: CandidateStatus;
  reasons: string[];
}

function isNonNegativeInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function isBoundedMetric(value: number | null, minimum: number, maximum: number): boolean {
  return value === null || (Number.isFinite(value) && value >= minimum && value <= maximum);
}

function isNonNegativeMetric(value: number | null): boolean {
  return value === null || (Number.isFinite(value) && value >= 0);
}

function nearlyEqual(left: number, right: number): boolean {
  const scale = Math.max(1, Math.abs(left), Math.abs(right));
  return Math.abs(left - right) <= Number.EPSILON * scale * 8;
}

/** Reject summaries that could not have been produced by `scoreAttempts`. */
function scoreSummaryProblem(score: ScoreSummary): string | undefined {
  if (
    !isNonNegativeInteger(score.pairedSlots)
    || !isNonNegativeInteger(score.baseSuccesses)
    || !isNonNegativeInteger(score.candidateSuccesses)
    || !isNonNegativeInteger(score.baseFailures)
    || !isNonNegativeInteger(score.candidateFailures)
  ) {
    return "score summary contains an invalid count";
  }
  if (
    score.baseSuccesses > score.pairedSlots
    || score.candidateSuccesses > score.pairedSlots
  ) {
    return "score summary successes exceed paired evidence";
  }
  if (score.successDelta !== score.candidateSuccesses - score.baseSuccesses) {
    return "score summary success delta is inconsistent";
  }
  if (
    !isBoundedMetric(score.meanBaseJudge, 0, 1)
    || !isBoundedMetric(score.meanCandidateJudge, 0, 1)
    || !isBoundedMetric(score.meanJudgeDelta, -1, 1)
    || !isBoundedMetric(score.taskVarianceBase, 0, 0.25)
    || !isBoundedMetric(score.taskVarianceCandidate, 0, 0.25)
    || !isNonNegativeMetric(score.baseMedianWallMs)
    || !isNonNegativeMetric(score.candidateMedianWallMs)
    || !isNonNegativeMetric(score.baseP90WallMs)
    || !isNonNegativeMetric(score.candidateP90WallMs)
  ) {
    return "score summary contains an out-of-range or non-finite metric";
  }

  const judgeValues = [score.meanBaseJudge, score.meanCandidateJudge, score.meanJudgeDelta];
  if (judgeValues.some((value) => value === null) && judgeValues.some((value) => value !== null)) {
    return "score summary judge means have inconsistent availability";
  }
  if (
    score.meanBaseJudge !== null
    && score.meanCandidateJudge !== null
    && score.meanJudgeDelta !== null
    && !nearlyEqual(score.meanJudgeDelta, score.meanCandidateJudge - score.meanBaseJudge)
  ) {
    return "score summary judge delta is inconsistent";
  }

  for (const [median, p90] of [
    [score.baseMedianWallMs, score.baseP90WallMs],
    [score.candidateMedianWallMs, score.candidateP90WallMs],
  ] as const) {
    if ((median === null) !== (p90 === null)) {
      return "score summary wall metrics have inconsistent availability";
    }
    if (median !== null && p90 !== null && p90 < median) {
      return "score summary wall percentiles are inconsistent";
    }
  }

  if (score.scorable) {
    if (
      score.pairedSlots === 0
      || judgeValues.some((value) => value === null)
      || score.taskVarianceBase === null
      || score.taskVarianceCandidate === null
      || score.baseMedianWallMs === null
      || score.candidateMedianWallMs === null
      || score.baseP90WallMs === null
      || score.candidateP90WallMs === null
    ) {
      return "scorable summary is missing paired metrics";
    }
    if (
      score.baseSuccesses + score.baseFailures !== score.pairedSlots
      || score.candidateSuccesses + score.candidateFailures !== score.pairedSlots
    ) {
      return "scorable summary failure counts are inconsistent";
    }
  }
  return undefined;
}

function exactEvidenceProblem(score: ScoreSummary, expectedSlots: number): string | undefined {
  return scoreSummaryProblem(score)
    ?? (score.pairedSlots === expectedSlots ? undefined : "paired evidence count is not exact");
}

function nonRegressing(score: ScoreSummary): boolean {
  return score.successDelta >= 0
    && score.meanJudgeDelta !== null
    && score.meanJudgeDelta >= 0;
}

function smokeRegressed(score: ScoreSummary | undefined, spec: CampaignSpec): boolean {
  return score !== undefined && (
    !score.scorable
    || score.pairedSlots !== spec.cohorts.smoke.pairedSlots
    || score.successDelta < 0
    || score.meanJudgeDelta === null
    || score.meanJudgeDelta < 0
  );
}

function targetedPassed(
  score: ScoreSummary | undefined,
  spec: CampaignSpec,
  documentedSimplification: boolean,
): boolean {
  if (
    score === undefined
    || !score.scorable
    || score.pairedSlots !== spec.cohorts.targeted.pairedSlots
    || score.meanJudgeDelta === null
  ) return false;
  const win = score.successDelta >= spec.gates.minimumTargetedSuccessDelta
    && score.meanJudgeDelta >= spec.gates.minimumMeanJudgeDelta;
  const simplification = documentedSimplification
    && score.successDelta >= 0
    && score.meanJudgeDelta >= -spec.gates.maxSimplificationJudgeRegression;
  return win || simplification;
}

function broaderWinPersists(
  score: ScoreSummary,
  spec: CampaignSpec,
  documentedSimplification: boolean,
): boolean {
  if (!score.scorable || score.meanJudgeDelta === null) return false;
  if (score.pairedSlots !== spec.cohorts.broad.pairedSlots) return false;
  if (documentedSimplification) {
    return nonRegressing(score);
  }
  return score.successDelta >= spec.gates.minimumTargetedSuccessDelta
    && score.meanJudgeDelta >= spec.gates.minimumMeanJudgeDelta;
}

export function decideGate(input: GateInput): GateDecision {
  const validity = input.hardValidityReasons ?? [];
  if (validity.length > 0) return { status: "rejected", reasons: validity };
  const declaredSlots = input.cohort === "holdout"
    ? input.spec.cohorts.holdout?.slots
    : input.spec.cohorts[input.cohort].pairedSlots;
  if (declaredSlots === undefined || input.expectedPairedSlots !== declaredSlots) {
    return { status: "inconclusive", reasons: ["caller evidence count does not match the campaign manifest"] };
  }
  const currentProblem = exactEvidenceProblem(input.score, declaredSlots);
  if (currentProblem !== undefined) {
    return { status: "inconclusive", reasons: [`current cohort ${currentProblem}`] };
  }

  const consumedPriorCohorts: Array<"smoke" | "targeted" | "broad"> = [];
  if (input.priorScores?.smoke !== undefined) consumedPriorCohorts.push("smoke");
  if (input.cohort === "smoke" || input.cohort === "broad" || input.cohort === "holdout") {
    if (input.priorScores?.targeted !== undefined) consumedPriorCohorts.push("targeted");
  }
  if (input.cohort === "holdout" && input.priorScores?.broad !== undefined) {
    consumedPriorCohorts.push("broad");
  }
  for (const cohort of consumedPriorCohorts) {
    const score = input.priorScores?.[cohort];
    if (score === undefined) continue;
    const expected = input.spec.cohorts[cohort].pairedSlots;
    const problem = exactEvidenceProblem(score, expected);
    if (problem !== undefined) {
      return { status: "inconclusive", reasons: [`prior ${cohort} cohort ${problem}`] };
    }
  }

  if (!input.score.scorable) {
    return { status: "inconclusive", reasons: ["cohort contains unscorable or infrastructure results"] };
  }
  if (smokeRegressed(input.priorScores?.smoke, input.spec)) {
    return { status: "rejected", reasons: ["smoke cohort regressed"] };
  }

  const judgeDelta = input.score.meanJudgeDelta;
  if (judgeDelta === null) {
    return { status: "inconclusive", reasons: ["judge output is unavailable"] };
  }

  if (input.cohort === "targeted") {
    const win = input.score.successDelta >= input.spec.gates.minimumTargetedSuccessDelta
      && judgeDelta >= input.spec.gates.minimumMeanJudgeDelta;
    const simplification = input.documentedSimplification === true
      && input.score.successDelta >= 0
      && judgeDelta >= -input.spec.gates.maxSimplificationJudgeRegression;
    return win || simplification
      ? { status: "survives-targeted", reasons: [win ? "targeted win gate passed" : "simplification gate passed"] }
      : { status: "rejected", reasons: ["targeted minimum improvement gate did not pass"] };
  }

  if (input.cohort === "smoke") {
    if (!targetedPassed(input.priorScores?.targeted, input.spec, input.documentedSimplification === true)) {
      return { status: "inconclusive", reasons: ["smoke evaluation requires a surviving targeted result"] };
    }
    return nonRegressing(input.score)
      ? { status: "survives-targeted", reasons: ["smoke cohort did not regress"] }
      : { status: "rejected", reasons: ["smoke cohort regressed"] };
  }

  if (input.cohort === "broad") {
    if (!targetedPassed(input.priorScores?.targeted, input.spec, input.documentedSimplification === true)) {
      return { status: "inconclusive", reasons: ["broad evaluation requires a surviving targeted result"] };
    }
    if (input.priorScores?.smoke === undefined) {
      return { status: "inconclusive", reasons: ["broad evaluation requires a smoke result"] };
    }
    return nonRegressing(input.score)
      ? { status: "survives-broad", reasons: ["broad cohort did not regress"] }
      : { status: "rejected", reasons: ["broad cohort regressed"] };
  }

  const broad = input.priorScores?.broad;
  if (!targetedPassed(input.priorScores?.targeted, input.spec, input.documentedSimplification === true)) {
    return { status: "inconclusive", reasons: ["promotion requires a surviving targeted result"] };
  }
  if (input.priorScores?.smoke === undefined || smokeRegressed(input.priorScores.smoke, input.spec)) {
    return { status: "inconclusive", reasons: ["promotion requires a non-regressing smoke result"] };
  }
  if (broad === undefined || !broaderWinPersists(
    broad,
    input.spec,
    input.documentedSimplification === true,
  )) {
    return {
      status: "inconclusive",
      reasons: ["promotion requires the broader result to preserve the declared win"],
    };
  }
  return nonRegressing(input.score)
    ? { status: "recommend-promote", reasons: ["sealed holdout and broader gates passed; human review required"] }
    : { status: "rejected", reasons: ["sealed holdout regressed"] };
}

export interface RankedCandidate {
  hardValid: boolean;
  targeted: ScoreSummary;
  broad?: ScoreSummary;
  holdout?: ScoreSummary;
  productionLineDelta: number;
  changedProductionLines: number;
}

function compareNumbers(lhs: number, rhs: number): number {
  return lhs === rhs ? 0 : lhs > rhs ? 1 : -1;
}

/** Positive means lhs ranks ahead. Dimensions are compared lexicographically. */
export function compareCandidates(lhs: RankedCandidate, rhs: RankedCandidate): number {
  const validity = compareNumbers(Number(lhs.hardValid), Number(rhs.hardValid));
  if (validity !== 0) return validity;

  const lhsCompletion = lhs.broad?.candidateSuccesses ?? lhs.targeted.candidateSuccesses;
  const rhsCompletion = rhs.broad?.candidateSuccesses ?? rhs.targeted.candidateSuccesses;
  const completion = compareNumbers(lhsCompletion, rhsCompletion);
  if (completion !== 0) return completion;

  const holdout = compareNumbers(
    lhs.holdout?.candidateSuccesses ?? -1,
    rhs.holdout?.candidateSuccesses ?? -1,
  );
  if (holdout !== 0) return holdout;

  const reliability = compareNumbers(
    -(lhs.broad?.candidateFailures ?? lhs.targeted.candidateFailures),
    -(rhs.broad?.candidateFailures ?? rhs.targeted.candidateFailures),
  );
  if (reliability !== 0) return reliability;

  const varianceRank = compareNumbers(
    -(lhs.broad?.taskVarianceCandidate ?? lhs.targeted.taskVarianceCandidate ?? Number.POSITIVE_INFINITY),
    -(rhs.broad?.taskVarianceCandidate ?? rhs.targeted.taskVarianceCandidate ?? Number.POSITIVE_INFINITY),
  );
  if (varianceRank !== 0) return varianceRank;

  const efficiency = compareNumbers(
    -(lhs.broad?.candidateMedianWallMs ?? lhs.targeted.candidateMedianWallMs ?? Number.POSITIVE_INFINITY),
    -(rhs.broad?.candidateMedianWallMs ?? rhs.targeted.candidateMedianWallMs ?? Number.POSITIVE_INFINITY),
  );
  if (efficiency !== 0) return efficiency;

  const tailEfficiency = compareNumbers(
    -(lhs.broad?.candidateP90WallMs ?? lhs.targeted.candidateP90WallMs ?? Number.POSITIVE_INFINITY),
    -(rhs.broad?.candidateP90WallMs ?? rhs.targeted.candidateP90WallMs ?? Number.POSITIVE_INFINITY),
  );
  if (tailEfficiency !== 0) return tailEfficiency;

  const resultingSize = compareNumbers(-lhs.productionLineDelta, -rhs.productionLineDelta);
  if (resultingSize !== 0) return resultingSize;

  return compareNumbers(-lhs.changedProductionLines, -rhs.changedProductionLines);
}
