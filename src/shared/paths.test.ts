import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { defaultSkillDir, defaultStorageRoot, wireHome } from "./paths.js";

test("wireHome defaults to ~/.wire and respects WIRE_HOME", () => {
  const previous = process.env.WIRE_HOME;
  try {
    delete process.env.WIRE_HOME;
    assert.equal(wireHome(), join(homedir(), ".wire"));

    process.env.WIRE_HOME = "/tmp/wire-home";
    assert.equal(wireHome(), "/tmp/wire-home");
  } finally {
    if (previous === undefined) {
      delete process.env.WIRE_HOME;
    } else {
      process.env.WIRE_HOME = previous;
    }
  }
});

test("defaultStorageRoot uses WIRE_ROOT before WIRE_HOME state", () => {
  const previousHome = process.env.WIRE_HOME;
  const previousRoot = process.env.WIRE_ROOT;
  try {
    delete process.env.WIRE_ROOT;
    process.env.WIRE_HOME = "/tmp/wire-home";
    assert.equal(defaultStorageRoot(), "/tmp/wire-home/state");

    process.env.WIRE_ROOT = "/tmp/wire-root";
    assert.equal(defaultStorageRoot(), "/tmp/wire-root");
  } finally {
    if (previousHome === undefined) {
      delete process.env.WIRE_HOME;
    } else {
      process.env.WIRE_HOME = previousHome;
    }
    if (previousRoot === undefined) {
      delete process.env.WIRE_ROOT;
    } else {
      process.env.WIRE_ROOT = previousRoot;
    }
  }
});

test("defaultSkillDir uses WIRE_SKILLS before WIRE_HOME skills", () => {
  const previousHome = process.env.WIRE_HOME;
  const previousSkills = process.env.WIRE_SKILLS;
  try {
    delete process.env.WIRE_SKILLS;
    process.env.WIRE_HOME = "/tmp/wire-home";
    assert.equal(defaultSkillDir(), "/tmp/wire-home/skills");

    process.env.WIRE_SKILLS = "/tmp/wire-skills";
    assert.equal(defaultSkillDir(), "/tmp/wire-skills");
  } finally {
    if (previousHome === undefined) {
      delete process.env.WIRE_HOME;
    } else {
      process.env.WIRE_HOME = previousHome;
    }
    if (previousSkills === undefined) {
      delete process.env.WIRE_SKILLS;
    } else {
      process.env.WIRE_SKILLS = previousSkills;
    }
  }
});
