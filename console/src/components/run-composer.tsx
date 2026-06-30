// ABOUTME: Task composer — write an objective and launch a Wire agent.

import { useState } from "react";
import { Play, Loader2 } from "lucide-react";
import { launchRun } from "@/lib/api";
import { MODELS, DEFAULT_MODEL_LABEL, modelByLabel } from "@/lib/models";
import { cn } from "@/lib/utils";

const MODEL_STORAGE_KEY = "wire-console-model";

export function RunComposer({ onLaunched }: { onLaunched: (launchId: string) => void }) {
  const [objective, setObjective] = useState("");
  const [mode, setMode] = useState("task");
  const [modelLabel, setModelLabel] = useState(
    () => localStorage.getItem(MODEL_STORAGE_KEY) ?? DEFAULT_MODEL_LABEL,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectModel = (label: string) => {
    localStorage.setItem(MODEL_STORAGE_KEY, label);
    setModelLabel(label);
  };

  const submit = async () => {
    const trimmed = objective.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError(null);
    try {
      const choice = modelByLabel(modelLabel);
      const run = await launchRun({
        objective: trimmed,
        mode,
        ...(choice.provider ? { provider: choice.provider } : {}),
        ...(choice.model ? { model: choice.model } : {}),
      });
      setObjective("");
      onLaunched(run.launchId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to launch");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <textarea
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void submit();
        }}
        placeholder="Describe a task — e.g. “Go to news.ycombinator.com and return the top 5 story titles”"
        rows={3}
        className={cn(
          "w-full resize-none rounded-md border border-input bg-background px-3 py-2 text-sm",
          "outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring",
        )}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-sm">
          <label className="text-muted-foreground" htmlFor="mode">
            Mode
          </label>
          <select
            id="mode"
            value={mode}
            onChange={(e) => setMode(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <option value="task">task</option>
            <option value="investigate">investigate</option>
            <option value="experiment">experiment</option>
          </select>
          <label className="text-muted-foreground" htmlFor="model">
            Model
          </label>
          <select
            id="model"
            value={modelLabel}
            onChange={(e) => selectModel(e.target.value)}
            className="rounded-md border border-input bg-background px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {MODELS.map((m) => (
              <option key={m.label} value={m.label}>
                {m.label}
              </option>
            ))}
          </select>
          {error && <span className="text-destructive">{error}</span>}
        </div>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || objective.trim().length === 0}
          className={cn(
            "inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground",
            "transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Launch
          <kbd className="ml-1 hidden rounded bg-primary-foreground/20 px-1 text-[10px] sm:inline">⌘↵</kbd>
        </button>
      </div>
    </div>
  );
}
