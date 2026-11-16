import { aborted, apiBase, discard, failure, readJSON, request, sleep, type Call, type Fetch } from "./api.js";
import { ChatError, isChatError } from "./errors.js";
import { SSEParser } from "./sse.js";
import { claimsOf, hide, originOf, renews, type Secret, tokenWay, userToken, type Way, wayOf } from "./token.js";
import type {
  Answer,
  Chat,
  ChatOptions,
  ChatState,
  Conversation,
  Message,
  ReopenOptions,
  SendResult,
  Stop,
} from "./types.js";

// Auth is what a request carries: the browser's cookie, or, in a browser that
// doesn't keep it, the customer's token or an anonymous session's token.
type Auth = { kind: "cookie" } | { kind: "token"; token: Secret } | { kind: "session"; token: Secret };

interface Opened {
  anonymous: boolean;
  started: boolean;
  conversation: Conversation | null;
  messages: Message[];
  answering: boolean;
  sessionToken: string | null;
}

interface View {
  conversation: Conversation;
  messages: Message[];
  answering: boolean;
}

interface Reply {
  message: Message;
  stop: Stop | null;
}

// Sent is a message on its way: its text, the conversation it went to (null
// for a new one), and the newest message id the page knew before it.
interface Sent {
  text: string;
  target: string | null;
  known: number;
}

const OPTIONS = ["url", "token", "tokenUrl", "getToken", "fetch"];
const EVENTS = ["conversation", "message", "delta", "tool", "done", "error"];
const TRANSIENT = ["network", "internal", "rate_limited", "overloaded", "not_connected", "token_failed"];
const ANSWER_CAP = 1 << 20; // characters of a streaming answer shown; done carries all of it
const TOOLS_CAP = 100;
const STALL_MS = 45_000; // three of the chat's 15 s keep-alives
const STREAM_CAP_MS = 65 * 60_000; // past the longest reply timeout a workspace may set
const WAIT_CAP_MS = 60_000;
const BUSY_CAP_MS = 120_000;
const BUSY_STEPS_MS = [2_000, 3_000, 5_000, 8_000, 10_000];
const LOOKUP_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const POLL_MS = 3_000;
const POLL_SLOW_MS = 10_000;
const POLL_CAP_MS = 600_000;
const POLL_FAILURES = 20;
// Opening tries again briskly through the first minute, then every 15 to 30 s:
// a restarting chat answers through hops the browser shows as network errors.
const OPEN_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const OPEN_LATER_MS = 15_000;
const SIGN_OUT_MS = 3_000;

const IDLE: ChatState = {
  status: "idle",
  anonymous: null,
  conversation: null,
  messages: [],
  outgoing: null,
  answer: null,
  answering: false,
  waiting: null,
  stop: null,
  error: null,
};

export function createChat(options: ChatOptions): Chat {
  return new Client(options);
}

class Client implements Chat {
  private readonly base: string;
  private readonly origin: string;
  private readonly fetchFn: Fetch;
  private way: Way;
  private s: ChatState = IDLE;
  private readonly listeners = new Set<(s: ChatState) => void>();
  private auth: Auth = { kind: "cookie" };
  private who: string | null = null; // the session's user: a token's sub and ext, "anonymous", or "cookie"
  private cookieless = false; // learned once: this browser doesn't keep the chat's cookie
  private opening: Promise<ChatState> | null = null;
  private session = new AbortController(); // aborted by reopen, signOut and destroy
  private conv = new AbortController(); // aborted with the session, and by newConversation
  private convVersion = 0;
  private wantNew = false; // newConversation before the session opened
  private sending: object | null = null;
  private watcher: AbortController | null = null;
  private unsure: Sent | null = null; // a message the chat may have stored: sending it again checks first
  private maxSeen = 0; // message ids rise, so a newer message has a larger one
  private batching = false; // a stream's chunk is applied at once: listeners hear it once
  private dirty = false;
  private dead = false;

  constructor(o: ChatOptions) {
    if (!o || typeof o !== "object") throw new TypeError("createChat needs options");
    for (const k of Object.keys(o)) if (OPTIONS.indexOf(k) < 0) throw new TypeError("unknown option " + k);
    if (typeof o.url !== "string") throw new TypeError("url is required: your workspace's URL");
    if (o.fetch !== undefined && typeof o.fetch !== "function") throw new TypeError("fetch must be a function");
    this.base = apiBase(o.url);
    this.origin = originOf(this.base) as string;
    this.way = wayOf(o);
    const f = o.fetch;
    this.fetchFn = f ? (input, init) => f(input, init) : (input, init) => fetch(input, init);
  }

  getState = (): ChatState => this.s;

