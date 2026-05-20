import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";

import { createId } from "../shared/ids.js";
import type { SkillFrontmatter, SkillMetadata } from "../shared/types.js";

import { loadSkillDocsFromDir, loadSkillsFromDir, findMatchingSkills, setSkillLoadWarningSink } from "./loader.js";
import { matchSkillsByHostname, matchSkillsByTags, scoreSkills, sortByRelevance } from "./matcher.js";
import { extractSections, parseSkillFile } from "./parser.js";
import { manageSkillPromotion, promoteSkill, generateSkillProposal, writeSkillProposal, parseSkillProposalResponse, hasReusableSignal, type PromotionCandidate } from "./promote.js";
import { mergeStats, readSkillStats, writeSkillStats, updateSkillStatsFromRun, DEFAULT_STATS, type SkillStats } from "./stats.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testRoot: string;

function makeRoot(): string {
  return join(tmpdir(), `wire-skills-test-${randomUUID()}`);
}

function validFrontmatter(): string {
  const id = createId("skill");
  return [
    "---",
    `id: ${id}`,
    "scope: domain",
    "hostnamePatterns:",
    '  - "dashboard.stripe.com"',
    "tags:",
    "  - billing",
    "  - invoices",
    "updatedAt: 2026-04-24",
    "source: team",
    "---",
  ].join("\n");
}

const STRIPE_SKILL_MD = [
  "---",
  `id: skill_stripe-dashboard`,
  "scope: domain",
  "hostnamePatterns:",
  '  - "dashboard.stripe.com"',
  "tags:",
  "  - billing",
  "  - invoices",
  "updatedAt: 2026-04-24",
  "source: team",
  "---",
  "",
  "# Stripe dashboard",
  "",
  "## Durable facts",
  "- Invoices can be reached from the billing nav.",
  "- CSV export triggers a background download event.",
  "",
  "## Stable selectors",
  "- .invoice-row",
  "",
  "## Traps",
  "- The date picker uses a shadow DOM.",
].join("\n");

const GH_SKILL_MD = [
  "---",
  `id: skill_gh-prs`,
  "scope: workflow",
  "hostnamePatterns:",
  '  - "*.github.com"',
  "tags:",
  "  - pull-requests",
  "  - code-review",
  "updatedAt: 2026-04-20",
  "source: builtin",
  "---",
  "",
  "# GitHub PRs",
  "",
  "## Durable facts",
  "- PR list is at /pulls",
].join("\n");

const GENERIC_SKILL_MD = [
  "---",
  `id: skill_dialog-handler`,
  "scope: interaction",
  "tags:",
  "  - dialogs",
  "  - uploads",
  "updatedAt: 2026-04-22",
  "source: generated",
  "---",
  "",
  "# Dialog handler",
  "",
  "## Durable facts",
  "- File inputs can be triggered via click.",
].join("\n");

afterEach(async () => {
  if (testRoot) {
    await rm(testRoot, { recursive: true, force: true }).catch(() => {});
  }
});

// ---------------------------------------------------------------------------
// parser.ts — parseSkillFile
// ---------------------------------------------------------------------------

test("parseSkillFile parses valid frontmatter", () => {
  const fm = parseSkillFile(STRIPE_SKILL_MD, "stripe.md");

  assert.equal(fm.id, "skill_stripe-dashboard");
  assert.equal(fm.scope, "domain");
  assert.deepEqual(fm.hostnamePatterns, ["dashboard.stripe.com"]);
  assert.deepEqual(fm.tags, ["billing", "invoices"]);
  assert.equal(fm.updatedAt, "2026-04-24");
  assert.equal(fm.source, "team");
});

test("parseSkillFile extracts optional title is not in frontmatter schema", () => {
  const content = [
    "---",
    `id: skill_with-title`,
    "scope: domain",
    "tags:",
    "  - test",
    "updatedAt: 2026-04-24",
    "source: team",
    "title: My Skill Title",
    "---",
    "",
    "# Heading",
  ].join("\n");

  const fm = parseSkillFile(content, "titled.md");
  assert.equal(fm.title, "My Skill Title");
});

test("parseSkillFile throws on missing opening delimiter", () => {
  assert.throws(
    () => parseSkillFile("no frontmatter here", "bad.md"),
    /missing opening/u,
  );
});

test("parseSkillFile throws on missing closing delimiter", () => {
  assert.throws(
    () => parseSkillFile("---\nid: skill_abc", "bad.md"),
    /missing closing/u,
  );
});

test("parseSkillFile throws on invalid schema", () => {
  const content = [
    "---",
    "id: not-a-valid-id",
    "scope: domain",
    "tags:",
    "  - test",
    "updatedAt: 2026-04-24",
    "source: team",
    "---",
  ].join("\n");

  assert.throws(
    () => parseSkillFile(content, "bad.md"),
    /bad\.md/u,
  );
});

// ---------------------------------------------------------------------------
// parser.ts — extractSections
// ---------------------------------------------------------------------------

test("extractSections returns all ## sections", () => {
  const sections = extractSections(STRIPE_SKILL_MD);

  assert.equal(sections.size, 3);
  assert.ok(sections.has("Durable facts"));
  assert.ok(sections.has("Stable selectors"));
  assert.ok(sections.has("Traps"));
});

test("extractSections returns section body content", () => {
  const sections = extractSections(STRIPE_SKILL_MD);

  const facts = sections.get("Durable facts")!;
  assert.ok(facts.includes("Invoices can be reached"));
  assert.ok(facts.includes("CSV export triggers"));
});

