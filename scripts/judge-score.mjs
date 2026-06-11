// Score the run classifier against the hand-labeled ground truth in
// benchmarks/judge-labels.json. Reads run records from WIRE_ROOT (or
// ~/.wire/state) and prints an agreement report. Requires a build:
//   pnpm build && pnpm judge:score
import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const repoRoot = new URL("..", import.meta.url).pathname;
const labelsPath = join(repoRoot, "benchmarks", "judge-labels.json");
const runsDir = join(process.env.WIRE_ROOT ?? join(homedir(), ".wire", "state"), "runs");

let scorer;
try {
  scorer = await import(join(repoRoot, "dist", "eval", "judge-labels.js"));
} catch {
  console.error("dist/ not found or stale — run `pnpm build` first.");
  process.exit(1);
}

const { labels } = JSON.parse(readFileSync(labelsPath, "utf-8"));

const judgedByRunId = {};
for (const name of readdirSync(runsDir)) {
  if (!name.endsWith(".json")) continue;
  try {
    const run = JSON.parse(readFileSync(join(runsDir, name), "utf-8"));
    if (run.id && run.classification?.kind) judgedByRunId[run.id] = run.classification.kind;
  } catch {
    // Unreadable record: the scorer reports it as missing if labeled.
  }
}

const report = scorer.scoreJudgeAgreement(labels, judgedByRunId);
console.log(scorer.formatJudgeAgreementReport(report));
