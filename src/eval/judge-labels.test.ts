import { strict as assert } from "node:assert";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createId } from "../shared/ids.js";
import type { RunClassificationKind } from "../shared/types.js";
import {
  formatJudgeAgreementReport,
  scoreJudgeAgreement,
  type JudgeLabel,
  type JudgeLabelsFile,
} from "./judge-labels.js";

function label(labelKind: JudgeLabel["label"], basis = "test basis"): JudgeLabel {
  return { runId: createId("run"), label: labelKind, basis };
}

test("scoreJudgeAgreement counts agreements, disagreements, and skips uncertain", () => {
  const agree = label("task-complete");
  const disagree = label("infra-error", "connection error page, not an auth wall");
  const skipped = label("uncertain");

  const report = scoreJudgeAgreement([agree, disagree, skipped], {
    [agree.runId]: "task-complete",
    [disagree.runId]: "blocked-auth",
  });

  assert.equal(report.labeled, 2);
  assert.equal(report.uncertain, 1);
  assert.equal(report.agreements, 1);
  assert.equal(report.agreementRate, 0.5);
  assert.deepEqual(report.missing, []);
  assert.equal(report.confusion["task-complete"]!["task-complete"], 1);
  assert.equal(report.confusion["infra-error"]!["blocked-auth"], 1);
  assert.equal(report.disagreements.length, 1);
  assert.equal(report.disagreements[0]!.truth, "infra-error");
  assert.equal(report.disagreements[0]!.judged, "blocked-auth");
});

test("scoreJudgeAgreement excludes missing run records from the rate", () => {
  const present = label("task-complete");
  const gone = label("agent-error");

  const report = scoreJudgeAgreement([present, gone], {
    [present.runId]: "task-complete",
  });

  assert.deepEqual(report.missing, [gone.runId]);
  assert.equal(report.agreementRate, 1, "a missing record must not count as a disagreement");
});

test("scoreJudgeAgreement with nothing scorable reports zero rate", () => {
  const report = scoreJudgeAgreement([label("uncertain")], {});
  assert.equal(report.labeled, 0);
  assert.equal(report.agreementRate, 0);
});

test("formatJudgeAgreementReport lists disagreements with their basis", () => {
  const wrong = label("infra-error", "terminal page is a connection error");
  const report = scoreJudgeAgreement([wrong], { [wrong.runId]: "blocked-auth" });

  const text = formatJudgeAgreementReport(report);
  assert.match(text, /Judge agreement: 0\/1 \(0\.0%\)/u);
  assert.match(text, /infra-error <- blocked-auth/u);
  assert.match(text, /terminal page is a connection error/u);
});

test("benchmarks/judge-labels.json parses and labels only known kinds", async () => {
  const raw = await readFile(join(import.meta.dirname, "..", "..", "benchmarks", "judge-labels.json"), "utf-8");
  const parsed = JSON.parse(raw) as JudgeLabelsFile;

  assert.equal(parsed.version, 1);
  assert.ok(parsed.labels.length >= 40, `expected a labeled set of at least 40, got ${parsed.labels.length}`);

  const knownKinds = new Set<RunClassificationKind | "uncertain">([
    "task-complete",
    "partial-success",
    "blocked-auth",
    "blocked-policy",
    "site-error",
    "agent-error",
    "infra-error",
    "counterexample",
    "ambiguous",
    "uncertain",
  ]);
  for (const entry of parsed.labels) {
    assert.ok(knownKinds.has(entry.label), `unknown label kind: ${entry.label}`);
    assert.ok(entry.runId.startsWith("run_"), `bad runId: ${entry.runId}`);
    assert.ok(entry.basis.length > 10, `label ${entry.runId} must carry an evidence basis`);
  }
});