test("extractSections returns empty map for body with no ## headings", () => {
  const content = [
    "---",
    `id: skill_abc`,
    "scope: domain",
    "tags:",
    "  - test",
    "updatedAt: 2026-04-24",
    "source: team",
    "---",
    "",
    "Just some text without headings.",
  ].join("\n");

  const sections = extractSections(content);
  assert.equal(sections.size, 0);
});

// ---------------------------------------------------------------------------
// matcher.ts — matchSkillsByHostname
// ---------------------------------------------------------------------------

function makeSkillMeta(overrides: Partial<SkillMetadata> = {}): SkillMetadata {
  return {
    id: createId("skill"),
    scope: "domain",
    tags: ["test"],
    updatedAt: "2026-04-24",
    source: "team",
    ...overrides,
  };
}

test("matchSkillsByHostname matches exact hostname", () => {
  const skills = [
    makeSkillMeta({
      id: "skill_stripe" as SkillMetadata["id"],
      hostnamePatterns: ["dashboard.stripe.com"],
    }),
    makeSkillMeta({
      id: "skill_other" as SkillMetadata["id"],
      hostnamePatterns: ["other.example.com"],
    }),
  ];

  const result = matchSkillsByHostname(skills, "dashboard.stripe.com");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "skill_stripe");
});

test("matchSkillsByHostname matches wildcard patterns", () => {
  const skills = [
    makeSkillMeta({
      id: "skill_gh" as SkillMetadata["id"],
      hostnamePatterns: ["*.github.com"],
    }),
  ];

  const result = matchSkillsByHostname(skills, "api.github.com");
  assert.equal(result.length, 1);
});

test("matchSkillsByHostname wildcard matches bare domain", () => {
  const skills = [
    makeSkillMeta({
      id: "skill_gh" as SkillMetadata["id"],
      hostnamePatterns: ["*.github.com"],
    }),
  ];

  // "*.github.com" also matches "github.com" itself
  const result = matchSkillsByHostname(skills, "github.com");
  assert.equal(result.length, 1);
});

test("matchSkillsByHostname returns empty for skills without hostnamePatterns", () => {
  const skills = [
    makeSkillMeta({
      id: "skill_no-host" as SkillMetadata["id"],
    }),
  ];

  const result = matchSkillsByHostname(skills, "anything.com");
  assert.equal(result.length, 0);
});

test("matchSkillsByHostname is case-insensitive", () => {
  const skills = [
    makeSkillMeta({
      id: "skill_case" as SkillMetadata["id"],
      hostnamePatterns: ["Dashboard.Stripe.COM"],
    }),
  ];

  const result = matchSkillsByHostname(skills, "dashboard.stripe.com");
  assert.equal(result.length, 1);
});

// ---------------------------------------------------------------------------
// matcher.ts — matchSkillsByTags
// ---------------------------------------------------------------------------

test("matchSkillsByTags returns skills with overlapping tags", () => {
  const skills = [
    makeSkillMeta({
      id: "skill_a" as SkillMetadata["id"],
      tags: ["billing", "invoices"],
    }),
    makeSkillMeta({
      id: "skill_b" as SkillMetadata["id"],
      tags: ["code-review"],
    }),
  ];

  const result = matchSkillsByTags(skills, ["invoices", "payments"]);
  assert.equal(result.length, 1);
  assert.equal(result[0]!.id, "skill_a");
});

test("matchSkillsByTags returns empty for empty tag list", () => {
  const skills = [
    makeSkillMeta({ tags: ["billing"] }),
  ];

  const result = matchSkillsByTags(skills, []);
  assert.equal(result.length, 0);
});

test("matchSkillsByTags returns empty when no tags overlap", () => {
  const skills = [
    makeSkillMeta({
      id: "skill_x" as SkillMetadata["id"],
      tags: ["billing"],
    }),
  ];

  const result = matchSkillsByTags(skills, ["unrelated"]);
  assert.equal(result.length, 0);
});

// ---------------------------------------------------------------------------
// matcher.ts — sortByRelevance
// ---------------------------------------------------------------------------

test("sortByRelevance sorts newest first", () => {
  const skills = [
    makeSkillMeta({ updatedAt: "2026-04-20" }),
    makeSkillMeta({ updatedAt: "2026-04-24" }),
    makeSkillMeta({ updatedAt: "2026-04-22" }),
  ];

  const sorted = sortByRelevance(skills);
  assert.equal(sorted[0]!.updatedAt, "2026-04-24");
  assert.equal(sorted[1]!.updatedAt, "2026-04-22");
  assert.equal(sorted[2]!.updatedAt, "2026-04-20");
});

test("sortByRelevance does not mutate the input array", () => {
  const skills = [
    makeSkillMeta({ updatedAt: "2026-04-20" }),
    makeSkillMeta({ updatedAt: "2026-04-24" }),
  ];

  const sorted = sortByRelevance(skills);
  assert.equal(skills[0]!.updatedAt, "2026-04-20");
  assert.equal(sorted[0]!.updatedAt, "2026-04-24");
});

