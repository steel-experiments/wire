import { homedir } from "node:os";
import { join } from "node:path";

export function wireHome(): string {
  return process.env["WIRE_HOME"] ?? join(homedir(), ".wire");
}

export function defaultStorageRoot(): string {
  return process.env["WIRE_ROOT"] ?? join(wireHome(), "state");
}

export function defaultSkillDir(): string {
  return process.env["WIRE_SKILLS"] ?? join(wireHome(), "skills");
}