  subscribe = (listener: (state: ChatState) => void): (() => void) => {
    if (typeof listener !== "function") throw new TypeError("subscribe needs a function");
    if (!this.dead) this.listeners.add(listener);
    this.call(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  open = (): Promise<ChatState> => {
    if (this.dead || this.s.status === "ready") return Promise.resolve(this.s);
    if (!this.opening) {
      const p = this.doOpen();
      this.opening = p;
      const clear = () => {
        if (this.opening === p) this.opening = null;
      };
      p.then(clear, clear);
    }
    return this.opening;
  };

  send = (text: string): Promise<SendResult> => {
    if (typeof text !== "string") throw new TypeError("send needs the message's text");
    return this.doSend(text);
  };

  start = (): Promise<SendResult> => this.doStart();

  newConversation = (): void => {
    if (this.dead) return;
    if (this.s.status !== "ready") this.wantNew = true;
    this.dropConversation();
    this.set({ conversation: null, messages: [], outgoing: null, answer: null, answering: false, waiting: null, stop: null, error: null });
  };

  reopen = (options?: ReopenOptions): Promise<ChatState> => {
    if (options !== undefined && (!options || typeof options !== "object")) throw new TypeError("reopen takes { token }");
    const o = options || {};
    for (const k of Object.keys(o)) if (k !== "token") throw new TypeError("unknown option " + k);
    if ("token" in o) this.way = tokenWay(o.token);
    else if (this.way.kind === "token") throw new TypeError("this client was given token: pass reopen({ token }), null when nobody is signed in");
    if (this.dead) return Promise.resolve(this.s);
    const idle = this.s.status === "idle";
    this.forgetUser();
    return idle ? Promise.resolve(this.s) : this.open();
  };

  signOut = async (): Promise<void> => {
    if (this.dead) return;
    const auth = this.auth;
    if (this.way.kind === "token") this.way = { kind: "token", token: null };
    this.forgetUser();
    const stop = new AbortController();
    const t = setTimeout(() => stop.abort(), SIGN_OUT_MS);
    try {
      // A session token names the session, or else the cookie does.
      const bearer = auth.kind === "session" ? auth.token() : null;
      discard(await request(this.fetchFn, this.base, { method: "DELETE", path: "/session", bearer, signal: stop.signal }));
    } catch {
      // The next page that says nobody is signed in ends it.
    } finally {
      clearTimeout(t);
    }
  };

  destroy = (): void => {
    if (this.dead) return;
    this.dropSession();
    this.dead = true;
    this.listeners.clear();
  };

  // --- state

  private set(patch: Partial<ChatState>): void {
    this.s = { ...this.s, ...patch };
    if (this.batching) this.dirty = true;
    else this.emit();
  }

  private emit(): void {
    if (this.dead) return;
    for (const l of Array.from(this.listeners)) this.call(l);
  }

  private call(listener: (s: ChatState) => void): void {
    try {
      listener(this.s);
    } catch (e) {
      setTimeout(() => {
        throw e;
      });
    }
  }

  private seen(messages: readonly Message[]): void {
    for (const m of messages) if (m.id > this.maxSeen) this.maxSeen = m.id;
  }

  private current(id: string): boolean {
    return this.s.conversation !== null && this.s.conversation.id === id;
  }

  private dropConversation(): void {
    this.conv.abort();
    this.conv = new AbortController();
    this.convVersion++;
    this.sending = null;
    this.watcher = null;
    this.unsure = null;
  }

  private dropSession(): void {
    this.session.abort();
    this.session = new AbortController();
    this.opening = null;
    this.dropConversation();
  }

  private forgetUser(): void {
    this.dropSession();
    this.auth = { kind: "cookie" };
    this.who = null;
    this.wantNew = false;
    this.maxSeen = 0;
    this.s = IDLE;
    this.emit();
  }

  // userChanged wipes what the page shows when a reopened session is someone
  // else's, so nobody sees another's conversation or draft, then shows theirs.
  private userChanged(o: Opened): void {
    if (this.watcher) this.watcher.abort();
    this.watcher = null;
    this.convVersion++;
    this.unsure = null;
    this.wantNew = false;
    this.maxSeen = 0;
    this.s = { ...IDLE, status: "ready" };
    this.show(o, this.convVersion, false);
  }

  // show applies an opened session; hide keeps its conversation off the page,
  // after newConversation, while still learning its newest message.
  private show(o: Opened, version: number, hide: boolean): void {
    this.seen(o.messages);
    if (version !== this.convVersion) {
      this.set({ anonymous: o.anonymous });
      return;
    }
    if (hide) {
      this.set({ anonymous: o.anonymous, conversation: null, messages: [], answering: false });
      return;
    }
    const answering = o.answering && o.conversation !== null;
    this.set({ anonymous: o.anonymous, conversation: o.conversation, messages: merge(this.s.messages, o.messages), answering });
    if (answering && o.conversation) this.watch(o.conversation.id);
  }

  private forget(id: string): void {
    if (this.current(id)) this.set({ conversation: null, messages: [], answer: null, answering: false });
  }

  // --- opening

  private async doOpen(): Promise<ChatState> {
    const session = this.session;
    const version = this.convVersion;
    const began = Date.now();
    this.set({ status: "opening", error: null });
    for (let tries = 0; ; tries++) {
      try {
        const o = await this.establish(session.signal);
        if (session.signal.aborted) return this.s;
        const hidden = this.wantNew;
        this.wantNew = false;
        this.show(o, version, hidden);
        this.set({ status: "ready", waiting: null });
        return this.s;
      } catch (e) {
        if (session.signal.aborted) return this.s;
        const err = asChatError(e);
        // A token the site's backend fails to give is its own error to show.
        if (TRANSIENT.indexOf(err.code) < 0 || err.code === "token_failed") {
          this.set({ status: "error", error: err, waiting: null });
          return this.s;
        }
        // Never given up: the page need not be reloaded once the chat is back.
        const ms = openWait(err, tries, Date.now() - began);
        this.set({ waiting: { code: err.code, until: Date.now() + ms } });
        try {
          await sleep(ms, session.signal);
        } catch {
          return this.s;
        }
      }
    }
  }

  // establish opens or resumes the session for the page's user and settles how
  // requests carry it.
  private async establish(signal: AbortSignal): Promise<Opened> {
    const token = await userToken(this.way, this.fetchFn, signal, false);
    if (typeof token !== "string") return this.openWithout(token === null, signal);
    try {
      return await this.openAs(token, signal);
    } catch (e) {
      if (!isCode(e, "token_expired") || !renews(this.way)) throw e;
    }
    const next = await userToken(this.way, this.fetchFn, signal, true);
    if (typeof next !== "string") return this.openWithout(next === null, signal);
    return this.openAs(next, signal);
  }

  private async openAs(token: string, signal: AbortSignal): Promise<Opened> {
    if (!this.mayCarry(token)) throw notForThisChat(this.origin);
    const who = whoOf(token);
    if (this.cookieless) {
      const o = await this.post({ cookieless: true }, token, signal);
      this.auth = { kind: "token", token: hide(token) };
      this.who = who;
      return o;
    }
    const o = await this.post({}, token, signal);
    if (o.started && !(await this.cookieKept(signal))) {
      this.cookieless = true;
      this.auth = { kind: "token", token: hide(token) };
    } else {
      this.auth = { kind: "cookie" };
    }
    this.who = who;
    return o;
  }

  // openWithout opens with no customer's token. When the page says nobody is
  // signed in, a signed-in session the browser still holds is ended first.
  private async openWithout(nobody: boolean, signal: AbortSignal): Promise<Opened> {
    const held = this.auth;
    if (held.kind === "session") {
      try {
        const o = await this.post({}, held.token(), signal);
        this.who = "anonymous";
        return o;
      } catch (e) {
        if (!isCode(e, "session_expired") && !isCode(e, "unauthorized")) throw e;
      }
    }
    this.auth = { kind: "cookie" };
    if (this.cookieless) return this.openCookieless(signal);
    if (nobody && (await this.signedIn(signal))) await this.end(signal);
    const o = await this.post({}, null, signal);
    if (nobody && !o.anonymous) {
      throw new ChatError("protocol", "The chat answered for a signed-in user on a page that says nobody is signed in.");
    }
    if (o.started && !(await this.cookieKept(signal))) {
      this.cookieless = true;
      return this.openCookieless(signal);
    }
    this.who = o.anonymous ? "anonymous" : "cookie";
    return o;
  }

  private async openCookieless(signal: AbortSignal): Promise<Opened> {
    const o = await this.post({ cookieless: true }, null, signal);
    if (!o.sessionToken) throw new ChatError("protocol", "The chat gave no session token.");
    this.auth = { kind: "session", token: hide(o.sessionToken) };
    this.who = "anonymous";
    return o;
  }

  private async post(body: { cookieless?: boolean }, bearer: string | null, signal: AbortSignal): Promise<Opened> {
    const res = await request(this.fetchFn, this.base, { method: "POST", path: "/session", body, bearer, signal });
    if (!res.ok) throw await failure(res, signal);
    const o = openedOf(await readJSON(res, signal));
    live(signal);
    return o;
  }

  // cookieKept asks, with the cookie alone, whether the browser kept the session it was just given.
  private async cookieKept(signal: AbortSignal): Promise<boolean> {
    const res = await request(this.fetchFn, this.base, { method: "GET", path: "/session", signal });
    if (res.ok || res.status === 401) {
      discard(res);
      live(signal);
      return res.ok;
    }
    throw await failure(res, signal);
  }

  // signedIn asks, with the cookie alone, whether the browser holds a signed-in
  // session, without fetching that user's conversation. One the chat refuses to
  // serve (403) is ended too: it's of no use to anyone.
  private async signedIn(signal: AbortSignal): Promise<boolean> {
    const res = await request(this.fetchFn, this.base, { method: "GET", path: "/session", signal });
    if (res.status === 401 || res.status === 403) {
      discard(res);
      return res.status === 403;
    }
    if (!res.ok) throw await failure(res, signal);
    const v = await readJSON(res, signal);
    return !!v && typeof v === "object" && (v as { anonymous?: unknown }).anonymous === false;
  }

  private async end(signal: AbortSignal): Promise<void> {
    const res = await request(this.fetchFn, this.base, { method: "DELETE", path: "/session", signal });
    if (!res.ok) throw await failure(res, signal);
    discard(res);
  }

  // mayCarry: a token goes only to the chat its aud names, or to the page's own
  // server, which forwards the chat.
  private mayCarry(token: string): boolean {
    const page = typeof location === "object" && location ? location.origin : null;
    if (page === this.origin) return true;
    const c = claimsOf(token);
    return !!c && c.aud.some((a) => originOf(a) === this.origin);
  }

  // --- requests as the session's user

  private bearer(): string | null {
    return this.auth.kind === "cookie" ? null : this.auth.token();
  }

  // authed makes a request as the session's user; a lapsed token or session is
  // renewed or reopened once, for target's conversation.
  private async authed(c: Omit<Call, "bearer" | "signal">, signal: AbortSignal, target: string | null): Promise<Response> {
    for (let retried = false; ; retried = true) {
      const res = await request(this.fetchFn, this.base, { ...c, bearer: this.bearer(), signal });
      if (res.status !== 401 || retried) return res;
      const err = await failure(res, signal);
      if (!(await this.recoverAuth(err, signal, target))) throw err;
    }
  }

  // recoverAuth renews a lapsed token or reopens an ended session. It answers
  // whether to try again, and throws session_expired when the user changed.
  private async recoverAuth(err: ChatError, signal: AbortSignal, target: string | null): Promise<boolean> {
    if (this.auth.kind === "token" && (err.code === "token_expired" || err.code === "unauthorized")) {
      if (!renews(this.way)) return false;
      const token = await userToken(this.way, this.fetchFn, signal, err.code === "token_expired");
      if (typeof token === "string" && whoOf(token) === this.who) {
        if (!this.mayCarry(token)) throw notForThisChat(this.origin);
        this.auth = { kind: "token", token: hide(token) };
        return true;
      }
    } else if (err.code !== "session_expired" && err.code !== "unauthorized") {
      return false;
    }
    // The same user: try target's conversation again, which the chat checks is theirs.
    const o = await this.reestablish(signal);
    this.set({ anonymous: o.anonymous });
    return true;
  }

  // reestablish opens the session again as the page's user, within the flow's
  // signal, so a sign-out meanwhile stops it. Someone else's session wipes the
  // page, and the caller fails with session_expired.
  private async reestablish(signal: AbortSignal): Promise<Opened> {
    live(signal);
    const who = this.who;
    const o = await this.establish(signal);
    live(signal);
    if (this.who !== who) {
      this.userChanged(o);
      throw new ChatError("session_expired", "Someone else is signed in now.", { status: 401 });
    }
    this.seen(o.messages);
    return o;
  }

  // --- messages

  private async doSend(raw: string): Promise<SendResult> {
    const text = normalize(raw);
    if (this.dead) return { ok: false, error: aborted() };
    if (text === "") return { ok: false, error: new ChatError("bad_request", "The message is empty.") };
    if (this.sending || this.s.answering) return { ok: false, error: busy() };
    const mine = {};
    this.sending = mine;
    const scope = this.conv;
    const recheck = this.unsure && this.unsure.text === text ? this.unsure : null;
    this.unsure = null;
    let began = -1;
    this.set({ outgoing: text, error: null, stop: null });
    try {
      if (this.s.status !== "ready") {
        const st = await this.open();
        if (scope.signal.aborted || this.sending !== mine) return { ok: false, error: aborted() };
        if (st.status !== "ready") return this.failed(mine, scope, st.error || new ChatError("unauthorized", "The chat couldn't be opened."), -1);
        if (this.s.answering) return this.failed(mine, scope, busy(), -1);
      }
      began = this.convVersion;
      this.set({ answering: true, answer: { text: "", tools: [] } });
      const r = await this.deliver(text, scope.signal, recheck);
      return { ok: true, message: r.message, stop: r.stop };
    } catch (e) {
      return this.failed(mine, scope, asChatError(e), began);
    } finally {
      if (this.sending === mine) this.sending = null;
    }
  }

  // doStart opens if need be, then has the assistant speak first; the chat
  // supplies the instructions, so nothing of the page's is sent.
  private async doStart(): Promise<SendResult> {
    if (this.dead) return { ok: false, error: aborted() };
    if (this.sending || this.s.answering) return { ok: false, error: busy() };
    const mine = {};
    this.sending = mine;
    const scope = this.conv;
    let began = -1;
    this.set({ error: null, stop: null });
    try {
      if (this.s.status !== "ready") {
        const st = await this.open();
        if (scope.signal.aborted || this.sending !== mine) return { ok: false, error: aborted() };
        if (st.status !== "ready") return this.failed(mine, scope, st.error || new ChatError("unauthorized", "The chat couldn't be opened."), -1);
        if (this.s.answering) return this.failed(mine, scope, busy(), -1);
      }
      began = this.convVersion;
      this.set({ answering: true, answer: { text: "", tools: [] } });
      const r = await this.begin(scope.signal);
      return { ok: true, message: r.message, stop: r.stop };
    } catch (e) {
      return this.failed(mine, scope, asChatError(e), began);
    } finally {
      if (this.sending === mine) this.sending = null;
    }
  }

  // begin asks for the start and reads its answer. Only refusals before the
  // chat starts are tried again; a start never lands twice. With no
  // conversation shown, after newConversation say, it asks for a new one.
  private async begin(signal: AbortSignal): Promise<Reply> {
    const sent: Sent = { text: "", target: null, known: this.maxSeen };
    const call: Omit<Call, "bearer" | "signal"> = this.s.conversation === null
      ? { method: "POST", path: "/start", body: { new: true }, stream: true }
      : { method: "POST", path: "/start", stream: true };
    const waitUntil = Date.now() + WAIT_CAP_MS;
    const busyUntil = Date.now() + BUSY_CAP_MS;
    for (let busyTries = 0; ; ) {
      const stream = new AbortController();
      const stop = () => stream.abort();
      signal.addEventListener("abort", stop);
      try {
        let res: Response;
        try {
          res = await this.authed(call, stream.signal, null);
        } catch (e) {
          if (signal.aborted) throw aborted();
          const reopen = isChatError(e) ? waitFor(e) : null;
          if (reopen !== null && Date.now() + reopen <= waitUntil) {
            await this.pause((e as ChatError).code, reopen, signal);
            continue;
          }
          throw e;
        }
        if (res.ok) return await this.read(res, stream, signal, sent);
        const err = await failure(res, signal);
        const wait = waitFor(err);
        if (wait !== null && Date.now() + wait <= waitUntil) {
          await this.pause(err.code, wait, signal);
          continue;
        }
        if (err.code === "busy" && Date.now() < busyUntil) {
          await this.pause("busy", BUSY_STEPS_MS[Math.min(busyTries++, BUSY_STEPS_MS.length - 1)], signal);
          continue;
        }
        throw err;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    }
  }

  // failed shows a failure. A message the page doesn't show as stored stays in
  // outgoing, so it can be sent again. began is the conversation version this
  // send set answering in; once the page shows another, answering is not its own.
  private failed(mine: object, scope: AbortController, err: ChatError, began: number): SendResult {
    if (this.sending === mine && !scope.signal.aborted && err.code !== "aborted") {
      if (began < 0) this.set({ error: err });
      else if (began === this.convVersion) this.set({ answer: null, answering: false, waiting: null, error: err });
      else this.set({ answer: null, waiting: null, error: err });
    }
    return { ok: false, error: err };
  }

  // deliver sends the message and reads its answer. Only refusals that come
  // before the chat stores it are tried again: nothing after a 200 is resent.
  private async deliver(text: string, signal: AbortSignal, recheck: Sent | null): Promise<Reply> {
    if (recheck) {
      const id = await this.landedSoon(recheck, signal, null);
      if (id !== null) return this.follow(id, recheck, signal);
    }
    const sent: Sent = { text, target: this.s.conversation ? this.s.conversation.id : null, known: this.maxSeen };
    const path = sent.target === null ? "/conversations" : "/conversations/" + encodeURIComponent(sent.target) + "/messages";
    const waitUntil = Date.now() + WAIT_CAP_MS;
    const busyUntil = Date.now() + BUSY_CAP_MS;
    for (let busyTries = 0; ; ) {
      const stream = new AbortController();
      const stop = () => stream.abort();
      signal.addEventListener("abort", stop);
      try {
        let res: Response;
        try {
          res = await this.authed({ method: "POST", path, body: { text }, stream: true }, stream.signal, sent.target);
        } catch (e) {
          if (signal.aborted) throw aborted();
          if (isCode(e, "network")) return await this.ifLanded(e as ChatError, sent, signal);
          // Opening the session again was refused before the message was sent: waiting is safe.
          const reopen = isChatError(e) ? waitFor(e) : null;
          if (reopen !== null && Date.now() + reopen <= waitUntil) {
            await this.pause((e as ChatError).code, reopen, signal);
            continue;
          }
          throw e;
        }
        if (res.ok) return await this.read(res, stream, signal, sent);
        const err = await failure(res, signal);
        if (err.code === "internal") return await this.ifLanded(err, sent, signal);
        if (err.code === "not_found" && sent.target !== null) this.forget(sent.target);
        const wait = waitFor(err);
        if (wait !== null && Date.now() + wait <= waitUntil) {
          await this.pause(err.code, wait, signal);
          continue;
        }
        if (err.code === "busy" && Date.now() < busyUntil) {
          await this.pause("busy", BUSY_STEPS_MS[Math.min(busyTries++, BUSY_STEPS_MS.length - 1)], signal);
          continue;
        }
        throw err;
      } finally {
        signal.removeEventListener("abort", stop);
      }
    }
  }

  private async pause(code: string, ms: number, signal: AbortSignal): Promise<void> {
    live(signal);
    this.set({ waiting: { code, until: Date.now() + ms } });
    try {
      await sleep(ms, signal);
    } finally {
      if (!signal.aborted) this.set({ waiting: null });
    }
  }

  // ifLanded settles a request whose outcome is unknown, a lost connection or a
  // 500: the message may have been stored, so the conversation decides.
  private async ifLanded(err: ChatError, sent: Sent, signal: AbortSignal): Promise<Reply> {
    const id = await this.landedSoon(sent, signal, err);
    if (id === null) throw err;
    return this.follow(id, sent, signal);
  }

  // landedSoon looks for the message, trying again while the chat can't be
  // reached. It answers null only when a lookup said the message isn't there;
  // when none could tell, it throws, and sending the text again checks first.
  private async landedSoon(sent: Sent, signal: AbortSignal, cause: ChatError | null): Promise<string | null> {
    const version = this.convVersion;
    let last: ChatError | null = null;
    for (const ms of LOOKUP_STEPS_MS) {
      await sleep(ms, signal);
      try {
        return await this.landed(sent, signal);
      } catch (e) {
        if (signal.aborted) throw aborted();
        last = asChatError(e);
        if (this.convVersion !== version) throw last;
        if (last.code === "not_found") return null;
        if (TRANSIENT.indexOf(last.code) < 0) break;
      }
    }
    this.unsure = sent;
    if (last && TRANSIENT.indexOf(last.code) < 0) throw last;
    throw cause || last || new ChatError("network", "The chat couldn't be reached.");
  }

  // landed finds the conversation that holds the message sent, if the chat
  // stored it, and shows it. A new conversation holds nothing older than known.
  private async landed(sent: Sent, signal: AbortSignal): Promise<string | null> {
    const mine = (m: Message) => m.role === "user" && m.id > sent.known && m.text === sent.text;
    let found: { conversation: Conversation; messages: Message[] } | null = null;
    if (sent.target !== null) {
      const v = await this.view(sent.target, signal);
      if (v.messages.some(mine)) found = v;
    } else {
      const o = await this.latest(signal);
      if (o.conversation && o.messages.some(mine) && o.messages.every((m) => m.id > sent.known)) {
        found = { conversation: o.conversation, messages: o.messages };
      }
    }
    live(signal);
    if (!found) return null;
    this.seen(found.messages);
    this.set({ conversation: found.conversation, messages: merge(this.s.messages, found.messages), outgoing: null });
    return found.conversation.id;
  }

  // latest opens the session as it is, for its latest conversation: a live
  // cookie needs no token, which may have expired meanwhile. A lapsed session is
  // reopened as the page's user, never swapped for an anonymous one.
  private async latest(signal: AbortSignal): Promise<Opened> {
    if (this.auth.kind === "cookie") {
      const res = await request(this.fetchFn, this.base, { method: "GET", path: "/session", signal });
      if (res.ok) {
        discard(res);
        const o = await this.post({}, null, signal);
        if (!o.started) return o;
      } else if (res.status === 401) {
        discard(res);
      } else {
        throw await failure(res, signal);
      }
      return this.reestablish(signal);
    }
    try {
      return await this.post(this.auth.kind === "token" ? { cookieless: true } : {}, this.bearer(), signal);
    } catch (e) {
      if (!isCode(e, "token_expired") && !isCode(e, "session_expired") && !isCode(e, "unauthorized")) throw e;
      return this.reestablish(signal);
    }
  }

  // read applies the stream's events. A stream that ends without done or error
  // lost the answer, which runs on and is stored, so the conversation is followed.
  private async read(res: Response, stream: AbortController, signal: AbortSignal, sent: Sent): Promise<Reply> {
    let conversation = sent.target;
    let message = false;
    const reader = res.body ? res.body.getReader() : null;
    if (reader) {
      const decoder = new TextDecoder();
      const parser = new SSEParser();
      const cancel = () => {
        reader.cancel().catch(() => {});
      };
      stream.signal.addEventListener("abort", cancel, { once: true });
      if (stream.signal.aborted) cancel();
      let stall = setTimeout(() => stream.abort(), STALL_MS);
      const cap = setTimeout(() => stream.abort(), STREAM_CAP_MS);
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (signal.aborted) throw aborted();
          if (done) break;
          clearTimeout(stall);
          stall = setTimeout(() => stream.abort(), STALL_MS);
          this.batching = true;
          try {
            for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
              if (signal.aborted) throw aborted();
              if (ev.event === "message" && message) continue;
              if (ev.event === "message") message = true;
              const out = this.event(ev.event, ev.data);
              if (!out) continue;
              if ("conversation" in out) conversation = out.conversation;
              else return out;
            }
          } finally {
            this.batching = false;
            if (this.dirty) {
              this.dirty = false;
              this.emit();
            }
          }
        }
      } catch (e) {
        if (signal.aborted) throw aborted();
        if (isChatError(e) && e.code !== "protocol") throw e;
      } finally {
        clearTimeout(stall);
        clearTimeout(cap);
        stream.signal.removeEventListener("abort", cancel);
        cancel();
      }
    }
    if (signal.aborted) throw aborted();
    return this.follow(conversation, { ...sent, target: conversation }, signal);
  }