test("scoreSkills prefers precise hostname skills over tag-only skills", () => {
  const precise = makeSkillMeta({
    id: "skill_precise" as SkillMetadata["id"],
    hostnamePatterns: ["example.com"],
    tags: ["billing"],
  });
  const generic = makeSkillMeta({
    id: "skill_generic" as SkillMetadata["id"],
    scope: "interaction",
    tags: ["billing"],
  });

  const scored = scoreSkills([generic, precise], {
    hostname: "example.com",
    tags: ["billing"],
  });

  assert.equal(scored[0]!.skill.id, "skill_precise");
});

// ---------------------------------------------------------------------------
// loader.ts — loadSkillsFromDir
// ---------------------------------------------------------------------------

test("loadSkillsFromDir returns parsed skills from .md files", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "stripe.md"), STRIPE_SKILL_MD, "utf-8");
  await writeFile(join(dir, "github.md"), GH_SKILL_MD, "utf-8");

  const skills = await loadSkillsFromDir(dir);

  assert.equal(skills.length, 2);
  const ids = skills.map((s) => s.id).sort();
  assert.ok(ids.includes("skill_stripe-dashboard"));
  assert.ok(ids.includes("skill_gh-prs"));
});

test("loadSkillsFromDir skips non-.md files", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "stripe.md"), STRIPE_SKILL_MD, "utf-8");
  await writeFile(join(dir, "notes.txt"), "not a skill", "utf-8");

  const skills = await loadSkillsFromDir(dir);
  assert.equal(skills.length, 1);
});

test("loadSkillsFromDir skips unparseable .md files and surfaces a warning", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "good.md"), STRIPE_SKILL_MD, "utf-8");
  await writeFile(join(dir, "bad.md"), "not valid frontmatter at all", "utf-8");

  const warnings: string[] = [];
  setSkillLoadWarningSink((line) => warnings.push(line));
  try {
    const skills = await loadSkillsFromDir(dir);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]!.id, "skill_stripe-dashboard");
  } finally {
    setSkillLoadWarningSink(undefined);
  }

  assert.equal(warnings.length, 1, "expected a single warning for the bad file");
  assert.match(warnings[0]!, /\[skill-loader\] parse failed/u);
  assert.match(warnings[0]!, /bad\.md/u);
});

test("loadSkillsFromDir warns on schema-invalid source values", async () => {
  // Repro of the elgoog_im-skill_27c5ad36 case: source: curated is not in the
  // SkillSource enum, so the file was dropped silently for weeks.
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  const invalid = STRIPE_SKILL_MD.replace("source: team", "source: curated");
  await writeFile(join(dir, "curated.md"), invalid, "utf-8");

  const warnings: string[] = [];
  setSkillLoadWarningSink((line) => warnings.push(line));
  try {
    const skills = await loadSkillsFromDir(dir);
    assert.equal(skills.length, 0);
  } finally {
    setSkillLoadWarningSink(undefined);
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /parse failed/u);
  assert.match(warnings[0]!, /builtin.+team.+generated/u);
});

test("loadSkillsFromDir returns empty for missing directory that gets created", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "no-skills-here");

  const skills = await loadSkillsFromDir(dir);
  assert.equal(skills.length, 0);
});

test("loadSkillsFromDir drops title from SkillMetadata", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  const content = [
    "---",
    `id: skill_titled`,
    "scope: domain",
    "tags:",
    "  - test",
    "updatedAt: 2026-04-24",
    "source: team",
    "title: My Title",
    "---",
    "",
    "# Heading",
  ].join("\n");

  await writeFile(join(dir, "titled.md"), content, "utf-8");

  const skills = await loadSkillsFromDir(dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.id, "skill_titled");
  // title should not appear on SkillMetadata
  assert.equal("title" in skills[0]!, false);
});

test("loadSkillDocsFromDir returns parsed body and sections", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "stripe.md"), STRIPE_SKILL_MD, "utf-8");

  const skills = await loadSkillDocsFromDir(dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.id, "skill_stripe-dashboard");
  assert.ok(skills[0]!.body.includes("## Durable facts"));
  assert.ok(typeof skills[0]!.sections["Durable facts"] === "string");
});

// ---------------------------------------------------------------------------
// loader.ts — findMatchingSkills
// ---------------------------------------------------------------------------

test("findMatchingSkills returns all skills sorted when no filters", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "stripe.md"), STRIPE_SKILL_MD, "utf-8");
  await writeFile(join(dir, "gh.md"), GH_SKILL_MD, "utf-8");
  await writeFile(join(dir, "dialog.md"), GENERIC_SKILL_MD, "utf-8");

  const matched = await findMatchingSkills(dir);
  assert.equal(matched.length, 3);
  // Sorted newest first
  assert.equal(matched[0]!.id, "skill_stripe-dashboard");
  assert.equal(matched[1]!.id, "skill_dialog-handler");
  assert.equal(matched[2]!.id, "skill_gh-prs");
});

test("findMatchingSkills filters by hostname", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "stripe.md"), STRIPE_SKILL_MD, "utf-8");
  await writeFile(join(dir, "gh.md"), GH_SKILL_MD, "utf-8");
  await writeFile(join(dir, "dialog.md"), GENERIC_SKILL_MD, "utf-8");

  const matched = await findMatchingSkills(dir, "dashboard.stripe.com");
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.id, "skill_stripe-dashboard");
});

test("findMatchingSkills filters by tags", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "stripe.md"), STRIPE_SKILL_MD, "utf-8");
  await writeFile(join(dir, "gh.md"), GH_SKILL_MD, "utf-8");
  await writeFile(join(dir, "dialog.md"), GENERIC_SKILL_MD, "utf-8");

  const matched = await findMatchingSkills(dir, undefined, ["pull-requests"]);
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.id, "skill_gh-prs");
});

