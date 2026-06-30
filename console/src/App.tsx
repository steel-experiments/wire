// ABOUTME: Top-level app shell — composer, live run list, and run detail.
// ABOUTME: Subscribes to the SSE stream and lets many agents run in parallel.

import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { ThemeToggle } from "@/components/theme-toggle";
import { RunComposer } from "@/components/run-composer";
import { RunList } from "@/components/run-list";
import { RunDetail } from "@/components/run-detail";
import { useRuns } from "@/hooks/use-runs";

export function App() {
  const { views, runs, connected } = useRuns();
  const [selected, setSelected] = useState<string | null>(null);

  // Auto-select the most recent run until the user picks one explicitly.
  useEffect(() => {
    if (selected === null && runs.length > 0) setSelected(runs[0]!.summary.launchId);
  }, [runs, selected]);

  const current = selected ? (views.get(selected) ?? null) : null;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-border bg-background/80 px-6 backdrop-blur">
        <div className="flex items-center gap-2">
          <Activity className="h-5 w-5 text-primary" />
          <span className="font-semibold tracking-tight">Wire Console</span>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
            <span className={"h-1.5 w-1.5 rounded-full " + (connected ? "bg-success" : "bg-warning")} />
            {connected ? "live" : "connecting"}
          </span>
        </div>
        <ThemeToggle />
      </header>

      <main className="mx-auto w-full max-w-7xl space-y-4 p-6">
        <RunComposer onLaunched={setSelected} />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[22rem_1fr] lg:items-start">
          {/* Pinned sidebar: scrolls its own list, stays put while the detail flows. */}
          <div className="lg:sticky lg:top-20 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto lg:pr-1">
            <RunList runs={runs} selected={selected} onSelect={setSelected} />
          </div>
          <RunDetail view={current} />
        </div>
      </main>
    </div>
  );
}