  // event applies one event: it answers the reply when done, the conversation
  // when one starts, and throws the answer's error.
  private event(name: string, data: string): Reply | { conversation: string } | null {
    if (EVENTS.indexOf(name) < 0) return null;
    let o: Record<string, unknown>;
    try {
      const v = JSON.parse(data);
      o = v && typeof v === "object" ? v : {};
    } catch {
      throw new ChatError("protocol", "The chat's stream couldn't be read.");
    }
    switch (name) {
      case "conversation": {
        const c = conversationOf(o);
        // A start that goes on in the conversation shown keeps its messages.
        if (this.s.conversation && this.s.conversation.id === c.id) this.set({ conversation: c });
        else this.set({ conversation: c, messages: [] });
        return { conversation: c.id };
      }
      case "message": {
        const m = messageOf(o);
        this.seen([m]);
        this.set({ messages: withMessage(this.s.messages, m), outgoing: null });
        return null;
      }
      case "delta": {
        const a = this.s.answer || { text: "", tools: [] };
        if (typeof o.text !== "string" || o.text === "" || a.text.length >= ANSWER_CAP) return null;
        this.set({ answer: { text: a.text + o.text, tools: a.tools } });
        return null;
      }
      case "tool": {
        const a = this.s.answer || { text: "", tools: [] };
        if (typeof o.name !== "string" || typeof o.status !== "string") return null;
        const tools = withTool(a.tools, o.name, o.status);
        if (tools !== a.tools) this.set({ answer: { text: a.text, tools } });
        return null;
      }
      case "done": {
        const m = messageOf(o.message);
        const stop = typeof o.stop === "string" ? (o.stop as Stop) : null;
        this.seen([m]);
        this.set({ messages: withMessage(this.s.messages, m), outgoing: null, answer: null, answering: false, waiting: null, stop });
        return { message: m, stop };
      }
      default: {
        const partial = o.partial ? messageOf(o.partial) : null;
        if (partial) this.seen([partial]);
        this.set({ messages: partial ? withMessage(this.s.messages, partial) : this.s.messages, outgoing: null, answer: null, answering: false });
        const code = typeof o.error === "string" && o.error !== "" ? o.error : "unavailable";
        throw new ChatError(code, typeof o.message === "string" ? o.message : "The answer failed.", { status: 200, partial });
      }
    }
  }