test("findMatchingSkills with both hostname and tags returns union", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "stripe.md"), STRIPE_SKILL_MD, "utf-8");
  await writeFile(join(dir, "gh.md"), GH_SKILL_MD, "utf-8");
  await writeFile(join(dir, "dialog.md"), GENERIC_SKILL_MD, "utf-8");

  // hostname matches stripe, tags match gh
  const matched = await findMatchingSkills(
    dir,
    "dashboard.stripe.com",
    ["code-review"],
  );
  assert.equal(matched.length, 2);

  const ids = matched.map((s) => s.id).sort();
  assert.ok(ids.includes("skill_stripe-dashboard"));
  assert.ok(ids.includes("skill_gh-prs"));
});

test("findMatchingSkills with wildcard hostname", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "gh.md"), GH_SKILL_MD, "utf-8");

  const matched = await findMatchingSkills(dir, "api.github.com");
  assert.equal(matched.length, 1);
  assert.equal(matched[0]!.id, "skill_gh-prs");
});

test("findMatchingSkills excludes inactive skills before scoring", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "proposed.md"), STRIPE_SKILL_MD.replace("scope: domain", "scope: domain\nstatus: proposed"), "utf-8");
  await writeFile(join(dir, "rejected.md"), GH_SKILL_MD.replace("scope: workflow", "scope: workflow\nstatus: rejected"), "utf-8");
  await writeFile(join(dir, "active.md"), GENERIC_SKILL_MD, "utf-8");

  assert.equal((await findMatchingSkills(dir, "dashboard.stripe.com")).length, 0);
  assert.equal((await findMatchingSkills(dir, undefined, ["code-review"])).length, 0);
  assert.equal((await findMatchingSkills(dir)).length, 1);
});

test("findMatchingSkills excludes skills with no actual match signal when filters are provided", async () => {
  // Bug repro: a domain-scoped, generated active skill scores +3 (scope) +
  // round(0.9*4)=4 (source*confidence) = 7 points purely from bonuses, with
  // no hostname or tag overlap. At minScore=6 it would slip through. Fix:
  // require an actual match signal (hostname OR tag) when filters are given.
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  const unrelated = [
    "---",
    "id: skill_unrelated",
    "scope: domain",
    'hostnamePatterns:',
    '  - "google.com"',
    "tags:",
    "  - google.com",
    "  - auto-promoted",
    "updatedAt: 2026-04-30",
    "source: generated",
    "confidence: 0.9",
    "---",
    "# Unrelated",
  ].join("\n");
  await writeFile(join(dir, "unrelated.md"), unrelated, "utf-8");

  // Hostname doesn't match google.com; tags don't overlap either.
  const matched = await findMatchingSkills(dir, "elgoog.im", ["play", "2048", "session"]);
  assert.equal(matched.length, 0, "skill with no matching hostname or tag must not load purely on scope+source bonuses");
});

test("scoreSkills includes hostname-matched skill even with no tag overlap", () => {
  // Sanity: we didn't regress legitimate hostname-only matches.
  const skill: SkillMetadata = {
    id: "skill_test",
    scope: "domain",
    hostnamePatterns: ["elgoog.im"],
    tags: ["auto-promoted", "elgoog.im"],
    updatedAt: "2026-04-30",
    source: "generated",
    confidence: 0.9,
  };
  const matched = scoreSkills([skill], { hostname: "elgoog.im", tags: ["unrelated", "tags"], minScore: 6 });
  assert.equal(matched.length, 1, "hostname match alone should be enough");
});

test("scoreSkills includes tag-matched skill even with no hostname match", () => {
  const skill: SkillMetadata = {
    id: "skill_test",
    scope: "domain",
    hostnamePatterns: ["github.com"],
    tags: ["pull-requests", "code-review"],
    updatedAt: "2026-04-30",
    source: "generated",
    confidence: 0.9,
  };
  const matched = scoreSkills([skill], { hostname: "elgoog.im", tags: ["pull-requests"], minScore: 6 });
  assert.equal(matched.length, 1, "tag overlap alone should still pass");
});

test("scoreSkills boosts skills with successful shorter cheaper runs", () => {
  const effective: SkillMetadata = {
    id: "skill_effective",
    scope: "domain",
    hostnamePatterns: ["example.com"],
    tags: ["example"],
    updatedAt: "2026-04-20",
    source: "generated",
    confidence: 0.5,
  };
  const unproven: SkillMetadata = {
    id: "skill_unproven",
    scope: "domain",
    hostnamePatterns: ["example.com"],
    tags: ["example"],
    updatedAt: "2026-04-21",
    source: "generated",
    confidence: 0.95,
  };

  const scored = scoreSkills([unproven, effective], {
    hostname: "example.com",
    minScore: 6,
    statsBySkillId: {
      skill_effective: {
        loadedCount: 5,
        successCount: 5,
        outcomeCounts: { "task-complete": 5 },
        totalSteps: 20,
        totalTokens: 20_000,
        lastLoadedAt: "2026-05-20T10:00:00.000Z",
        recentRuns: [],
      },
    },
  });

  assert.equal(scored[0]!.skill.id, "skill_effective");
  assert.ok(scored[0]!.reasons.some((reason) => reason.startsWith("effective-success")));
  assert.ok(scored[0]!.reasons.some((reason) => reason.startsWith("short-runs")));
  assert.ok(scored[0]!.reasons.some((reason) => reason.startsWith("cheap-runs")));
});

