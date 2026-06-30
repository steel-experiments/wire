// ABOUTME: Pending-approval gate — shows the proposed destructive action and
// ABOUTME: lets the user approve it, resuming the run. The console's one write.

import { useState } from "react";
import { ShieldAlert, Check, Loader2 } from "lucide-react";
import type { PendingApproval } from "@/lib/protocol";
import { approveRun } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ApprovalPanel({ launchId, approval }: { launchId: string; approval: PendingApproval }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approve = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await approveRun(launchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Approve failed");
      setBusy(false);
    }
  };

  return (
    <div className="shrink-0 border-b border-warning/40 bg-warning/10 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-warning">
        <ShieldAlert className="h-4 w-4" />
        Approval required
      </div>
      <p className="mt-1 text-sm text-foreground">{approval.summary}</p>
      <div className="mt-2 flex flex-wrap gap-2 text-xs text-muted-foreground">
        {approval.actionKind && <span>action: {approval.actionKind}</span>}
        {approval.riskKind && <span>· risk: {approval.riskKind}</span>}
      </div>
      {approval.codeExcerpt && (
        <pre className="mt-2 overflow-x-auto rounded-md bg-background p-2 font-mono text-xs text-foreground/90">
          {approval.codeExcerpt}
        </pre>
      )}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          onClick={() => void approve()}
          disabled={busy}
          className={cn(
            "inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground",
            "transition-opacity hover:opacity-90 disabled:opacity-50",
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
          Approve &amp; resume
        </button>
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </div>
  );
}
