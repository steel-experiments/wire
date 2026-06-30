// ABOUTME: Status dot + label and classification chip for run summaries.

import type { RunStatus } from "@/lib/protocol";
import { cn } from "@/lib/utils";

const DOT: Record<RunStatus, string> = {
  starting: "bg-warning animate-pulse",
  running: "bg-warning animate-pulse",
  "awaiting-approval": "bg-warning ring-2 ring-warning/40",
  finished: "bg-success",
  error: "bg-destructive",
};

export function StatusDot({ status, className }: { status: RunStatus; className?: string }) {
  return <span className={cn("h-2 w-2 shrink-0 rounded-full", DOT[status], className)} />;
}

const CHIP: Record<string, string> = {
  "task-complete": "bg-success/15 text-success",
  "partial-success": "bg-warning/15 text-warning",
  "blocked-auth": "bg-warning/15 text-warning",
  "agent-error": "bg-destructive/15 text-destructive",
  "site-error": "bg-destructive/15 text-destructive",
  "infra-error": "bg-destructive/15 text-destructive",
  ambiguous: "bg-muted text-muted-foreground",
};

export function ClassificationChip({ kind }: { kind: string }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        CHIP[kind] ?? "bg-muted text-muted-foreground",
      )}
    >
      {kind}
    </span>
  );
}
