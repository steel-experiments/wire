import type { Artifact, Run, TraceEvent } from "../shared/types.js";

export interface ReviewData {
  run: Run;
  events: TraceEvent[];
  artifacts: Artifact[];
}

export function formatReview(data: ReviewData): string {
  const { run, events, artifacts } = data;
  const lines: string[] = [];

  lines.push("=== Run Review ===");
  lines.push("");
  lines.push(`Run ID:       ${run.id}`);
  lines.push(`Task ID:      ${run.taskId}`);
  lines.push(`Status:       ${run.status}`);

  if (run.startedAt) {
    lines.push(`Started:      ${run.startedAt}`);
  }
  if (run.finishedAt) {
    lines.push(`Finished:     ${run.finishedAt}`);
  }
  if (run.parentRunId) {
    lines.push(`Parent Run:   ${run.parentRunId}`);
  }
  if (run.branchLabel) {
    lines.push(`Branch:       ${run.branchLabel}`);
  }

  lines.push("");

  if (run.classification) {
    lines.push("--- Classification ---");
    lines.push(`Kind:         ${run.classification.kind}`);
    lines.push(
      `Confidence:   ${(run.classification.confidence * 100).toFixed(0)}%`,
    );
    if (run.classification.notes && run.classification.notes.length > 0) {
      lines.push(`Notes:`);
      for (const note of run.classification.notes) {
        lines.push(`  - ${note}`);
      }
    }
    lines.push("");
  }

  if (run.outcomeSummary) {
    lines.push("--- Outcome ---");
    lines.push(run.outcomeSummary);
    lines.push("");
  }

  if (run.result) {
    lines.push("--- Result ---");
    lines.push(run.result);
    lines.push("");
  }

  if (events.length > 0) {
    lines.push(formatTimeline(events));
    lines.push("");
  }

  if (artifacts.length > 0) {
    lines.push(formatArtifacts(artifacts));
    lines.push("");
  }

  return lines.join("\n");
}

export function formatTimeline(events: TraceEvent[]): string {
  const lines: string[] = [];
  lines.push("--- Timeline ---");

  for (const event of events) {
    const ts = event.ts;
    const kind = event.kind;
    const summary = summarizeEventPayload(event);
    lines.push(`  [${ts}] ${kind}${summary !== "" ? `  ${summary}` : ""}`);
  }

  return lines.join("\n");
}

export function formatArtifacts(artifacts: Artifact[]): string {
  const lines: string[] = [];
  lines.push("--- Artifacts ---");

  for (const artifact of artifacts) {
    const mime = artifact.mimeType ? ` (${artifact.mimeType})` : "";
    lines.push(`  [${artifact.kind}] ${artifact.path}${mime}`);
    lines.push(`    ID: ${artifact.id}  Created: ${artifact.createdAt}`);
    const hash = artifact.metadata?.contentHash;
    const size = artifact.metadata?.contentSize;
    const preview = artifact.metadata?.contentPreview;
    if (typeof hash === "string") {
      lines.push(`    Content: hash=${hash}${typeof size === "number" ? ` size=${size}` : ""}`);
    }
    if (typeof preview === "string" && preview.length > 0) {
      lines.push(`    Preview: ${truncate(preview.replace(/\s+/gu, " "), 120)}`);
    }
  }

  return lines.join("\n");
}

function summarizeEventPayload(event: TraceEvent): string {
  const p = event.payload;

  switch (event.kind) {
    case "thought-summary": {
      const s = p["summary"];
      return typeof s === "string" ? truncate(s, 80) : "";
    }
    case "observation": {
      const url = p["url"];
      return typeof url === "string" ? truncate(url, 80) : "";
    }
    case "code-exec": {
      const code = p["code"];
      return typeof code === "string" ? truncate(code, 60) : "";
    }
    case "code-result": {
      const ok = p["ok"];
      return ok === true ? "ok" : ok === false ? "failed" : "";
    }
    case "artifact": {
      const path = p["path"];
      return typeof path === "string" ? truncate(path, 80) : "";
    }
    case "policy-check": {
      const action = p["actionKind"];
      const result = p["result"];
      return `${action ?? "?"} -> ${result ?? "?"}`;
    }
    case "approval-request": {
      const s = p["summary"];
      return typeof s === "string" ? truncate(s, 80) : "";
    }
    case "approval-result": {
      const d = p["decision"];
      return typeof d === "string" ? d : "";
    }
    case "skill-load": {
      const id = p["skillId"];
      return typeof id === "string" ? id : "";
    }
    case "skill-proposal": {
      const r = p["rationale"];
      return typeof r === "string" ? truncate(r, 80) : "";
    }
    case "error": {
      const m = p["message"];
      return typeof m === "string" ? truncate(m, 80) : "";
    }
    default:
      return "";
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1)}\u2026`;
}
