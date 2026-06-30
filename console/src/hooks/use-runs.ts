// ABOUTME: Subscribes to the multiplexed SSE stream and assembles run views.
// ABOUTME: Seeds from /api/runs, then applies live run + trace events.

import { useEffect, useMemo, useState } from "react";
import type { RunSummary, ServerEvent, WireTraceEvent } from "@/lib/protocol";
import { fetchRuns } from "@/lib/api";

export interface RunView {
  summary: RunSummary;
  events: WireTraceEvent[];
}

function apply(prev: Map<string, RunView>, ev: ServerEvent): Map<string, RunView> {
  const next = new Map(prev);
  if (ev.type === "trace") {
    const view = next.get(ev.launchId);
    if (view) next.set(ev.launchId, { ...view, events: [...view.events, ev.event] });
    return next;
  }
  const existing = next.get(ev.run.launchId);
  next.set(ev.run.launchId, { summary: ev.run, events: existing?.events ?? [] });
  return next;
}

export function useRuns() {
  const [views, setViews] = useState<Map<string, RunView>>(new Map());
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let closed = false;
    fetchRuns()
      .then((runs) => {
        if (closed) return;
        setViews((prev) => {
          const next = new Map(prev);
          for (const summary of runs) {
            next.set(summary.launchId, next.get(summary.launchId) ?? { summary, events: [] });
          }
          return next;
        });
      })
      .catch(() => undefined);

    const source = new EventSource("/api/events");
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    source.onmessage = (e) => {
      if (!e.data) return;
      setViews((prev) => apply(prev, JSON.parse(e.data) as ServerEvent));
    };
    return () => {
      closed = true;
      source.close();
    };
  }, []);

  const runs = useMemo(
    () => [...views.values()].sort((a, b) => b.summary.startedAt.localeCompare(a.summary.startedAt)),
    [views],
  );

  return { views, runs, connected };
}
