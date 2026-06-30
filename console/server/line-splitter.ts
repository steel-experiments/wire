// ABOUTME: Splits a byte/text stream into complete lines for NDJSON parsing.
// ABOUTME: Buffers partial trailing lines across chunk boundaries.

export class LineSplitter {
  private buffer = "";

  /** Feed a chunk; return any complete (non-empty) lines it produced. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    return parts.filter((line) => line.length > 0);
  }

  /** Return any buffered remainder (e.g. a final line with no trailing \n). */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest.length > 0 ? [rest] : [];
  }
}
