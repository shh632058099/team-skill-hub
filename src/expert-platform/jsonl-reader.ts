import { StringDecoder } from "node:string_decoder";

/** Incremental, bounded UTF-8 JSONL reader. Never buffers the full model stream. */
export class JsonlReader {
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private totalBytes = 0;
  constructor(
    private readonly onEvent: (event: unknown) => void,
    private readonly maxLineBytes = 256 * 1024,
    private readonly maxTotalBytes = 64 * 1024 * 1024,
  ) {}

  push(chunk: Buffer): void {
    this.totalBytes += chunk.length;
    if (this.totalBytes > this.maxTotalBytes) throw new Error("EXPERT_STREAM_OUTPUT_LIMIT");
    this.pending += this.decoder.write(chunk);
    let index: number;
    while ((index = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, index).replace(/\r$/, "");
      this.pending = this.pending.slice(index + 1);
      this.consume(line);
    }
    if (Buffer.byteLength(this.pending, "utf8") > this.maxLineBytes) throw new Error("EXPERT_STREAM_LINE_LIMIT");
  }

  finish(): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) this.consume(this.pending);
    this.pending = "";
  }

  private consume(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) throw new Error("EXPERT_STREAM_LINE_LIMIT");
    if (!line.trim()) return;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      throw new Error("EXPERT_INVALID_STREAM_EVENT");
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error("EXPERT_INVALID_STREAM_EVENT");
    this.onEvent(event);
  }
}
