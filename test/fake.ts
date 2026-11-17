// FakeChat plays Meandr Chat's API v1 (meandr-chat internal/server) behind a
// fetch, with the browser's cookie jar: it keeps the cookie unless told not to.

interface Message {
  id: number;
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  tool_titles?: Record<string, string>;
  files?: FileJSON[];
  created_at: string;
}

export interface FileJSON {
  id: string;
  name: string;
  type: string;
  size: number;
  created_at: string;
}

interface Stored extends FileJSON {
  owner: string;
  bytes: Uint8Array;
  taken: boolean;
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
  tools?: Array<{ name: string; status: string; title?: string }>;
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
  ended: string | null;
}

interface Identity {
  sub: string;
  ext: string;
  anonymous: boolean;
}

export const ORIGIN = "https://calm-otter.meandr.io";
export const TOKEN_URL = "https://shop.example/chat_token";
const PAGE = 20; // messages or conversations a read answers

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
  attachments = true; // CHAT_ATTACHMENTS
  fileTypes = TYPES.slice(); // the kinds switched on
  maxFileBytes = 7 << 20; // CHAT_ATTACHMENT_MAX_MIB
  perMessage = 5; // CHAT_ATTACHMENTS_PER_MESSAGE
  storageBytes = 50 << 20; // CHAT_ATTACHMENT_STORAGE_MIB
  saysFiles = true; // false plays a chat from before files, whose session says nothing of them
  contextMax: number | null = 8 << 10; // CHAT_PAGE_CONTEXT_KIB; null plays a chat from before page context
  conversationList: boolean | null = false; // CHAT_CONVERSATION_LIST; null plays a chat from before the list
  files = new Map<string, Stored>();
  private n = 0;
  private msgId = 0;

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const headers = new Headers(init.headers);
    const method = (init.method || "GET").toUpperCase();
    const body = typeof init.body === "string" && init.body !== "" ? JSON.parse(init.body) : (init.body ?? undefined);
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
      return "status" in who ? who : this.startTurn(who, (body || {}) as { new?: boolean; context?: unknown }, init.signal);
    }
    const m = /^\/chat\/v1\/conversations(?:\/([^/?]+)(\/messages|\/end)?)?(?:\?(.*))?$/.exec(path);
    if (m) {
      const who = this.identify(bearer);
      if ("status" in who) return who;
      const id = m[1] ? decodeURIComponent(m[1]) : null;
      const before = new URLSearchParams(m[3] || "").get("before");
      if (method === "GET" && !m[2]) return id ? this.view(who, id, before) : this.list(who, before);
      if (method === "POST" && id && m[2] === "/end") return this.end(who, id);
      if (method === "POST" && (!id || m[2] === "/messages")) return this.message(who, id, body, init.signal);
      if (method === "DELETE" && id && !m[2]) return this.remove(who, id);
    }
    const f = /^\/chat\/v1\/files(?:\/([^/?]+))?(?:\?(.*))?$/.exec(path);
    if (f) {
      const who = this.identify(bearer);
      if ("status" in who) return who;
      if (method === "POST" && !f[1]) {
        if (!this.takes()) return json(403, { error: "attachments_off", message: "This chat takes no files." });
        const name = new URLSearchParams(f[2] || "").get("name") || "";
        return this.upload(who, name, headers.get("Content-Type") || "", body as Blob);
      }
      if (method === "GET" && f[1]) return this.download(who, decodeURIComponent(f[1]));
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
    const c: Conv = { id, sub, ext, messages: [], answering: 0, pending: null, ended: null };
    this.add(c, texts);
    this.convs.set(id, c);
    return c;
  }

  // add stores the next messages of c, the user's and the assistant's in turn, as another tab would.
  add(c: Conv, texts: string[]): void {
    texts.forEach((text, i) => c.messages.push(this.msg(i % 2 ? "assistant" : "user", text)));
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
      messages: conv ? conv.messages.slice(-PAGE) : [],
      has_more: conv ? conv.messages.length > PAGE : false,
      answering: conv ? conv.answering > 0 || conv.pending !== null : false,
    };
    if (this.saysFiles) {
      out.files = this.takes() ? { types: this.fileTypes, max_bytes: this.maxFileBytes, per_message: this.perMessage } : null;
    }
    if (this.contextMax !== null) out.context_max_bytes = this.contextMax;
    if (this.conversationList !== null) out.conversation_list = this.conversationList;
    if (sessionToken) out.session_token = sessionToken;
    return json(200, out);
  }

  private takes(): boolean {
    return this.attachments && this.fileTypes.length > 0;
  }

  // pageContext refuses what server.go's pageContext does: no JSON object, past
  // contextMax bytes as sent, or a url, title or timezone that isn't a short string.
  private pageContext(v: unknown): Response | null {
    if (v === undefined || v === null || this.contextMax === null) return null;
    if (typeof v !== "object" || Array.isArray(v)) return json(400, { error: "bad_request", message: "The page's context isn't a JSON object." });
    const size = (s: string) => new TextEncoder().encode(s).length;
    if (size(JSON.stringify(v)) > this.contextMax) return json(413, { error: "too_large", message: "The page's context is too large." });
    const o = v as Record<string, unknown>;
    for (const [k, most] of [["url", 2048], ["title", 512], ["timezone", 64]] as const) {
      const f = o[k];
      if (f != null && (typeof f !== "string" || size(f) > most)) {
        return json(400, { error: "bad_request", message: "The page's url, title and timezone must be short strings." });
      }
    }
    return null;
  }

  private latest(who: Identity): Conv | undefined {
    return this.mine(who).find((c) => !c.ended);
  }

  // mine is the user's conversations in their scope, most recently active first.
  private mine(who: Identity): Conv[] {
    const active = (c: Conv) => (c.messages.length ? c.messages[c.messages.length - 1].id : 0);
    const all = Array.from(this.convs.values()).filter((c) => c.sub === who.sub && c.ext === who.ext);
    return all.reverse().sort((a, b) => active(b) - active(a));
  }

  // list answers the user's conversations a page at a time, after before's, each titled.
  private list(who: Identity, before: string | null): Response {
    if (!this.conversationList) return json(403, { error: "conversation_list_off", message: "This chat doesn't list conversations." });
    const all = this.mine(who);
    const from = before === null ? 0 : all.findIndex((c) => c.id === before) + 1;
    if (!from && before !== null) return json(404, { error: "not_found", message: "No such conversation." });
    const page = all.slice(from, from + PAGE).map((c) => ({ ...this.conversationJSON(c), title: titleOf(c) }));
    return json(200, { conversations: page, has_more: all.length > from + PAGE });
  }

  private conversationJSON(c: Conv) {
    return { id: c.id, created_at: "2026-11-15T00:00:00Z", updated_at: "2026-11-15T00:00:00Z", ended_at: c.ended };
  }

  // owned is the user's conversation, or 404: one they ended too where the chat lists none, but for ending it again.
  private owned(who: Identity, id: string, evenEnded = false): Conv | Response {
    const c = this.convs.get(id);
    if (!c || c.sub !== who.sub || (c.ended && !this.conversationList && !evenEnded)) {
      return json(404, { error: "not_found", message: "No such conversation." });
    }
    return c;
  }

  // end marks the user's conversation ended, answering 204 for one ended already.
  private end(who: Identity, id: string): Response {
    const c = this.owned(who, id, true);
    if ("status" in c) return c;
    if (!c.ended) c.ended = "2026-11-17T00:00:00Z";
    return new Response(null, { status: 204 });
  }

  // remove deletes the user's conversation where the chat lists them, unless an answer is being written in it.
  private remove(who: Identity, id: string): Response {
    if (!this.conversationList) return json(403, { error: "conversation_list_off", message: "This chat doesn't list conversations." });
    const c = this.owned(who, id);
    if ("status" in c) return c;
    if (c.answering > 0 || c.pending !== null) return json(409, { error: "busy", message: "An answer is being written in it." });
    this.convs.delete(id);
    return new Response(null, { status: 204 });
  }

  // view answers a conversation's last 20 messages, or the 20 before message before. Only
  // reading the last moves a running answer on, as time would.
  private view(who: Identity, id: string, before: string | null): Response {
    if (this.failViews > 0) {
      this.failViews--;
      throw new TypeError("network error");
    }
    if (before !== null && !/^[1-9]\d*$/.test(before)) return json(400, { error: "bad_request", message: "before isn't a message id." });
    const c = this.owned(who, id);
    if ("status" in c) return c;
    let answering = c.answering > 0 || c.pending !== null;
    if (before === null && c.answering > 0) {
      c.answering--;
    } else if (before === null && c.pending !== null) {
      c.messages.push(this.msg("assistant", c.pending));
      c.pending = null;
      answering = false;
    }
    const older = before === null ? c.messages : c.messages.filter((m) => m.id < Number(before));
    return json(200, { conversation: this.conversationJSON(c), messages: older.slice(-PAGE), has_more: older.length > PAGE, answering });
  }

  private message(who: Identity, id: string | null, body: { text?: unknown; files?: unknown; context?: unknown } | undefined, signal?: AbortSignal | null): Response {
    const text = body && typeof body.text === "string" ? goText(body.text) : "";
    const ids: unknown[] = body && Array.isArray(body.files) ? body.files : [];
    if (ids.length && !this.takes()) return json(403, { error: "attachments_off", message: "This chat takes no files." });
    if (!text && !ids.length) return json(400, { error: "bad_request", message: "The message is empty." });
    const refused = this.pageContext(body && body.context);
    if (refused) return refused;
    if (ids.length > this.perMessage) return json(400, { error: "bad_request", message: "Too many files." });
    const files: FileJSON[] = [];
    for (const fid of ids) {
      const s = typeof fid === "string" ? this.files.get(fid) : undefined;
      if (!s || s.owner !== who.sub || s.taken) return json(400, { error: "bad_request", message: "No such file: " + String(fid) });
      files.push(fileJSON(s));
    }
    let c: Conv;
    if (id) {
      const o = this.owned(who, id);
      if ("status" in o) return o;
      c = o;
    } else {
      c = { id: "c" + ++this.n, sub: who.sub, ext: who.ext, messages: [], answering: 0, pending: null, ended: null };
    }
    const running = Array.from(this.convs.values()).some((x) => x.sub === who.sub && (x.answering > 0 || x.pending !== null));
    if (running || Date.now() < this.busyUntil) return json(409, { error: "busy", message: "Still answering your previous message." });
    if (!id) this.convs.set(c.id, c);
    const user = this.msg("user", text);
    if (files.length) user.files = files;
    for (const fl of files) this.files.get(fl.id)!.taken = true;
    c.messages.push(user);
    c.ended = null; // the user's message reopens it
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
    for (const t of turn.tools || []) if (t.title) stored.tool_titles = { ...stored.tool_titles, [t.name]: t.title };
    c.messages.push(stored);
    parts.push(": keep-alive\n\n");
    parts.push(ev("done", { message: stored, stop: turn.stop || "end" }));
    return stream(parts, "close", signal);
  }

  // startTurn has the assistant speak first, as server.go's pageStart: the
  // conversation first, never a message event, the start turn itself hidden.
  private startTurn(who: Identity, body: { new?: boolean; context?: unknown }, signal?: AbortSignal | null): Response {
    const fresh = !!body.new;
    const refused = this.pageContext(body.context);
    if (refused) return refused;
    if (this.startPrompt === null) return json(403, { error: "start_not_allowed", message: "This chat doesn't start conversations itself." });
    const running = Array.from(this.convs.values()).some((x) => x.sub === who.sub && (x.answering > 0 || x.pending !== null));
    if (running || Date.now() < this.busyUntil) return json(409, { error: "busy", message: "Still answering your previous message." });
    let c = fresh ? undefined : this.latest(who);
    if (!c) {
      c = { id: "c" + ++this.n, sub: who.sub, ext: who.ext, messages: [], answering: 0, pending: null, ended: null };
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

  // upload keeps a file for its visitor's next message, its type read from its bytes.
  private async upload(who: Identity, name: string, declared: string, file: Blob): Promise<Response> {
    if (file.size > this.maxFileBytes) return json(413, { error: "too_large", message: "The file is too large." });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = sniff(bytes, declared);
    if (!type || this.fileTypes.indexOf(type) < 0) return json(415, { error: "unsupported_type", message: "The chat doesn't take this kind of file." });
    let kept = 0;
    for (const s of this.files.values()) if (s.owner === who.sub) kept += s.size;
    if (kept + bytes.length > this.storageBytes) return json(403, { error: "storage_full", message: "Too many files kept." });
    const s: Stored = { id: "f" + ++this.n, name: cleanName(name), type, size: bytes.length, created_at: "2026-11-17T00:00:00Z", owner: who.sub, bytes, taken: false };
    this.files.set(s.id, s);
    return json(201, fileJSON(s));
  }

  // download answers a file to its uploader alone: an image as itself, anything else to save.
  private download(who: Identity, id: string): Response {
    const s = this.files.get(id);
    if (!s || s.owner !== who.sub) return json(404, { error: "not_found", message: "No such file." });
    const image = s.type.startsWith("image/");
    const headers: Record<string, string> = {
      "Content-Type": image ? s.type : "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "no-store",
    };
    if (!image) headers["Content-Disposition"] = "attachment";
    return new Response(s.bytes.slice(), { status: 200, headers });
  }
}

export const TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "application/pdf", "text/plain", "text/markdown", "text/csv"];

