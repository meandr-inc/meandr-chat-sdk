// FakeChat plays Meandr Chat's API v1 (meandr-chat internal/server) behind a
// fetch, with the browser's cookie jar: it keeps the cookie unless told not to.

interface Message {
  id: number;
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  created_at: string;
}

// goText is what Go stores: lone surrogates as U+FFFD (JSON decoding), then strings.TrimSpace.
export function goText(s: string): string {
  let t = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    const pair = c >= 0xd800 && c <= 0xdbff && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00;
    if (pair) t += s[i] + s[++i];
    else t += (c & 0xf800) === 0xd800 ? String.fromCharCode(0xfffd) : s[i];
  }
  const space = (c: number) => (c >= 9 && c <= 13) || c === 32 || c === 0x85 || c === 0xa0 || c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000;
  let a = 0;
  let b = t.length;
  while (a < b && space(t.charCodeAt(a))) a++;
  while (b > a && space(t.charCodeAt(b - 1))) b--;
  return t.slice(a, b);
}

export interface Turn {
  deltas?: string[];
  tools?: Array<{ name: string; status: string }>;
  text?: string;
  stop?: string;
  error?: { error: string; message?: string; partial?: boolean };
  drop?: "before-conversation" | "after-message" | "after-deltas";
  stall?: boolean;
  pollsAnswering?: number;
  extra?: string;
}

export interface Refusal {
  method?: string;
  path?: RegExp;
  status: number;
  error: string;
  retryAfter?: number;
  times?: number;
}

export interface Seen {
  method: string;
  url: string;
  path: string;
  auth: string | null;
  headers: Headers;
  body: unknown;
  init: RequestInit;
}

interface Session {
  id: string;
  sub: string;
  ext: string;
  anonymous: boolean;
  alive: boolean;
}

interface Conv {
  id: string;
  sub: string;
  ext: string;
  messages: Message[];
  answering: number;
  pending: string | null;
}

interface Identity {
  sub: string;
  ext: string;
  anonymous: boolean;
}

export const ORIGIN = "https://calm-otter.meandr.io";
export const TOKEN_URL = "https://shop.example/chat_token";

// jwt makes a customer's token as the chat reads it; the fake checks no signature.
export function jwt(claims: { sub: string; ext?: unknown; aud?: string; exp?: number; n?: number }): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return enc({ alg: "HS256", typ: "JWT" }) + "." + enc({ aud: ORIGIN, ...claims }) + ".sig";
}

export const ALICE = jwt({ sub: "alice" });
export const BOB = jwt({ sub: "bob" });

function claims(token: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString());
  } catch {
    return null;
  }
}