  // follow waits for an answer whose stream was lost: the conversation, found
  // through the session when its first event never came, is asked for until
  // it's answered. The message is stored, so a failure here leaves it unsure.
  private async follow(id: string | null, sent: Sent, signal: AbortSignal): Promise<Reply> {
    const start = sent.text === ""; // a start: no message of the visitor's to find
    if (id === null && start) throw new ChatError("network", "The answer was lost.");
    const cid = id !== null ? id : await this.landedSoon(sent, signal, null);
    if (cid === null) {
      this.unsure = sent;
      throw new ChatError("no_answer", "The answer was lost.");
    }
    const version = this.convVersion;
    let v: View;
    try {
      v = await this.poll(cid, signal);
    } catch (e) {
      if (!start && !signal.aborted && !isCode(e, "not_found") && version === this.convVersion) this.unsure = { ...sent, target: cid };
      throw e;
    }
    live(signal);
    if (this.current(cid)) this.set({ outgoing: null, answer: null, waiting: null });
    let reply: Message | undefined;
    if (start) {
      reply = v.messages.filter((m) => m.role === "assistant" && m.id > sent.known).pop();
    } else {
      let i = v.messages.length - 1;
      while (i >= 0 && !(v.messages[i].role === "user" && v.messages[i].id > sent.known && v.messages[i].text === sent.text)) i--;
      reply = i >= 0 ? v.messages.slice(i + 1).find((m) => m.role === "assistant") : undefined;
    }
    if (!reply) throw new ChatError("no_answer", "The assistant didn't answer.");
    return { message: reply, stop: null };
  }

