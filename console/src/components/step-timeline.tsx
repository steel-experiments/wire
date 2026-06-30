// ABOUTME: Renders a run's live trace as a step-by-step timeline.

import { useEffect, useRef } from "react";
import {
  Eye,
  Code2,
  Check,
  X,
  Flag,
  ShieldAlert,
  AlertTriangle,
  Circle,
} from "lucide-react";
import type { WireTraceEvent } from "@/lib/protocol";
import { cn } from "@/lib/utils";

type Row = { icon: typeof Eye; label: string; detail: string; tone: string };

function str(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function host(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

function clip(value: string, max = 200): string {
  const oneLine = value.replace(/\s+/gu, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

function describe(event: WireTraceEvent): Row | null {
  const p = event.payload;
  switch (event.kind) {
    case "observation":
      return { icon: Eye, label: "observe", detail: `${host(str(p.url))} ${str(p.title) ? `— ${str(p.title)}` : ""}`, tone: "text-muted-foreground" };
    case "code-exec":
      return { icon: Code2, label: "exec", detail: clip(str(p.code) || (p.rawCommands ? `raw[${str(p.rawCommands)}]` : "(no code)")), tone: "text-foreground" };
    case "code-result": {
      const ok = p.ok === true;
      const detail = ok ? str(p.returnValue ?? p.stdout) : str(p.stderr ?? p.returnValue);
      return { icon: ok ? Check : X, label: ok ? "ok" : "err", detail: clip(detail), tone: ok ? "text-success" : "text-destructive" };
    }
    case "thought-summary":
      return { icon: Flag, label: p.kind === "finish" ? "finish" : "stop", detail: str(p.summary ?? p.reason), tone: "text-foreground" };
    case "policy-check":
      return { icon: ShieldAlert, label: "policy", detail: `${str(p.result)} ${str(p.policyKind ?? p.actionKind)}`, tone: "text-warning" };
    case "approval-request":
      return { icon: ShieldAlert, label: "approval", detail: str(p.summary), tone: "text-warning" };
    case "error":
      return { icon: AlertTriangle, label: "error", detail: str(p.message ?? p.code), tone: "text-destructive" };
    default:
      return null;
  }
}

export function StepTimeline({ events, live }: { events: WireTraceEvent[]; live?: boolean }) {
  // The timeline flows with the page. For live runs, keep the tail in view by
  // following the page scroll — but only while the user is parked near the
  // bottom, so scrolling up to read earlier steps isn't yanked back down.
  const stick = useRef(true);

  useEffect(() => {
    stick.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 64;
  }, []);

  useEffect(() => {
    if (live && stick.current) {
      window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
    }
  }, [events.length, live]);

  useEffect(() => {
    const onScroll = () => {
      stick.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 64;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const rows = events.map((event) => ({ event, row: describe(event) })).filter((r) => r.row);

  let step = 0;
  return (
    <div>
      {rows.length === 0 ? (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Circle className="h-3 w-3 animate-pulse" />
          Waiting for the agent’s first step…
        </div>
      ) : (
        <div className="flex flex-col gap-1 p-2 font-mono text-xs">
          {rows.map(({ event, row }, i) => {
            const Icon = row!.icon;
            if (event.kind === "code-exec") step += 1;
            return (
              <div key={`${event.id}-${i}`} className="flex items-start gap-2 rounded px-2 py-1 hover:bg-muted/50">
                <span className="w-8 shrink-0 text-right text-muted-foreground">
                  {event.kind === "code-exec" ? step : ""}
                </span>
                <Icon className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", row!.tone)} />
                <span className={cn("w-16 shrink-0", row!.tone)}>{row!.label}</span>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">
                  {row!.detail}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
