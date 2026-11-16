export interface SSEEvent {
  event: string;
  data: string;
}

export class SSETooLarge extends Error {}

// SSEParser splits decoded text into server-sent events (the WHATWG
// event-stream format); it drops comments, ids and retry hints.
export class SSEParser {
  private buf = "";
  private data = "";
  private type = "";
  private started = false;
  private skipLF = false;

  constructor(private readonly maxEvent = 4 << 20) {}

  push(chunk: string): SSEEvent[] {
    const out: SSEEvent[] = [];
    let text = chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    if (this.skipLF && text.length > 0) {
      this.skipLF = false;
      if (text.charCodeAt(0) === 10) start = 1;
    }
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.line(this.buf + text.slice(start, i), out);
      this.buf = "";
      if (c === 13) {
        if (i + 1 === text.length) this.skipLF = true;
        else if (text.charCodeAt(i + 1) === 10) i++;
      }
      start = i + 1;
    }
    this.buf += text.slice(start);
    if (this.buf.length + this.data.length > this.maxEvent) throw new SSETooLarge("event too large");
    return out;
  }

  private line(line: string, out: SSEEvent[]): void {
    if (line === "") {
      if (this.data !== "") out.push({ event: this.type || "message", data: this.data.slice(0, -1) });
      this.data = "";
      this.type = "";
      return;
    }
    if (line.charCodeAt(0) === 58) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === "event") this.type = value;
    else if (field === "data") {
      this.data += value + "\n";
      if (this.data.length > this.maxEvent) throw new SSETooLarge("event too large");
    }
  }
}
