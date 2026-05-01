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
import { manageSkillPromotion, promoteSkill, generateSkillProposal, writeSkillProposal, type PromotionCandidate } from "./promote.js";

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

// ---------------------------------------------------------------------------
// promote.ts — skill dedup
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<PromotionCandidate> = {}): PromotionCandidate {
  return {
    skillId: createId("skill"),
    hostname: "example.com",
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
