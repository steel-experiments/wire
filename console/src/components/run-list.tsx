// ABOUTME: Compact list of run cards; selecting one opens its detail view.

import type { RunView } from "@/hooks/use-runs";
import { ClassificationChip, StatusDot } from "./status-badge";
import { cn } from "@/lib/utils";

export function RunList({
  runs,
  selected,
  onSelect,
}: {
  runs: RunView[];
  selected: string | null;
  onSelect: (launchId: string) => void;
}) {
  if (runs.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
        No runs yet. Launch one above.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {runs.map(({ summary, events }) => {
        const steps = events.filter((e) => e.kind === "code-exec").length || summary.stepCount;
        return (
          <button
            key={summary.launchId}
            type="button"
            onClick={() => onSelect(summary.launchId)}
            className={cn(
              "rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent",
              selected === summary.launchId ? "border-primary" : "border-border",
            )}
          >
            <div className="flex items-center gap-2">
              <StatusDot status={summary.status} />
              <span className="truncate text-sm font-medium">{summary.objective}</span>
            </div>
            <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
              <span>{summary.mode}</span>
              <span>·</span>
              <span>{steps} steps</span>
              {summary.classification && (
                <>
                  <span>·</span>
                  <ClassificationChip kind={summary.classification} />
                </>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}