function fileJSON(s: Stored): FileJSON {
  return { id: s.id, name: s.name, type: s.type, size: s.size, created_at: s.created_at };
}

// titleOf is the start of c's first user message, its whitespace runs single spaces, at most 100 characters.
function titleOf(c: Conv): string {
  const first = c.messages.find((m) => m.role === "user");
  return first ? Array.from(first.text.replace(/\s+/g, " ").trim()).slice(0, 100).join("") : "";
}

// sniff reads a file's type as the chat does: an image's or a PDF's signature,
// or else text, where a declared Markdown or CSV stands.
function sniff(b: Uint8Array, declared: string): string | null {
  const at = (sig: number[], from = 0) => sig.every((v, i) => b[from + i] === v);
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (at([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (at([0x47, 0x49, 0x46, 0x38])) return "image/gif";
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (at([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  if (b.includes(0)) return null;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return null;
  }
  const d = declared.split(";")[0].trim().toLowerCase();
  return d === "text/markdown" || d === "text/csv" ? d : "text/plain";
}

// cleanName drops control characters and path separators, keeps 255 bytes, and names none "file".
function cleanName(name: string): string {
  let out = "";
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 32 || c === 127 || ch === "/" || ch === "\\") continue;
    if (new TextEncoder().encode(out + ch).length > 255) break;
    out += ch;
  }
  return out || "file";
}

interface Progress {
  loaded: number;
  total: number;
}

// xhrOf plays XMLHttpRequest over fake.fetch: an upload reports its progress in
// quarters, or, stalled, never moves.
export function xhrOf(fake: FakeChat, stall = false) {
  return class FakeXHR {
    static sent: FakeXHR[] = [];
    withCredentials = false;
    status = 0;
    responseText = "";
    upload: { onprogress: ((e: Progress) => void) | null } = { onprogress: null };
    onprogress: (() => void) | null = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    aborted = false;
    method = "";
    url = "";
    headers: Record<string, string> = {};
    res: Response | null = null;

    open(method: string, url: string): void {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name: string, value: string): void {
      this.headers[name] = value;
    }

    getResponseHeader(name: string): string | null {
      return this.res ? this.res.headers.get(name) : null;
    }

    abort(): void {
      this.aborted = true;
    }

    send(body: Blob): void {
      FakeXHR.sent.push(this);
      if (!stall) void this.run(body);
    }

    async run(body: Blob): Promise<void> {
      for (let q = 1; q <= 4; q++) {
        await Promise.resolve();
        if (this.aborted) return;
        if (this.upload.onprogress) this.upload.onprogress({ loaded: Math.floor((body.size * q) / 4), total: body.size });
      }
      try {
        const init: RequestInit = { method: this.method, headers: this.headers, body, credentials: this.withCredentials ? "include" : "same-origin" };
        this.res = await fake.fetch(this.url, init);
        this.responseText = await this.res.text();
      } catch {
        if (!this.aborted && this.onerror) this.onerror();
        return;
      }
      if (this.aborted) return;
      this.status = this.res.status;
      if (this.onload) this.onload();
    }
  };
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
