import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import {
  alternateRootHint,
  defaultAlternateRoots,
  findEntityInAlternateRoots,
} from "./storage-hints.js";

test("findEntityInAlternateRoots returns location when entity exists in an alternate", async () => {
  const altRoot = await mkdtemp(join(tmpdir(), "wire-alt-"));
  await mkdir(join(altRoot, "runs"), { recursive: true });
  await writeFile(join(altRoot, "runs", "run_abc.json"), "{}", "utf-8");

  const hit = await findEntityInAlternateRoots("runs", "run_abc", [altRoot]);
  assert.ok(hit, "expected a hit");
  assert.equal(hit.root, altRoot);
  assert.equal(hit.path, join(altRoot, "runs", "run_abc.json"));
});

test("findEntityInAlternateRoots returns null when entity is absent everywhere", async () => {
  const emptyRoot = await mkdtemp(join(tmpdir(), "wire-empty-"));
  const hit = await findEntityInAlternateRoots("runs", "run_missing", [emptyRoot]);
  assert.equal(hit, null);
});

test("findEntityInAlternateRoots probes alternates in order and returns the first match", async () => {
  const firstRoot = await mkdtemp(join(tmpdir(), "wire-first-"));
  const secondRoot = await mkdtemp(join(tmpdir(), "wire-second-"));
  await mkdir(join(secondRoot, "runs"), { recursive: true });
  await writeFile(join(secondRoot, "runs", "run_xyz.json"), "{}", "utf-8");

  const hit = await findEntityInAlternateRoots("runs", "run_xyz", [firstRoot, secondRoot]);
  assert.ok(hit);
  assert.equal(hit.root, secondRoot);
});

test("defaultAlternateRoots excludes the active root", () => {
  const home = join(homedir(), ".wire", "state");
  const project = resolve(".wire");

  const fromHome = defaultAlternateRoots(home);
  assert.deepEqual(fromHome, [project]);

  const fromProject = defaultAlternateRoots(project);
  assert.deepEqual(fromProject, [home]);
});

test("defaultAlternateRoots returns both candidates when active root is unrelated", () => {
  const roots = defaultAlternateRoots("/tmp/something-else");
  assert.equal(roots.length, 2);
  assert.ok(roots.includes(join(homedir(), ".wire", "state")));
  assert.ok(roots.includes(resolve(".wire")));
});

test("alternateRootHint formats path and WIRE_ROOT instruction", () => {
  const message = alternateRootHint({ root: "/Users/x/.wire", path: "/Users/x/.wire/runs/run_a.json" });
  assert.ok(message.includes("/Users/x/.wire/runs/run_a.json"));
  assert.ok(message.includes("WIRE_ROOT=/Users/x/.wire"));
});