  private async view(id: string, signal: AbortSignal): Promise<View> {
    const res = await this.authed({ method: "GET", path: "/conversations/" + encodeURIComponent(id) }, signal, id);
    if (!res.ok) throw await failure(res, signal);
    return viewOf(await readJSON(res, signal));
  }

  // poll asks for the conversation every few seconds until no answer is being
  // written in it, then shows what was stored.
  private async poll(id: string, signal: AbortSignal): Promise<View> {
    const started = Date.now();
    let failures = 0;
    for (;;) {
      const elapsed = Date.now() - started;
      if (elapsed >= POLL_CAP_MS) throw new ChatError("timeout", "The answer took too long.");
      await sleep(elapsed < 60_000 ? POLL_MS : POLL_SLOW_MS, signal);
      let v: View;
      try {
        v = await this.view(id, signal);
      } catch (e) {
        if (signal.aborted) throw aborted();
        const err = asChatError(e);
        if (err.code === "not_found") this.forget(id);
        else if (TRANSIENT.indexOf(err.code) >= 0 && ++failures < POLL_FAILURES) continue;
        throw err;
      }
      failures = 0;
      live(signal);
      if (v.answering) continue;
      if (this.current(id)) {
        this.seen(v.messages);
        this.set({ conversation: v.conversation, messages: merge(this.s.messages, v.messages), answering: false });
      }
      return v;
    }
  }

