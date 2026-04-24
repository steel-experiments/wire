import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { strict as assert } from "node:assert";
import { test, afterEach } from "node:test";

import { createId } from "../shared/ids.js";
import type { SkillFrontmatter, SkillMetadata } from "../shared/types.js";

import { loadSkillDocsFromDir, loadSkillsFromDir, findMatchingSkills } from "./loader.js";
import { matchSkillsByHostname, matchSkillsByTags, sortByRelevance } from "./matcher.js";
import { extractSections, parseSkillFile } from "./parser.js";
import { promoteSkill, generateSkillProposal, type PromotionCandidate } from "./promote.js";

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

test("loadSkillsFromDir skips unparseable .md files", async () => {
  testRoot = makeRoot();
  const dir = join(testRoot, "skills");
  await mkdir(dir, { recursive: true });

  await writeFile(join(dir, "good.md"), STRIPE_SKILL_MD, "utf-8");
  await writeFile(join(dir, "bad.md"), "not valid frontmatter at all", "utf-8");

  const skills = await loadSkillsFromDir(dir);
  assert.equal(skills.length, 1);
  assert.equal(skills[0]!.id, "skill_stripe-dashboard");
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
