// ABOUTME: Copy-to-clipboard button with a transient "Copied" confirmation.

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { cn } from "@/lib/utils";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard can fail in non-secure contexts; nothing actionable here.
    }
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      title="Copy run as text"
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-md border border-border bg-background px-2.5 text-xs",
        "text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground",
      )}
    >
      {copied ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
      {copied ? "Copied" : label}
    </button>
  );
}