  // watch follows an answer this page didn't start, such as one a previous
  // page left running; a newer watch replaces it.
  private watch(id: string): void {
    if (this.watcher) this.watcher.abort();
    const w = new AbortController();
    this.watcher = w;
    const scope = this.conv.signal;
    const stop = () => w.abort();
    scope.addEventListener("abort", stop, { once: true });
    this.poll(id, w.signal)
      .then(
        () => {},
        () => {
          if (!w.signal.aborted && this.current(id)) this.set({ answering: false });
        },
      )
      .then(() => {
        scope.removeEventListener("abort", stop);
        if (this.watcher === w) this.watcher = null;
      });
  }
}

// openWait is how long opening waits to try again: as the chat says, or the
// steps, through the first minute; then at least 15 to 30 s, at random.
function openWait(err: ChatError, tries: number, elapsed: number): number {
  const said = waitFor(err);
  if (elapsed < WAIT_CAP_MS) return said ?? OPEN_STEPS_MS[Math.min(tries, OPEN_STEPS_MS.length - 1)];
  return Math.max(said ?? 0, OPEN_LATER_MS + Math.random() * OPEN_LATER_MS);
}

// waitFor is how long to wait before trying a refused message again, or null
// when waiting won't help.
function waitFor(err: ChatError): number | null {
  if (err.code !== "rate_limited" && err.code !== "overloaded" && err.code !== "not_connected") return null;
  const secs = err.retryAfter === null ? 5 : Math.min(Math.max(err.retryAfter, 1), 60);
  return secs * 1000;
}

