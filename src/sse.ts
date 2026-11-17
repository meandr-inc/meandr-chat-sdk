export interface SSEEvent {
  event: string;
  data: string;
}

export class SSETooLarge extends Error {}

// SSEParser splits decoded text into server-sent events (the WHATWG
// event-stream format); it drops comments, ids and retry hints.
export class SSEParser {
  private buf_ = "";
  private data_ = "";
  private type_ = "";
  private started_ = false;
  private skipLF_ = false;

  constructor(private readonly maxEvent_ = 4 << 20) {}

  push(chunk: string): SSEEvent[] {
    const out: SSEEvent[] = [];
    let text = chunk;
    if (!this.started_ && text.length > 0) {
      this.started_ = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    let start = 0;
    if (this.skipLF_ && text.length > 0) {
      this.skipLF_ = false;
      if (text.charCodeAt(0) === 10) start = 1;
    }
    for (let i = start; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c !== 10 && c !== 13) continue;
      this.line_(this.buf_ + text.slice(start, i), out);
      this.buf_ = "";
      if (c === 13) {
        if (i + 1 === text.length) this.skipLF_ = true;
        else if (text.charCodeAt(i + 1) === 10) i++;
      }
      start = i + 1;
    }
    this.buf_ += text.slice(start);
    if (this.buf_.length + this.data_.length > this.maxEvent_) throw new SSETooLarge("event too large");
    return out;
  }

  private line_(line: string, out: SSEEvent[]): void {
    if (line === "") {
      if (this.data_ !== "") out.push({ event: this.type_ || "message", data: this.data_.slice(0, -1) });
      this.data_ = "";
      this.type_ = "";
      return;
    }
    if (line.charCodeAt(0) === 58) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.charCodeAt(0) === 32) value = value.slice(1);
    if (field === "event") this.type_ = value;
    else if (field === "data") {
      this.data_ += value + "\n";
      if (this.data_.length > this.maxEvent_) throw new SSETooLarge("event too large");
    }
  }
}
