// ABOUTME: In-memory pub/sub for server events with a replay buffer.
// ABOUTME: New subscribers (incl. SSE reconnects) replay everything after a seq.

import type { ServerEvent } from "../src/lib/protocol";

type Listener = (seq: number, event: ServerEvent) => void;

export class EventBus {
  private seq = 0;
  private readonly buffer: { seq: number; event: ServerEvent }[] = [];
  private readonly listeners = new Set<Listener>();
  private readonly maxBuffer: number;

  constructor(maxBuffer = 10_000) {
    this.maxBuffer = maxBuffer;
  }

  publish(event: ServerEvent): number {
    this.seq += 1;
    this.buffer.push({ seq: this.seq, event });
    if (this.buffer.length > this.maxBuffer) this.buffer.shift();
    for (const listener of this.listeners) listener(this.seq, event);
    return this.seq;
  }

  /** Replay buffered events after `sinceSeq`, then receive new ones live. */
  subscribe(listener: Listener, sinceSeq = 0): () => void {
    for (const item of this.buffer) {
      if (item.seq > sinceSeq) listener(item.seq, item.event);
    }
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get lastSeq(): number {
    return this.seq;
  }
}
