// ABOUTME: Thin fetch client for the console API (launch + list runs).

import type { LaunchRequest, RunSummary, WireTraceEvent } from "./protocol";

export async function fetchRuns(): Promise<RunSummary[]> {
  const res = await fetch("/api/runs");
  const data = (await res.json()) as { runs?: RunSummary[] };
  return data.runs ?? [];
}

export async function fetchRunEvents(
  runId: string,
): Promise<{ events: WireTraceEvent[]; replayUrl: string | null }> {
  const res = await fetch(`/api/runs/${runId}/events`);
  const data = (await res.json()) as { events?: WireTraceEvent[]; replayUrl?: string | null };
  return { events: data.events ?? [], replayUrl: data.replayUrl ?? null };
}

export async function approveRun(launchId: string): Promise<void> {
  const res = await fetch(`/api/approvals/${launchId}`, { method: "POST" });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? "Failed to approve");
  }
}

export async function launchRun(req: LaunchRequest): Promise<RunSummary> {
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  const data = (await res.json()) as { run?: RunSummary; error?: string };
  if (!res.ok || !data.run) throw new Error(data.error ?? "Failed to launch run");
  return data.run;
}
