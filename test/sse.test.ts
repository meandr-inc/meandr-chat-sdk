import { describe, expect, it } from "vitest";
import { SSEParser, SSETooLarge } from "../src/sse";

function all(chunks: string[]) {
  const p = new SSEParser();
  return chunks.flatMap((c) => p.push(c));
}

describe("SSEParser", () => {
  it("reads named events", () => {
    expect(all(['event: delta\ndata: {"text":"a"}\n\n'])).toEqual([{ event: "delta", data: '{"text":"a"}' }]);
  });

  it("joins data lines and defaults the type", () => {
    expect(all(["data: a\ndata: b\n\n"])).toEqual([{ event: "message", data: "a\nb" }]);
  });

  it("takes LF, CRLF and CR line ends, even split across chunks", () => {
    const want = [
      { event: "x", data: "1" },
      { event: "y", data: "2" },
      { event: "z", data: "3" },
    ];
    expect(all(["event: x\r\ndata: 1\r\n\r\nevent: y\rdata: 2\r\revent: z\ndata: 3\n\n"])).toEqual(want);
    expect(all(["event: x\r", "\ndata: 1\r", "\n\r", "\nevent: y\r", "data: 2\r\r", "event: z\n", "data: 3\n", "\n"])).toEqual(want);
  });

  it("survives every split point", () => {
    const text = 'event: conversation\r\ndata: {"id":"c"}\r\n\r\n: keep-alive\n\nevent: done\ndata: {"stop":"end"}\n\n';
    for (let i = 0; i <= text.length; i++) {
      expect(all([text.slice(0, i), text.slice(i)])).toEqual([
        { event: "conversation", data: '{"id":"c"}' },
        { event: "done", data: '{"stop":"end"}' },
      ]);
    }
    expect(all(text.split(""))).toHaveLength(2);
  });

  it("drops comments, ids, retries and unknown fields", () => {
    expect(all([": keep-alive\n\nid: 7\nretry: 10\nfoo: bar\n\n"])).toEqual([]);
  });

  it("keeps a value's colons and strips one leading space only", () => {
    expect(all(["data:  a: b\n\n", "data:c\n\n"])).toEqual([
      { event: "message", data: " a: b" },
      { event: "message", data: "c" },
    ]);
  });

  it("treats a field without a colon as empty", () => {
    expect(all(["data\n\n"])).toEqual([{ event: "message", data: "" }]);
    expect(all(["event: x\n\n"])).toEqual([]);
    expect(all(["data\ndata: x\n\n"])).toEqual([{ event: "message", data: "\nx" }]);
  });

  it("strips a leading BOM", () => {
    expect(all(["﻿data: x\n\n"])).toEqual([{ event: "message", data: "x" }]);
  });

  it("holds an unfinished event", () => {
    const p = new SSEParser();
    expect(p.push("event: delta\ndata: x\n")).toEqual([]);
    expect(p.push("\n")).toEqual([{ event: "delta", data: "x" }]);
  });

  it("refuses an event over its cap", () => {
    const p = new SSEParser(16);
    expect(() => p.push("data: 0123456789abcdef0123\n")).toThrow(SSETooLarge);
    expect(() => new SSEParser(16).push("data: 0123456789abcdef0123")).toThrow(SSETooLarge);
  });
});