function busy(): ChatError {
  return new ChatError("busy", "Still answering the previous message.");
}

function notForThisChat(origin: string): ChatError {
  return new ChatError("token_failed", "The token is for another chat: its aud must be " + origin + ".");
}

// live stops a flow its page has moved on from, before it writes anything down.
function live(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}

function isCode(e: unknown, code: string): boolean {
  return isChatError(e) && e.code === code;
}

function asChatError(e: unknown): ChatError {
  if (isChatError(e)) return e;
  return new ChatError("protocol", e instanceof Error ? e.message : "Something went wrong.", { cause: e });
}

function whoOf(token: string): string {
  const c = claimsOf(token);
  return c ? c.who : "token";
}

// normalize is the text the chat will store: lone surrogates replaced, as Go's
// JSON decoding does, and trimmed as Go's strings.TrimSpace trims.
function normalize(s: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      i++;
    } else if ((c & 0xf800) === 0xd800) {
      out += s.slice(from, i) + String.fromCharCode(0xfffd);
      from = i + 1;
    }
  }
  const t = from === 0 ? s : out + s.slice(from);
  let a = 0;
  let b = t.length;
  while (a < b && goSpace(t.charCodeAt(a))) a++;
  while (b > a && goSpace(t.charCodeAt(b - 1))) b--;
  return t.slice(a, b);
}

