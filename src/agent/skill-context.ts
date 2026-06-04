import { basename } from "node:path";
import type { LoadedSkill, Task } from "../shared/types.js";
import { createId, nowIsoUtc } from "../shared/ids.js";
import { findMatchingSkillDocMatches, loadSkillDocsFromDir } from "../skills/loader.js";
import { stripInjectionPatterns } from "./context.js";
import type { LoopState } from "./loop.js";
import { latestObservation } from "./state-helpers.js";

function hostnameFromState(state: LoopState): string | undefined {
  const observation = latestObservation(state);
  const url = typeof observation?.payload.url === "string" ? observation.payload.url : undefined;
  if (!url) {
    return undefined;
  }

  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function deriveSkillTags(task: Task): string[] {
  const words = `${task.title} ${task.objective} ${task.successCriteria.join(" ")}`.match(/[a-z0-9-]{4,}/giu) ?? [];
  const tags = new Set<string>();
  for (const word of words) {
    tags.add(word.toLowerCase());
    if (tags.size >= 12) {
      break;
    }
  }
  tags.add(task.mode);
  return [...tags];
}

const SKILL_GUIDANCE_MAX = 1800;
const SECTION_BUDGETS = [1300, 300, 150];

export function skillGuidance(skill: LoadedSkill): string {
  const preferredSections = ["Known Traps", "Traps", "Workflow", "Wait Patterns", "Facts", "Routes", "Selectors"];
  const snippets: string[] = [];
  let totalChars = 0;
  let sectionIdx = 0;

  for (const sectionName of preferredSections) {
    const raw = skill.sections[sectionName];
    if (!raw || raw.trim().length === 0) continue;

    const body = stripInjectionPatterns(raw.trim()).replace(/\s+/gu, " ");
    const entry = `${sectionName}: ${body}`;
    const budget = sectionIdx < SECTION_BUDGETS.length
      ? SECTION_BUDGETS[sectionIdx]!
      : Math.max(50, SKILL_GUIDANCE_MAX - totalChars - 50);
    const remaining = SKILL_GUIDANCE_MAX - totalChars;
    if (remaining <= 0) break;

    const snippet = entry.length > budget
      ? entry.slice(0, budget) + "..."
      : entry;
    snippets.push(snippet);
    totalChars += snippet.length + 3;
    sectionIdx++;
  }

  if (snippets.length === 0) {
    const fallback = skill.body.replace(/\s+/gu, " ").trim();
    return provisionalPrefix(skill, fallback).slice(0, SKILL_GUIDANCE_MAX);
  }

  return provisionalPrefix(skill, snippets.join(" | ")).slice(0, SKILL_GUIDANCE_MAX);
}

function provisionalPrefix(skill: LoadedSkill, guidance: string): string {
  if (skill.status !== "proposed") return guidance;
  return `PROVISIONAL learned proposal from prior run. Verify before relying on it; use durable facts, selectors, waits, and traps, not unproven end-to-end workflow. ${guidance}`;
}

export async function syncMatchedSkills(state: LoopState, skillDir?: string): Promise<void> {
  if (!skillDir) {
    state.loadedSkills = [];
    return;
  }

  const hostname = hostnameFromState(state);
  const tags = deriveSkillTags(state.task);
  const matches = await findMatchingSkillDocMatches(skillDir, hostname, tags, { includeProposals: true });
  const matched = matches.map((entry) => entry.skill);
  const previousIds = state.loadedSkills.map((skill) => skill.id).join(",");
  const nextIds = matched.map((skill) => skill.id).join(",");
  state.loadedSkills = matched;

  // One-shot empty-directory warning: if the configured skillDir loads zero
  // skill files at all, emit a single visible event so the silent-failure
  // mode (supervisor spawns wire from a cwd without ./skills, ensureDir
  // creates an empty one, no warning ever surfaces) becomes loud failure.
  const alreadyWarned = state.events.some((e) => e.kind === "skill-empty");
  if (!alreadyWarned) {
    const all = await loadSkillDocsFromDir(skillDir, { includeProposals: true });
    if (all.length === 0) {
      state.events.push({
        id: createId("event"),
        runId: state.run.id,
        ts: nowIsoUtc(),
        kind: "skill-empty",
        payload: {
          skillDir,
          message: "Skill directory has no loadable .md files. Set --skill-dir or $WIRE_SKILLS to point at your skills repo, or accept that no domain knowledge will be applied.",
        },
      });
    }
  }

  if (previousIds === nextIds) {
    return;
  }

  state.events.push({
    id: createId("event"),
    runId: state.run.id,
    ts: nowIsoUtc(),
    kind: "skill-load",
    payload: {
      skills: matched.map((skill) => skill.id),
      labels: matched.map(skillDisplayLabel),
      matches: matches.map((entry) => ({
        skillId: entry.skill.id,
        score: entry.score,
        reasons: entry.reasons,
      })),
      hostname: hostname ?? "",
      source: skillDir,
    },
  });
}

function skillDisplayLabel(skill: LoadedSkill): string {
  const file = basename(skill.path).replace(/\.md$/u, "");
  if (file.length > 0) return file;
  if (skill.hostnamePatterns && skill.hostnamePatterns.length > 0) {
    return skill.hostnamePatterns[0]!;
  }
  return skill.id;
}
