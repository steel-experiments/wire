// ABOUTME: Embeds the Steel session player — live while running, recording after.

import { MonitorPlay, PlayCircle } from "lucide-react";

export function LiveView({ url, live }: { url: string; live: boolean }) {
  const Icon = live ? MonitorPlay : PlayCircle;
  return (
    <div className="shrink-0 border-b border-border p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" /> {live ? "Live browser" : "Session recording"}
      </div>
      <div className="h-64 w-full overflow-hidden rounded-md border border-border bg-black">
        <iframe
          src={url}
          title={live ? "Live browser session" : "Session recording"}
          className="h-full w-full"
          sandbox="allow-scripts allow-same-origin allow-popups"
        />
      </div>
    </div>
  );
}