test("scoreSkills penalizes repeatedly ineffective expensive skills", () => {
  const weak: SkillMetadata = {
    id: "skill_weak",
    scope: "domain",
    hostnamePatterns: ["example.com"],
    tags: ["example"],
    updatedAt: "2026-04-21",
    source: "generated",
    confidence: 0.95,
  };
  const steady: SkillMetadata = {
    id: "skill_steady",
    scope: "domain",
    hostnamePatterns: ["example.com"],
    tags: ["example"],
    updatedAt: "2026-04-20",
    source: "generated",
    confidence: 0.5,
  };

  const scored = scoreSkills([weak, steady], {
    hostname: "example.com",
    minScore: 6,
    statsBySkillId: {
      skill_weak: {
        loadedCount: 5,
        successCount: 1,
        outcomeCounts: { "task-complete": 1, "site-error": 4 },
        totalSteps: 120,
        totalTokens: 300_000,
        lastLoadedAt: "2026-05-20T10:00:00.000Z",
        recentRuns: [],
      },
    },
  });

  assert.equal(scored[0]!.skill.id, "skill_steady");
  assert.ok(scored.find((entry) => entry.skill.id === "skill_weak")?.reasons.some((reason) =>
    reason.startsWith("ineffective-success")
  ));
});

test("findMatchingSkills returns more than six valid matches", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  for (let i = 0; i < 7; i++) {
    await writeFile(join(dir, `skill-${i}.md`), GENERIC_SKILL_MD
      .replace("skill_dialog-handler", `skill_dialog-${i}`)
      .replace("updatedAt: 2026-04-23", `updatedAt: 2026-04-${String(10 + i).padStart(2, "0")}`), "utf-8");
  }

  const matched = await findMatchingSkills(dir, undefined, ["dialogs"]);
  assert.equal(matched.length, 7);
});

test("findMatchingSkills uses persisted effectiveness stats when ranking", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  const effective = STRIPE_SKILL_MD
    .replace("skill_stripe-dashboard", "skill_effective")
    .replace("updatedAt: 2026-04-24", "updatedAt: 2026-04-20")
    .replace("source: team", "source: generated\nconfidence: 0.5");
  const unproven = STRIPE_SKILL_MD
    .replace("skill_stripe-dashboard", "skill_unproven")
    .replace("updatedAt: 2026-04-24", "updatedAt: 2026-04-21")
    .replace("source: team", "source: generated\nconfidence: 0.95");

  await writeFile(join(dir, "effective.md"), effective, "utf-8");
  await writeFile(join(dir, "unproven.md"), unproven, "utf-8");
  await writeSkillStats(dir, "skill_effective", {
    loadedCount: 4,
    successCount: 4,
    outcomeCounts: { "task-complete": 4 },
    totalSteps: 16,
    totalTokens: 18_000,
    lastLoadedAt: "2026-05-20T10:00:00.000Z",
    recentRuns: [],
  });

  const matched = await findMatchingSkills(dir, "dashboard.stripe.com");

  assert.equal(matched[0]!.id, "skill_effective");
});

// ---------------------------------------------------------------------------
// promote.ts — skill dedup
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    skillId: createId("skill"),
    hostname: "example.com",
    workflow: [],
    facts: ["Page has a heading"],
    selectors: ["h1"],
    routes: ["/"],
    waits: [],
    traps: [],
    confidence: 0.7,
    sourceRunId: createId("run"),
    ...overrides,
  };
}

test("promoteSkill writes a new skill file", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  const candidate = makeCandidate();

  const path = await promoteSkill(candidate, dir);

  assert.ok(typeof path === "string");
  assert.ok(path.includes("example_com"));
  assert.ok(path.endsWith(".md"));
});

test("promoteSkill skips when existing skill has equal or higher confidence", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  // Write a skill with confidence 0.8
  const first = makeCandidate({ confidence: 0.8 });
  await promoteSkill(first, dir);

  // Try to write a skill with lower confidence for the same hostname
  const second = makeCandidate({ confidence: 0.6 });
  const path = await promoteSkill(second, dir);

  assert.equal(path, undefined);

  // Verify only one skill file exists
  const skills = await loadSkillsFromDir(dir);
  assert.equal(skills.length, 1);
});

test("promoteSkill replaces existing skill when new one has higher confidence", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  // Write a skill with confidence 0.5
  const first = makeCandidate({ confidence: 0.5 });
  await promoteSkill(first, dir);

  // Write a better skill with confidence 0.9
  const second = makeCandidate({ confidence: 0.9 });
  const path = await promoteSkill(second, dir);

  assert.ok(typeof path === "string");

  // Should still be exactly one skill file (old replaced)
  const skills = await loadSkillsFromDir(dir);
  assert.equal(skills.length, 1);
});

test("promoteSkill replaces stale incumbent when confidence is close", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  await promoteSkill(makeCandidate({ confidence: 0.95, facts: ["Old fact"] }), dir);
  const path = await promoteSkill(makeCandidate({ confidence: 0.92, facts: ["New useful trap"] }), dir);

  assert.ok(typeof path === "string");
  const raw = await readFile(path!, "utf-8");
  assert.match(raw, /New useful trap/u);
});