function goSpace(c: number): boolean {
  return (
    (c >= 9 && c <= 13) || c === 32 || c === 0x85 || c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
  );
}

// merge takes the chat's messages, keeping the objects of those that didn't
// change, so a page's memoized rows skip them.
function merge(old: readonly Message[], fresh: Message[]): Message[] {
  const byId = new Map(old.map((m) => [m.id, m] as [number, Message]));
  return fresh.map((m) => {
    const o = byId.get(m.id);
    return o && o.text === m.text && o.role === m.role && o.createdAt === m.createdAt && String(o.tools) === String(m.tools) ? o : m;
  });
}

function withMessage(list: readonly Message[], m: Message): Message[] {
  return list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : list.concat(m);
}

// withTool records a tool's progress: an end updates the call it ends, and the
// list holds at most TOOLS_CAP calls, answering tools itself when full.
function withTool(tools: Answer["tools"], name: string, status: string): Answer["tools"] {
  if (status !== "started") {
    for (let i = tools.length - 1; i >= 0; i--) {
      if (tools[i].name === name && tools[i].status === "started") {
        return tools.slice(0, i).concat({ name, status }, tools.slice(i + 1));
      }
    }
  }
  return tools.length >= TOOLS_CAP ? tools : tools.concat({ name, status });
}

function bad(what: string): ChatError {
  return new ChatError("protocol", "The chat sent " + what + " the client can't read.");
}

function conversationOf(v: unknown): Conversation {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string") throw bad("a conversation");
  return { id: o.id, createdAt: String(o.created_at ?? ""), updatedAt: String(o.updated_at ?? "") };
}

function messageOf(v: unknown): Message {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "number" || typeof o.text !== "string" || (o.role !== "user" && o.role !== "assistant")) {
    throw bad("a message");
  }
  const m: Message = { id: o.id, role: o.role, text: o.text, createdAt: String(o.created_at ?? "") };
  if (Array.isArray(o.tools)) m.tools = o.tools.filter((t): t is string => typeof t === "string");
  return m;
}

// messagesOf skips messages of roles v1 may add later.
function messagesOf(v: unknown): Message[] {
  if (!Array.isArray(v)) return [];
  return v.filter((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant")).map(messageOf);
}

function openedOf(v: unknown): Opened {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw bad("a session");
  return {
    anonymous: o.anonymous === true,
    started: o.started === true,
    conversation: o.conversation ? conversationOf(o.conversation) : null,
    messages: messagesOf(o.messages),
    answering: o.answering === true,
    sessionToken: typeof o.session_token === "string" && o.session_token !== "" ? o.session_token : null,
  };
}

function viewOf(v: unknown): View {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw bad("a conversation");
  return { conversation: conversationOf(o.conversation), messages: messagesOf(o.messages), answering: o.answering === true };
}