export class FakeChat {
  anonymousAllowed = true;
  keepsCookie = true;
  cookie: string | null = null;
  sessions = new Map<string, Session>();
  convs = new Map<string, Conv>();
  seen: Seen[] = [];
  turns: Turn[] = [];
  refusals: Refusal[] = [];
  expired = new Set<string>();
  busyUntil = 0;
  tokenAnswers: Array<{ status: number; body?: unknown } | Error> = [];
  tokenCalls = 0;
  internalAfterStore = 0;
  failViews = 0;
  startPrompt: string | null = null; // the app's CHAT_START_PROMPT; null refuses a start
  startNew = false; // CHAT_START_CONVERSATION new
  private n = 0;
  private msgId = 0;

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const method = (init.method || "GET").toUpperCase();
    const body = typeof init.body === "string" && init.body !== "" ? JSON.parse(init.body) : undefined;
    if (url.startsWith(TOKEN_URL)) {
      this.tokenCalls++;
      this.seen.push({ method, url, path: url, auth: headers.get("Authorization"), headers, body, init });
      const a = this.tokenAnswers.shift();
      if (!a) return json(200, { token: ALICE });
      if (a instanceof Error) throw a;
      return json(a.status, a.body);
    }
    const path = url.slice(url.indexOf("/chat/v1"));
    this.seen.push({ method, url, path, auth: headers.get("Authorization"), headers, body, init });
    for (const r of this.refusals) {
      if ((r.method && r.method !== method) || (r.path && !r.path.test(path)) || r.times === 0) continue;
      if (r.times !== undefined) r.times--;
      return json(r.status, { error: r.error, message: r.error }, r.retryAfter);
    }
    const bearer = auth(headers);
    if (method === "POST" && path === "/chat/v1/session") return this.open(bearer, body || {});
    if (method === "GET" && path === "/chat/v1/session") {
      const who = this.identify(bearer);
      return "status" in who ? who : json(200, { anonymous: who.anonymous });
    }
    if (method === "DELETE" && path === "/chat/v1/session") {
      const handle = bearer && bearer.startsWith("h_") ? bearer : this.cookie;
      const s = handle ? this.sessions.get(handle) : undefined;
      if (s) s.alive = false;
      this.cookie = null;
      return new Response(null, { status: 204 });
    }
    if (method === "POST" && path === "/chat/v1/start") {
      const who = this.identify(bearer);
      return "status" in who ? who : this.startTurn(who, !!(body && (body as { new?: boolean }).new), init.signal);
    }
    const m = /^\/chat\/v1\/conversations(?:\/([^/]+)(\/messages)?)?$/.exec(path);
    if (m) {
      const who = this.identify(bearer);
      if ("status" in who) return who;
      if (method === "GET" && m[1] && !m[2]) return this.view(who, decodeURIComponent(m[1]));
      if (method === "POST" && (!m[1] || m[2])) return this.message(who, m[1] ? decodeURIComponent(m[1]) : null, body, init.signal);
    }
    return json(404, { error: "not_found", message: "No such page." });
  };

  // live adds a signed-in or anonymous session to the browser's cookie jar.
  live(sub: string, ext = ""): string {
    const id = "h_" + ++this.n;
    this.sessions.set(id, { id, sub, ext, anonymous: sub.startsWith("anon:"), alive: true });
    this.cookie = id;
    return id;
  }

  conversation(sub: string, ext = "", texts: string[] = []): Conv {
    const id = "c" + ++this.n;
    const c: Conv = { id, sub, ext, messages: [], answering: 0, pending: null };
    texts.forEach((text, i) => c.messages.push(this.msg(i % 2 ? "assistant" : "user", text)));
    this.convs.set(id, c);
    return c;
  }

  requests(method?: string, path?: string): Seen[] {
    return this.seen.filter((s) => (!method || s.method === method) && (!path || s.path === path));
  }

  private msg(role: "user" | "assistant", text: string): Message {
    return { id: ++this.msgId, role, text, created_at: "2026-11-15T00:00:00Z" };
  }

  private verify(token: string): Identity | Response {
    const c = claims(token);
    if (!c || typeof c.sub !== "string" || c.aud !== ORIGIN) return json(401, { error: "unauthorized", message: "not valid" });
    if (this.expired.has(token) || (typeof c.exp === "number" && c.exp * 1000 < Date.now())) {
      return json(401, { error: "token_expired", message: "expired" });
    }
    return { sub: c.sub, ext: c.ext === undefined ? "" : JSON.stringify(c.ext), anonymous: false };
  }

  private identify(bearer: string | null): Identity | Response {
    if (bearer && !bearer.startsWith("h_")) return this.verify(bearer);
    const handle = bearer || this.cookie;
    if (!handle) return json(401, { error: "unauthorized", message: "A session is required." });
    const s = this.sessions.get(handle);
    if (!s || !s.alive) {
      if (!bearer) this.cookie = null;
      return json(401, { error: "session_expired", message: "The session has ended." });
    }
    return s;
  }

  private start(who: Identity, cookieless: boolean): string | undefined {
    const id = "h_" + ++this.n;
    this.sessions.set(id, { id, sub: who.sub, ext: who.ext, anonymous: who.anonymous, alive: true });
    if (cookieless) return id;
    if (this.keepsCookie) this.cookie = id;
    else this.cookie = null;
    return undefined;
  }

  private open(bearer: string | null, body: { new?: boolean; cookieless?: boolean }): Response {
    let who: Identity;
    let started = false;
    let sessionToken: string | undefined;
    const cookie = this.cookie ? this.sessions.get(this.cookie) : undefined;
    const live = cookie && cookie.alive ? cookie : undefined;
    if (bearer && !bearer.startsWith("h_")) {
      const v = this.verify(bearer);
      if ("status" in v) return v;
      who = v;
      if (!body.cookieless) {
        if (!live || live.sub !== who.sub || live.ext !== who.ext) {
          if (live) live.alive = false;
          this.start(who, false);
          started = true;
        }
      }
    } else if (bearer) {
      const s = this.sessions.get(bearer);
      if (!s || !s.alive) return json(401, { error: "session_expired", message: "The session has ended." });
      who = s;
    } else if (live) {
      who = live;
    } else {
      if (!this.anonymousAllowed) return json(401, { error: "unauthorized", message: "A session token is required." });
      who = { sub: "anon:" + ++this.n, ext: "", anonymous: true };
      sessionToken = this.start(who, !!body.cookieless);
      started = true;
    }
    const conv = body.new ? undefined : this.latest(who);
    const out: Record<string, unknown> = {
      anonymous: who.anonymous,
      started,
      conversation: conv ? this.conversationJSON(conv) : null,
      messages: conv ? conv.messages.slice(-100) : [],
      answering: conv ? conv.answering > 0 || conv.pending !== null : false,
    };
    if (sessionToken) out.session_token = sessionToken;
    return json(200, out);
  }

  private latest(who: Identity): Conv | undefined {
    let last: Conv | undefined;
    for (const c of this.convs.values()) if (c.sub === who.sub && c.ext === who.ext) last = c;
    return last;
  }

  private conversationJSON(c: Conv) {
    return { id: c.id, created_at: "2026-11-15T00:00:00Z", updated_at: "2026-11-15T00:00:00Z" };
  }

  private owned(who: Identity, id: string): Conv | Response {
    const c = this.convs.get(id);
    if (!c || c.sub !== who.sub) return json(404, { error: "not_found", message: "No such conversation." });
    return c;
  }

  private view(who: Identity, id: string): Response {
    if (this.failViews > 0) {
      this.failViews--;
      throw new TypeError("network error");
    }
    const c = this.owned(who, id);
    if ("status" in c) return c;
    let answering = false;
    if (c.answering > 0) {
      c.answering--;
      answering = true;
    } else if (c.pending !== null) {
      c.messages.push(this.msg("assistant", c.pending));
      c.pending = null;
    }
    return json(200, { conversation: this.conversationJSON(c), messages: c.messages.slice(-100), answering });
  }

  private message(who: Identity, id: string | null, body: { text?: unknown } | undefined, signal?: AbortSignal | null): Response {
    const text = body && typeof body.text === "string" ? goText(body.text) : "";
    if (!text) return json(400, { error: "bad_request", message: "The message is empty." });
    let c: Conv;
    if (id) {
      const o = this.owned(who, id);
      if ("status" in o) return o;
      c = o;
    } else {
      c = { id: "c" + ++this.n, sub: who.sub, ext: who.ext, messages: [], answering: 0, pending: null };
    }
    const running = Array.from(this.convs.values()).some((x) => x.sub === who.sub && (x.answering > 0 || x.pending !== null));
    if (running || Date.now() < this.busyUntil) return json(409, { error: "busy", message: "Still answering your previous message." });
    if (!id) this.convs.set(c.id, c);
    const user = this.msg("user", text);
    c.messages.push(user);
    if (this.internalAfterStore > 0) {
      this.internalAfterStore--;
      c.messages.push(this.msg("assistant", "Stored anyway"));
      return json(500, { error: "internal", message: "Something went wrong." });
    }
    const turn = this.turns.shift() || {};
    const deltas = turn.deltas || ["Hel", "lo"];
    const answer = turn.text !== undefined ? turn.text : deltas.join("");
    const parts: string[] = [];
    if (turn.drop === "before-conversation") return stream([], "drop", signal, () => this.runOn(c, answer, turn));
    if (!id) parts.push(ev("conversation", this.conversationJSON(c)));
    parts.push(ev("message", user));
    if (turn.extra) parts.push(turn.extra);
    if (turn.drop === "after-message") return stream(parts, "drop", signal, () => this.runOn(c, answer, turn));
    for (const t of turn.tools || []) parts.push(ev("tool", t));
    for (const d of deltas) parts.push(ev("delta", { text: d }));
    if (turn.drop === "after-deltas") return stream(parts, "drop", signal, () => this.runOn(c, answer, turn));
    if (turn.stall) return stream(parts, "stall", signal, () => this.runOn(c, answer, turn));
    if (turn.error) {
      const data: Record<string, unknown> = { error: turn.error.error, message: turn.error.message || "failed" };
      if (turn.error.partial) {
        const partial = this.msg("assistant", answer);
        c.messages.push(partial);
        data.partial = partial;
      }
      parts.push(ev("error", data));
      return stream(parts, "close", signal);
    }
    const stored = this.msg("assistant", answer);
    if (turn.tools) stored.tools = turn.tools.filter((t) => t.status === "started").map((t) => t.name);
    c.messages.push(stored);
    parts.push(": keep-alive\n\n");
    parts.push(ev("done", { message: stored, stop: turn.stop || "end" }));
    return stream(parts, "close", signal);
  }

  // startTurn has the assistant speak first, as server.go's pageStart: the
  // conversation first, never a message event, the start turn itself hidden.
  private startTurn(who: Identity, fresh: boolean, signal?: AbortSignal | null): Response {
    if (this.startPrompt === null) return json(403, { error: "start_not_allowed", message: "This chat doesn't start conversations itself." });
    const running = Array.from(this.convs.values()).some((x) => x.sub === who.sub && (x.answering > 0 || x.pending !== null));
    if (running || Date.now() < this.busyUntil) return json(409, { error: "busy", message: "Still answering your previous message." });
    let c = this.startNew || fresh ? undefined : this.latest(who);
    if (!c) {
      c = { id: "c" + ++this.n, sub: who.sub, ext: who.ext, messages: [], answering: 0, pending: null };
      this.convs.set(c.id, c);
    }
    this.msgId++; // the start turn: stored, never shown
    const turn = this.turns.shift() || {};
    const deltas = turn.deltas || ["Hel", "lo"];
    const answer = turn.text !== undefined ? turn.text : deltas.join("");
    const parts = [ev("conversation", this.conversationJSON(c))];
    for (const d of deltas) parts.push(ev("delta", { text: d }));
    if (turn.drop === "after-deltas") return stream(parts, "drop", signal, () => this.runOn(c, answer, turn));
    const stored = this.msg("assistant", answer);
    c.messages.push(stored);
    parts.push(ev("done", { message: stored, stop: turn.stop || "end" }));
    return stream(parts, "close", signal);
  }

  private runOn(c: Conv, answer: string, turn: Turn): void {
    c.answering = turn.pollsAnswering === undefined ? 1 : turn.pollsAnswering;
    c.pending = answer;
  }
}

export function ev(name: string, data: unknown): string {
  return "event: " + name + "\ndata: " + JSON.stringify(data) + "\n\n";
}

function auth(h: Headers): string | null {
  const v = h.get("Authorization");
  if (!v || !/^Bearer /i.test(v)) return null;
  return v.slice(7).trim() || null;
}

export function json(status: number, body: unknown, retryAfter?: number): Response {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (retryAfter !== undefined) headers["Retry-After"] = String(retryAfter);
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers });
}

// stream answers an event stream that closes, breaks, or goes silent until aborted.
function stream(parts: string[], end: "close" | "drop" | "stall", signal?: AbortSignal | null, after?: () => void): Response {
  const enc = new TextEncoder();
  const queue = parts.slice();
  if (after) after();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) {
        controller.enqueue(enc.encode(next));
        return;
      }
      if (end === "close") controller.close();
      else if (end === "drop") controller.error(new TypeError("network error"));
      else {
        return new Promise<void>(() => {
          const fail = () => controller.error(new DOMException("The operation was aborted.", "AbortError"));
          if (signal && signal.aborted) fail();
          else if (signal) signal.addEventListener("abort", fail, { once: true });
        });
      }
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
