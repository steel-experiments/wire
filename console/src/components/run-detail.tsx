// ABOUTME: Detail view for one run — header, live browser link, and the timeline.

import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import type { RunView } from "@/hooks/use-runs";
import type { WireTraceEvent } from "@/lib/protocol";
import { fetchRunEvents } from "@/lib/api";
import { finishSummary } from "@/lib/format";
import { serializeRun } from "@/lib/serialize";
import { ClassificationChip, StatusDot } from "./status-badge";
import { StepTimeline } from "./step-timeline";
import { LiveView } from "./live-view";
import { RecordingPlayer } from "./recording-player";
import { ApprovalPanel } from "./approval-panel";
import { ResultView } from "./result-view";
import { CopyButton } from "./copy-button";

export function RunDetail({ view }: { view: RunView | null }) {
  // Load the persisted record for a run with no live trace (prior session).
  const liveEvents = view?.events ?? [];
  const runId = view?.summary.runId;
  const terminal = view?.summary.status === "finished" || view?.summary.status === "error";
  const needRecord = liveEvents.length === 0 && terminal && !!runId;
  const [record, setRecord] = useState<WireTraceEvent[]>([]);

  useEffect(() => {
    if (!needRecord || !runId) {
      setRecord([]);
      return;
    }
    let cancelled = false;
    fetchRunEvents(runId)
      .then(({ events }) => {
        if (!cancelled) setRecord(events);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [runId, needRecord]);

  if (!view) {
    return (
      <div className="flex min-h-64 items-center justify-center rounded-lg border border-border bg-card p-6 text-sm text-muted-foreground">
        Select a run to watch it live.
      </div>
    );
  }

  const { summary } = view;
  const shown = liveEvents.length > 0 ? liveEvents : record;
  const isLive =
    summary.status === "running" ||
    summary.status === "starting" ||
    summary.status === "awaiting-approval";
  const liveViewUrl = summary.liveViewUrl;

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <div className="border-b border-border p-4">
        <div className="flex items-start gap-2">
          <StatusDot status={summary.status} className="mt-1.5" />
          <span className="line-clamp-2 text-sm font-medium" title={summary.objective}>
            {summary.objective}
          </span>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span className="capitalize">{summary.status}</span>
          <span>·</span>
          <span>{summary.mode}</span>
          {summary.runId && (
            <>
              <span>·</span>
              <span className="font-mono">{summary.runId}</span>
            </>
          )}
          {summary.classification && (
            <>
              <span>·</span>
              <ClassificationChip kind={summary.classification} />
            </>
          )}
          {isLive && liveViewUrl && (
            <a
              href={liveViewUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" /> live browser
            </a>
          )}
          <span className="ml-auto">
            <CopyButton text={serializeRun(summary, shown)} />
          </span>
        </div>
      </div>
      {summary.pendingApproval && (
        <ApprovalPanel launchId={summary.launchId} approval={summary.pendingApproval} />
      )}
      {/* The Steel player is a live-only WebRTC stream; once the run ends the
          session is stopped and the player 404s. Show the live iframe only while
          running; for finished runs, play back the MP4 recording instead. */}
      {isLive && liveViewUrl && <LiveView url={liveViewUrl} live />}
      {terminal && summary.runId && <RecordingPlayer runId={summary.runId} />}
      <ResultView answer={finishSummary(shown)} result={summary.result} error={summary.error} />
      {shown.length === 0 && terminal ? (
        <div className="p-6 text-sm text-muted-foreground">No trace events recorded for this run.</div>
      ) : (
        <StepTimeline events={shown} live={isLive} />
      )}
    </div>
  );
}