test("promoteSkill never displaces a team-authored skill with a generated proposal", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  // Hand-author a team skill on disk (simulating a curated skill).
  const teamSkillPath = join(dir, "example_com-skill_team.md");
  await writeFile(teamSkillPath, [
    "---",
    "id: skill_team-example",
    "scope: domain",
    "source: team",
    "tags:",
    "  - curated",
    "updatedAt: 2026-04-26",
    "hostnamePatterns:",
    '  - "example.com"',
    "confidence: 0.95",
    "---",
    "",
    "# Team-authored skill",
    "- Critical insight that must not be lost.",
  ].join("\n"), "utf-8");

  // A higher-confidence generated proposal would normally displace, but
  // shouldn't be allowed to overwrite human-authored knowledge.
  const result = await promoteSkill(makeCandidate({ confidence: 0.99, facts: ["Generated insight"] }), dir);
  assert.equal(result, undefined, "team skill must remain untouched");

  const surviving = await readFile(teamSkillPath, "utf-8");
  assert.match(surviving, /Critical insight that must not be lost/u);
});

test("promoteSkill writes when no existing skill for hostname", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  // Write a skill for stripe.com
  const stripe = makeCandidate({ hostname: "dashboard.stripe.com", confidence: 0.9 });
  await promoteSkill(stripe, dir);

  // Write a different skill for example.com
  const example = makeCandidate({ hostname: "example.com", confidence: 0.5 });
  const path = await promoteSkill(example, dir);

  assert.ok(typeof path === "string");
  const skills = await loadSkillsFromDir(dir);
  assert.equal(skills.length, 2);
});

test("promoteSkill rejects skill containing secrets", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  const candidate = makeCandidate({ facts: ["password=secret123"] });
  await assert.rejects(
    () => promoteSkill(candidate, dir),
    /secret patterns detected/u,
  );
});

test("manageSkillPromotion writes proposal first and only auto-promotes high confidence", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  const lowConfidence = makeCandidate({ confidence: 0.7 });
  const low = await manageSkillPromotion(lowConfidence, dir);
  assert.equal(low.promoted, false);
  assert.ok(low.proposalPath?.includes(".proposals"));

  const highConfidence = makeCandidate({ hostname: "high.example.com", confidence: 0.95 });
  const high = await manageSkillPromotion(highConfidence, dir);
  assert.equal(high.promoted, true);
  assert.ok(high.proposalPath?.includes(".proposals"));
  assert.ok(high.activePath?.endsWith(".md"));
});

test("manageSkillPromotion rejects duplicate proposals for a hostname", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  await manageSkillPromotion(makeCandidate({ confidence: 0.7, facts: ["Use the retry button after game over"] }), dir);
  const second = await manageSkillPromotion(makeCandidate({ confidence: 0.8, facts: ["Use the retry button after game over"] }), dir);

  assert.equal(second.promoted, false);
  assert.match(second.reason, /duplicate/u);
  assert.equal((await readdir(join(dir, ".proposals"))).length, 1);
});

test("manageSkillPromotion auto-promotes on rediscovered knowledge below confidence floor", async () => {
  // Repro of the grants.gov gap: a single 0.85-confidence proposal stays
  // below the 0.9 auto-promote floor forever. When the agent independently
  // files a *second* proposal (different selectors/facts) for the same
  // hostname, the rediscovery itself is evidence — promote even at 0.85.
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  const first = await manageSkillPromotion(
    makeCandidate({ hostname: "grants.gov", confidence: 0.85, facts: ["deep links resolve to home"] }),
    dir,
  );
  assert.equal(first.promoted, false, "first proposal stays in proposals");

  const second = await manageSkillPromotion(
    makeCandidate({
      hostname: "grants.gov",
      confidence: 0.85,
      facts: ["search box bounces back to homepage"],
      selectors: ["input[type='search']"],
    }),
    dir,
  );
  assert.equal(second.promoted, true, "second distinct proposal triggers cumulative promotion");
  assert.match(second.reason, /rediscovered/u);
  assert.ok(second.activePath?.endsWith(".md"));
});

test("manageSkillPromotion caps proposals per hostname", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  for (let i = 0; i < 7; i++) {
    await manageSkillPromotion(makeCandidate({ confidence: 0.7, facts: [`Unique fact ${i} selector-${i}`] }), dir);
  }

  assert.equal((await readdir(join(dir, ".proposals"))).length, 5);
});

test("writeSkillProposal validates generated frontmatter before writing", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  await assert.rejects(
    () => writeSkillProposal(makeCandidate({ skillId: "bad" as PromotionCandidate["skillId"] }), dir),
    /Expected skill_\* id/u,
  );
});

// ---------------------------------------------------------------------------
// Milestone 1: Workflow Generation
// ---------------------------------------------------------------------------

test("parseSkillProposalResponse accepts workflow array", () => {
  const runId = createId("run");
  const json = JSON.stringify({
    hostname: "example.com",
    workflow: [
      "Fetch https://api.example.com/v2/search?q={query}",
      "Parse response.data.items[] for id and title.",
      "Fall back to browser when the API returns empty.",
    ],
    facts: ["API is public, no auth needed."],
    selectors: [],
    routes: ["/api/v2/search"],
    waits: [],
    traps: [],
    confidence: 0.85,
  });

  const result = parseSkillProposalResponse(json, runId);
  assert.ok(result);
  assert.equal(result!.workflow.length, 3);
  assert.equal(result!.workflow[0], "Fetch https://api.example.com/v2/search?q={query}");
  assert.equal(result!.sourceRunId, runId);
});

