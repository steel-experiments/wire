// ABOUTME: Renders a run's answer (finish summary) plus collapsible raw output.
// ABOUTME: Answer first and clean; the raw JSON is collapsed so it never crowds.

import { useState } from "react";
import { ChevronDown, ChevronRight, FileJson, CheckCircle2 } from "lucide-react";
import { prettyResult } from "@/lib/format";
import { cn } from "@/lib/utils";

export function ResultView({
  answer,
  result,
  error,
}: {
  answer: string | null;
  result?: string;
  error?: string;
}) {
  const [open, setOpen] = useState(false);
  if (!answer && !result && !error) return null;

  return (
    <div className="shrink-0 border-b border-border p-4">
      {answer && (
        <div className="flex items-start gap-2">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
          <div>
            <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Answer
            </div>
            <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground">
              {answer}
            </p>
          </div>
        </div>
      )}

      {result && (
        <div className={cn("overflow-hidden rounded-md border border-border bg-muted/40", answer && "mt-3")}>
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-muted"
          >
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <FileJson className="h-3.5 w-3.5" />
            Raw output
          </button>
          {open && (
            <pre className="max-h-72 overflow-auto border-t border-border p-3 font-mono text-xs leading-relaxed text-foreground/90">
              {prettyResult(result)}
            </pre>
          )}
        </div>
      )}

      {error && (
        <pre className={cn("overflow-auto rounded-md bg-destructive/10 p-2 text-xs text-destructive", (answer || result) && "mt-3")}>
          {error}
        </pre>
      )}
    </div>
  );
}
