import type { RunClassificationKind, RunId } from "../shared/types.js";

// Judge calibration: score the classifier's stored verdicts against
// hand-labeled ground truth (benchmarks/judge-labels.json). The product's
// claim is "evidence-backed runs", which makes the judge the trust kernel —
// this is the instrument that says how often it is right.

export interface JudgeLabel {
  runId: RunId;
  /** Ground-truth outcome, or "uncertain" when the evidence didn't support a confident call. */
  label: RunClassificationKind | "uncertain";
  /** One-line evidence note for why this label was assigned. */
  basis: string;
}

export interface JudgeLabelsFile {
  version: number;
  labeledAt: string;
  labels: JudgeLabel[];
}

export interface JudgeAgreementReport {
  /** Labels considered (excludes "uncertain"). */
  labeled: number;
  /** Labels skipped as uncertain. */
  uncertain: number;
  /** Labeled runs whose record or classification was not found. */
  missing: RunId[];
  agreements: number;
  /** agreements / (labeled - missing); 0 when nothing could be scored. */
  agreementRate: number;
  /** confusion[truth][judged] = count, only for disagreements and agreements alike. */
  confusion: Partial<Record<string, Partial<Record<string, number>>>>;
  disagreements: Array<{ runId: RunId; truth: string; judged: string; basis: string }>;
}

export function scoreJudgeAgreement(
  labels: JudgeLabel[],
  judgedByRunId: Partial<Record<string, RunClassificationKind>>,
): JudgeAgreementReport {
  const missing: RunId[] = [];
  const confusion: Partial<Record<string, Partial<Record<string, number>>>> = {};
  const disagreements: JudgeAgreementReport["disagreements"] = [];
  let labeled = 0;
  let uncertain = 0;
  let agreements = 0;

  for (const entry of labels) {
    if (entry.label === "uncertain") {
      uncertain++;
      continue;
    }
    labeled++;
    const judged = judgedByRunId[entry.runId];
    if (judged === undefined) {
      missing.push(entry.runId);
      continue;
    }
    const row = (confusion[entry.label] ??= {});
    row[judged] = (row[judged] ?? 0) + 1;
    if (judged === entry.label) {
      agreements++;
    } else {
      disagreements.push({ runId: entry.runId, truth: entry.label, judged, basis: entry.basis });
    }
  }

  const scored = labeled - missing.length;
  return {
    labeled,
    uncertain,
    missing,
    agreements,
    agreementRate: scored === 0 ? 0 : agreements / scored,
    confusion,
    disagreements,
  };
}

export function formatJudgeAgreementReport(report: JudgeAgreementReport): string {
  const lines: string[] = [];
  const scored = report.labeled - report.missing.length;
  lines.push(`Judge agreement: ${report.agreements}/${scored} (${(report.agreementRate * 100).toFixed(1)}%)`);
  lines.push(`Labeled: ${report.labeled}  Uncertain (skipped): ${report.uncertain}  Missing run records: ${report.missing.length}`);
  if (report.disagreements.length > 0) {
    lines.push("");
    lines.push("Disagreements (truth <- judged):");
    for (const item of report.disagreements) {
      lines.push(`  ${item.runId}  ${item.truth} <- ${item.judged}`);
      lines.push(`    ${item.basis}`);
    }
  }
  return lines.join("\n");
}