test("parseSkillProposalResponse tolerates missing workflow", () => {
  const runId = createId("run");
  const json = JSON.stringify({
    hostname: "example.com",
    facts: ["Page has a heading"],
    selectors: [],
    routes: [],
    waits: [],
    traps: [],
    confidence: 0.7,
  });

  const result = parseSkillProposalResponse(json, runId);
  assert.ok(result);
  assert.deepEqual(result!.workflow, []);
});

test("parseSkillProposalResponse ignores non-array workflow", () => {
  const runId = createId("run");
  const json = JSON.stringify({
    hostname: "example.com",
    workflow: "not an array",
    facts: [],
    selectors: [],
    routes: [],
    waits: [],
    traps: [],
    confidence: 0.7,
  });

  const result = parseSkillProposalResponse(json, runId);
  assert.ok(result);
  assert.deepEqual(result!.workflow, []);
});

test("parseSkillProposalResponse filters non-string workflow entries", () => {
  const runId = createId("run");
  const json = JSON.stringify({
    hostname: "example.com",
    workflow: ["Valid step", 42, null, "Another step"],
    facts: [],
    selectors: [],
    routes: [],
    waits: [],
    traps: [],
    confidence: 0.7,
  });

  const result = parseSkillProposalResponse(json, runId);
  assert.ok(result);
  assert.deepEqual(result!.workflow, ["Valid step", "Another step"]);
});

test("generateSkillProposal emits Workflow before other sections", () => {
  const candidate = makeCandidate({
    workflow: [
      "Fetch the API at /api/search.",
      "Parse the JSON response.",
      "Fall back to browser when rate-limited.",
    ],
    facts: ["API returns JSON."],
    traps: ["Rate limit at 100 req/min."],
  });

  const md = generateSkillProposal(candidate);
  assert.match(md, /## Workflow/u);
  assert.ok(md.indexOf("## Workflow") < md.indexOf("## Facts"), "Workflow must come before Facts");
  assert.match(md, /1\. Fetch the API at \/api\/search\./u);
  assert.match(md, /3\. Fall back to browser when rate-limited\./u);
});

test("generateSkillProposal omits Workflow section when workflow is empty", () => {
  const candidate = makeCandidate({ workflow: [], facts: ["A fact."] });
  const md = generateSkillProposal(candidate);
  assert.ok(!md.includes("## Workflow"));
  assert.match(md, /## Facts/u);
});

test("hasReusableSignal returns true for workflow-only candidates", () => {
  const candidate = makeCandidate({
    workflow: ["Step one."],
    facts: [],
    selectors: [],
    routes: [],
    waits: [],
    traps: [],
  });

  assert.equal(hasReusableSignal(candidate), true);
});

test("hasReusableSignal returns false when all fields including workflow are empty", () => {
  const candidate = makeCandidate({
    workflow: [],
    facts: [],
    selectors: [],
    routes: [],
    waits: [],
    traps: [],
  });

  assert.equal(hasReusableSignal(candidate), false);
});

test("promoteSkill rejects workflow containing secrets", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  const candidate = makeCandidate({
    workflow: ["Fetch the API with api_key=sk-abc123def456ghi789jkl."],
  });
  await assert.rejects(
    () => promoteSkill(candidate, dir),
    /secret patterns detected/u,
  );
});

test("generated skill with workflow loads and surfaces workflow in sections", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  const candidate = makeCandidate({
    workflow: [
      "Navigate to /search.",
      "Fill the search input and submit.",
    ],
    facts: ["Search results are JS-rendered."],
    confidence: 0.95,
  });

  await promoteSkill(candidate, dir);

  const docs = await loadSkillDocsFromDir(dir);
  assert.equal(docs.length, 1);
  assert.ok(docs[0]!.sections["Workflow"]);
  assert.match(docs[0]!.sections["Workflow"]!, /Navigate to \/search/u);
  assert.ok(docs[0]!.sections["Facts"]);
});

test("existing skills without workflow still parse and load", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  // Write an old-style skill with no workflow section
  await writeFile(join(dir, "legacy.md"), STRIPE_SKILL_MD, "utf-8");

  const skills = await loadSkillDocsFromDir(dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.id, "skill_stripe-dashboard");
  assert.ok(!skills[0]!.sections["Workflow"]);
  assert.ok(skills[0]!.sections["Durable facts"]);
});

// ---------------------------------------------------------------------------
// Milestone 5: Skill Effectiveness Signals
// ---------------------------------------------------------------------------

test("mergeStats increments loadedCount and successCount on success", () => {
  const result = mergeStats(DEFAULT_STATS, {
    succeeded: true,
    stepCount: 5,
    totalTokens: 8000,
    loadedAt: "2026-05-06T10:00:00Z",
  });
  assert.equal(result.loadedCount, 1);
  assert.equal(result.successCount, 1);
  assert.equal(result.outcomeCounts["task-complete"], 1);
  assert.equal(result.totalSteps, 5);
  assert.equal(result.totalTokens, 8000);
});

test("mergeStats increments loadedCount but not successCount on failure", () => {
  const result = mergeStats(DEFAULT_STATS, {
    succeeded: false,
    stepCount: 10,
    totalTokens: 12000,
    loadedAt: "2026-05-06T10:00:00Z",
  });
  assert.equal(result.loadedCount, 1);
  assert.equal(result.successCount, 0);
  assert.equal(result.outcomeCounts.ambiguous, 1);
});

