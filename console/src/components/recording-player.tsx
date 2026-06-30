// ABOUTME: Plays back a finished run's Steel session recording (HLS → MP4).
// ABOUTME: Server fetches the playlist (needs API key); hls.js streams CDN segments.

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { PlayCircle } from "lucide-react";

export function RecordingPlayer({ runId }: { runId: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [state, setState] = useState<"loading" | "ready" | "unavailable">("loading");
  const src = `/api/runs/${runId}/recording`;

  useEffect(() => {
    let hls: Hls | null = null;
    let cancelled = false;

    // Confirm a recording exists before spinning up the player; the live WebRTC
    // player 404s for stopped sessions, so only MP4 recordings are playable here.
    fetch(src)
      .then((res) => {
        if (cancelled) return res.ok;
        if (!res.ok) {
          setState("unavailable");
          return false;
        }
        const video = videoRef.current;
        if (!video) return true;

        // Safari plays HLS natively; Chrome/etc. need hls.js.
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = src;
          setState("ready");
        } else if (Hls.isSupported()) {
          hls = new Hls();
          hls.loadSource(src);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal && !cancelled) setState("unavailable");
          });
          setState("ready");
        } else {
          setState("unavailable");
        }
        return true;
      })
      .catch(() => !cancelled && setState("unavailable"));

    return () => {
      cancelled = true;
      hls?.destroy();
    };
  }, [runId, src]);

  return (
    <div className="shrink-0 border-b border-border p-3">
      <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
        <PlayCircle className="h-3.5 w-3.5" /> Session recording
      </div>
      <div className="h-64 w-full overflow-hidden rounded-md border border-border bg-black">
        {state === "unavailable" ? (
          <div className="flex h-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
            Recording unavailable — the Steel session may have expired or wasn’t retained.
          </div>
        ) : (
          <video
            ref={videoRef}
            controls
            className="h-full w-full"
            playsInline
          />
        )}
      </div>
    </div>
  );
}