test("mergeStats accumulates across multiple runs", () => {
  let stats = mergeStats(DEFAULT_STATS, { succeeded: true, stepCount: 4, totalTokens: 5000, loadedAt: "2026-05-06T10:00:00Z" });
  stats = mergeStats(stats, { succeeded: true, stepCount: 6, totalTokens: 7000, loadedAt: "2026-05-06T10:01:00Z" });
  stats = mergeStats(stats, { succeeded: false, stepCount: 8, totalTokens: 9000, loadedAt: "2026-05-06T10:02:00Z" });

  assert.equal(stats.loadedCount, 3);
  assert.equal(stats.successCount, 2);
  assert.equal(stats.totalSteps, 18);
  assert.equal(stats.totalTokens, 21000);
  assert.equal(stats.lastLoadedAt, "2026-05-06T10:02:00Z");
  assert.equal(stats.outcomeCounts["task-complete"], 2);
  assert.equal(stats.outcomeCounts.ambiguous, 1);
});

test("readSkillStats returns null for missing file", async () => {
  testRoot = makeRoot();
  const result = await readSkillStats(testRoot, "skill_nonexistent");
  assert.equal(result, null);
});

test("readSkillStats normalizes older stats files", async () => {
  testRoot = makeRoot();
  await mkdir(join(testRoot, ".stats"), { recursive: true });
  await writeFile(join(testRoot, ".stats", "skill_old.json"), JSON.stringify({
    loadedCount: 2,
    successCount: 1,
    totalSteps: 10,
    totalTokens: 1000,
    lastLoadedAt: "2026-05-06T12:00:00Z",
  }), "utf-8");

  const stats = await readSkillStats(testRoot, "skill_old");

  assert.equal(stats!.loadedCount, 2);
  assert.deepEqual(stats!.outcomeCounts, {});
  assert.deepEqual(stats!.recentRuns, []);
});

test("writeSkillStats and readSkillStats round-trip", async () => {
  testRoot = makeRoot();
  const stats: SkillStats = {
    loadedCount: 5,
    successCount: 4,
    outcomeCounts: { "task-complete": 4, "site-error": 1 },
    totalSteps: 22,
    totalTokens: 32000,
    lastLoadedAt: "2026-05-06T12:00:00Z",
    recentRuns: [],
  };

  await writeSkillStats(testRoot, "skill_test", stats);
  const loaded = await readSkillStats(testRoot, "skill_test");

  assert.deepEqual(loaded, stats);
});

test("updateSkillStatsFromRun writes stats for each loaded skill", async () => {
  testRoot = makeRoot();
  const skillA = createId("skill");
  const skillB = createId("skill");
  const runId = createId("run");

  // Build a minimal LoopResult-like object
  await updateSkillStatsFromRun(testRoot, {
    run: { id: runId } as any,
    events: [
      { kind: "skill-load", runId, payload: { skills: [skillA, skillB] }, id: createId("event"), ts: "2026-05-06T10:00:00Z" } as any,
    ],
    classification: { kind: "task-complete", confidence: 0.95 },
    stepCount: 4,
    startedAt: "2026-05-06T10:00:00Z",
    usage: { promptTokens: 3000, completionTokens: 4000, totalTokens: 7000 },
  } as any);

  const statsA = await readSkillStats(testRoot, skillA);
  const statsB = await readSkillStats(testRoot, skillB);

  assert.equal(statsA!.loadedCount, 1);
  assert.equal(statsA!.successCount, 1);
  assert.equal(statsB!.loadedCount, 1);
  assert.equal(statsA!.outcomeCounts["task-complete"], 1);
  assert.deepEqual(statsA!.recentRuns[0]!.loadedWithSkillIds, [skillB]);
  assert.deepEqual(statsB!.recentRuns[0]!.loadedWithSkillIds, [skillA]);
});

test("updateSkillStatsFromRun is no-op when no skills loaded", async () => {
  testRoot = makeRoot();
  const runId = createId("run");

  await updateSkillStatsFromRun(testRoot, {
    run: { id: runId } as any,
    events: [],
    classification: { kind: "task-complete", confidence: 0.95 },
    stepCount: 4,
    startedAt: "2026-05-06T10:00:00Z",
  } as any);

  // No stats directory should exist
  const { readdir: ls } = await import("node:fs/promises");
  await assert.rejects(() => ls(join(testRoot, ".stats")), /ENOENT/u);
});

// ---------------------------------------------------------------------------
// Workflow dedup signal
// ---------------------------------------------------------------------------

test("workflow text contributes to dedup similarity between proposals", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");

  // Write a candidate with a distinctive workflow step
  const first = makeCandidate({
    facts: [],
    selectors: [],
    routes: [],
    workflow: ["Navigate to /pricing and click the enterprise-plan button"],
    confidence: 0.8,
  });
  await writeSkillProposal(first, dir);

  // A second candidate with the same workflow phrase should be deduplicated
  const second = makeCandidate({
    skillId: createId("skill"),
    facts: [],
    selectors: [],
    routes: [],
    workflow: ["Navigate to /pricing and click the enterprise-plan button"],
    confidence: 0.75,
  });
  const result = await manageSkillPromotion(second, dir);
  // Dedup: near-duplicate workflow → no new proposal written
  assert.ok(!result.promoted, "dedup should block near-duplicate workflow proposal");
});
