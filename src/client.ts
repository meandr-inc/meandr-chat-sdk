import { aborted, apiBase, chunks, discard, failure, readJSON, request, sleep, within, type Call, type Fetch } from "./api.js";
import { ChatError, isChatError } from "./errors.js";
import { SSEParser } from "./sse.js";
import { claimsOf, hide, originOf, renews, type Secret, tokenWay, userToken, type Way, wayOf } from "./token.js";
import type {
  Answer,
  AttachOptions,
  AttachResult,
  Chat,
  ChatFile,
  ChatOptions,
  ChatState,
  Conversation,
  DeleteConversationResult,
  FileLimits,
  ListConversationsOptions,
  ListConversationsResult,
  LoadOlderResult,
  Message,
  OpenConversationResult,
  PageContext,
  Action,
  ActionResponse,
  ReadFileOptions,
  ReadFileResult,
  ReopenOptions,
  RespondResult,
  SendOptions,
  SendResult,
  Stop,
  StopResult,
} from "./types.js";

// Auth is what a request carries: the browser's cookie, or, in a browser that
// doesn't keep it, the customer's token or an anonymous session's token.
type Auth = { kind_: "cookie" } | { kind_: "token"; token: Secret } | { kind_: "session"; token: Secret };

interface Opened {
  anonymous: boolean;
  started_: boolean;
  conversation: Conversation | null;
  messages: Message[];
  more_: boolean; // older messages remain
  answering: boolean;
  actions_: Action[]; // what the answer being written waits on
  sessionToken_: string | null;
  files: FileLimits | null | undefined; // undefined from a chat that doesn't say
  contextMax_: number | undefined;
  list_: boolean; // the host lists conversations
}

interface View {
  conversation: Conversation;
  messages: Message[];
  more_: boolean;
  answering: boolean;
  actions_: Action[];
}

interface Reply {
  message: Message;
  stop: Stop | null;
}

// Sent is a message on its way: its text and files' ids, the conversation it
// went to (null for a new one), and the newest message id the page knew before it.
interface Sent {
  text: string;
  files: string[];
  target_: string | null;
  known_: number;
}

// Unnamed is a send or start out to start a conversation the chat hasn't named yet. Ended
// by the page meanwhile, it goes on unseen while its session lasts, to end it once named.
interface Unnamed {
  session_: AbortSignal;
  done_?: (end?: Promise<void>) => void; // endConversation's, settling its promise
}

const OPTIONS = ["url", "token", "tokenUrl", "getToken", "fetch", "context"];
const EVENTS = ["conversation", "message", "delta", "tool", "action", "done", "error"];
const RESPONSES = ["accept", "decline", "cancel"];
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
const POLL_CAP_MS = 16 * 60_000; // past the chat's 15-minute cap on an answer
const POLL_FAILURES = 20;
// Opening tries again briskly through the first minute, then every 15 to 30 s:
// a restarting chat answers through hops the browser shows as network errors.
const OPEN_STEPS_MS = [1_000, 2_000, 4_000, 8_000, 15_000];
const OPEN_LATER_MS = 15_000;
const SIGN_OUT_MS = 3_000;
const FILE_CAP = 10 << 20; // the proxy refuses a larger body itself, without CORS: the page would see network
const IMAGE = /^image\/(png|jpeg|webp|gif)$/i;
const CONTEXT_MS = 5_000;
const KNOWN: Record<string, number> = { url: 2048, title: 512, timezone: 64 }; // bytes; the chat refuses more, or no string

const IDLE: ChatState = {
  status: "idle",
  anonymous: null,
  conversation: null,
  messages: [],
  hasOlder: false,
  outgoing: null,
  answer: null,
  answering: false,
  waiting: null,
  stop: null,
  error: null,
  files: null,
  conversationList: null,
};

export function createChat(options: ChatOptions): Chat {
  return new Client(options);
}

class Client implements Chat {
  private readonly base_: string;
  private readonly origin_: string;
  private readonly fetchFn_: Fetch;
  private way_: Way;
  private state_: ChatState = IDLE;
  private readonly listeners_ = new Set<(s: ChatState) => void>();
  private auth_: Auth = { kind_: "cookie" };
  private who_: string | null = null; // the session's user: a token's sub and ext, "anonymous", or "cookie"
  private cookieless_ = false; // learned once: this browser doesn't keep the chat's cookie
  private opening_: Promise<ChatState> | null = null;
  private session_ = new AbortController(); // aborted by reopen, signOut and destroy
  private conv_ = new AbortController(); // aborted with the session, and when the conversation shown is dropped
  private convVersion_ = 0;
  private hideNext_ = false; // openConversation before the session opened: it shows no conversation
  private endNext_ = false; // endConversation before the session opened: it ends its conversation, and hides it
  private ending_: Promise<void> | undefined; // the end the last open sent for endNext_
  private moves_ = 0; // openConversation, send and start calls: an open outrun by one shows nothing
  private unnamed_: Unnamed | null = null; // the send or start out to start a conversation, until the chat names it
  private sending_: object | null = null;
  private stopped_: object | null = null; // the send the user stopped
  private stopAsked_: object | null = null; // the send whose answer the chat was asked to stop
  private streaming_: string | null = null; // the conversation the send's stream answers in, once named
  private wake_: (() => void) | null = null; // ends the send's wait to try again
  private watcher_: AbortController | null = null;
  private older_: { from_: Message; p_: Promise<LoadOlderResult> } | null = null; // loadOlder's request, for those before from_
  private unsure_: Sent | null = null; // a message the chat may have stored: sending it again checks first
  private maxSeen_ = 0; // message ids rise, so a newer message has a larger one
  private limits_: FileLimits | null | undefined; // as the last session said; undefined while unknown
  private contextMax_: number | undefined; // the page context's most bytes, as the last session said
  private readonly context_: ChatOptions["context"];
  private readonly warned_ = new Set<string>();
  private batching_ = false; // a stream's chunk is applied at once: listeners hear it once
  private dirty_ = false;
  private dead_ = false;

  constructor(o: ChatOptions) {
    if (!o || typeof o !== "object") throw new TypeError("createChat needs options");
    for (const k of Object.keys(o)) if (OPTIONS.indexOf(k) < 0) throw new TypeError("unknown option " + k);
    if (typeof o.url !== "string") throw new TypeError("url is required");
    if (o.fetch !== undefined && typeof o.fetch !== "function") throw new TypeError("fetch must be a function");
    if (o.context !== undefined && typeof o.context !== "function") throw new TypeError("context must be a function");
    this.context_ = o.context;
    this.base_ = apiBase(o.url);
    this.origin_ = originOf(this.base_) as string;
    this.way_ = wayOf(o);
    const f = o.fetch;
    this.fetchFn_ = f ? (input, init) => f(input, init) : (input, init) => fetch(input, init);
  }

  getState = (): ChatState => this.state_;

  subscribe = (listener: (state: ChatState) => void): (() => void) => {
    if (typeof listener !== "function") throw new TypeError("subscribe needs a function");
    if (!this.dead_) this.listeners_.add(listener);
    this.call_(listener);
    return () => {
      this.listeners_.delete(listener);
    };
  };

  open = (): Promise<ChatState> => {
    if (this.dead_ || this.state_.status === "ready") return Promise.resolve(this.state_);
    if (!this.opening_) {
      const p = this.doOpen_();
      this.opening_ = p;
      const clear = () => {
        if (this.opening_ === p) this.opening_ = null;
      };
      p.then(clear, clear);
    }
    return this.opening_;
  };

  send = (text: string, options?: SendOptions): Promise<SendResult> => {
    if (typeof text !== "string") throw new TypeError("send needs text");
    const files = checked(options, ["files"]).files;
    if (files !== undefined && !Array.isArray(files)) throw new TypeError("files must be an array");
    return this.doSend_(text, files ? files.map(idOf) : []);
  };

  attach = (file: Blob, options?: AttachOptions): Promise<AttachResult> => {
    if (!(file instanceof Blob)) throw new TypeError("attach needs a Blob");
    const o = checked(options, ["name", "onProgress", "signal"]);
    const on = o.onProgress;
    if (o.name !== undefined && typeof o.name !== "string") throw new TypeError("name must be a string");
    if (on !== undefined && typeof on !== "function") throw new TypeError("onProgress must be a function");
    const size = file.size;
    if (size > FILE_CAP) return Promise.resolve({ ok: false, error: new ChatError("too_large", "The file is too large.") });
    const path = "/files?name=" + encodeURIComponent(wellFormed(o.name ?? (file as File).name ?? "") || "file");
    return this.flow_(o.signal, async (signal): Promise<AttachResult> => {
      // Refused mid-upload, a file may look like network to the browser: what the session said refuses first.
      const l = this.limits_;
      if (l === null) throw new ChatError("attachments_off", "This chat takes no files.");
      if (l && size > l.maxBytes) throw new ChatError("too_large", "The file is too large.");
      const c = { method: "POST", path, body: file, type: file.type || "application/octet-stream" } as const;
      const res = await this.retried_(on ? { ...c, progress: (sent: number) => on(Math.min(sent, size), size) } : c, signal);
      return { ok: true, file: fileOf(await readJSON(res, signal)) };
    });
  };

  readFile = (file: ChatFile | string, options?: ReadFileOptions): Promise<ReadFileResult> => {
    const path = "/files/" + encodeURIComponent(idOf(file));
    return this.flow_(checked(options, ["signal"]).signal, async (signal): Promise<ReadFileResult> => {
      const res = await this.retried_({ method: "GET", path }, signal);
      // As the chat serves it: an image with its type, anything else to save, never to render.
      const t = res.headers.get("Content-Type") || "";
      return { ok: true, blob: new Blob(await chunks(res, signal), { type: IMAGE.test(t) ? t : "application/octet-stream" }) };
    });
  };

  start = (): Promise<SendResult> => this.doStart_();

  stop = (): Promise<StopResult> => {
    if (this.dead_) return Promise.resolve({ ok: true });
    const mine = this.sending_;
    if (mine) {
      this.stopped_ = mine;
      if (this.wake_) this.wake_();
      // Not sent yet, it never is; sent, the chat is asked once its stream names the conversation.
      const id = this.streaming_;
      return id !== null && this.stopAsked_ !== mine ? this.askStop_(id) : Promise.resolve({ ok: true });
    }
    const c = this.state_.conversation;
    return c && this.state_.answering ? this.askStop_(c.id) : Promise.resolve({ ok: true });
  };

  endConversation = (): Promise<void> => {
    if (this.dead_) return Promise.resolve();
    const c = this.state_.conversation;
    const u = c ? null : this.unnamed_;
    const opening = this.opening_;
    if (this.state_.status !== "ready") this.endNext_ = true;
    const named = u && new Promise<void>((resolve) => (u.done_ = resolve)); // before clear_: it detaches u
    this.unnamed_ = null;
    this.clear_();
    if (c) return this.sendEnd_(c.id);
    if (named) return named;
    // Before the session opens, the conversation it opens on is ended then; an opening under way is awaited.
    return opening ? opening.then((st) => (st.status === "ready" ? this.ending_ : undefined)) : Promise.resolve();
  };

  newConversation = (): void => {
    void this.endConversation();
  };

  listConversations = (options?: ListConversationsOptions): Promise<ListConversationsResult> => {
    const o = checked(options, ["before", "signal"]);
    const path = "/conversations" + (o.before === undefined ? "" : "?before=" + encodeURIComponent(idOf(o.before)));
    return this.flow_(o.signal, async (signal): Promise<ListConversationsResult> => {
      if (this.state_.conversationList === false) throw listOff();
      const v = (await readJSON(await this.retried_({ method: "GET", path }, signal), signal)) as Record<string, unknown> | null;
      if (!v || !Array.isArray(v.conversations)) throw bad("list");
      return { ok: true, conversations: v.conversations.map((c) => conversationOf(c, true)), hasMore: v.has_more === true };
    });
  };

  openConversation = (conversation: Conversation | string): Promise<OpenConversationResult> => {
    const id = idOf(conversation);
    if (this.state_.status !== "ready") this.hideNext_ = true;
    const move = ++this.moves_;
    const version = this.convVersion_;
    return this.flow_(this.conv_.signal, async (signal): Promise<OpenConversationResult> => {
      const v = await this.page_(id, signal);
      // A later open, a message or a start, or a new conversation since keeps what's shown.
      if (move !== this.moves_ || version !== this.convVersion_) throw aborted();
      this.dropConversation_();
      this.seen_(v.messages);
      this.set_({ ...this.shown_(v.conversation, v.messages, v.more_), outgoing: null, answer: pending(v.answering, v.actions_), answering: v.answering, waiting: null, stop: null, error: null });
      if (v.answering) this.watch_(v.conversation.id);
      return { ok: true, conversation: v.conversation };
    });
  };

  deleteConversation = (conversation: Conversation | string): Promise<DeleteConversationResult> => {
    const id = idOf(conversation);
    return this.flow_(null, async (signal): Promise<DeleteConversationResult> => {
      if (this.state_.conversationList === false) throw listOff();
      try {
        discard(await this.retried_({ method: "DELETE", path: "/conversations/" + encodeURIComponent(id) }, signal));
      } catch (e) {
        if (!isCode(e, "not_found")) throw e; // already gone
      }
      if (this.current_(id)) this.clear_();
      return { ok: true };
    });
  };

  loadOlder = (): Promise<LoadOlderResult> => {
    const { conversation: c, messages, hasOlder } = this.state_;
    const first = messages[0];
    if (!c || !first || !hasOlder) return Promise.resolve({ ok: true, messages: [] });
    const o = this.older_;
    if (o && o.from_ === first) return o.p_;
    const p = this.flow_(this.conv_.signal, async (signal): Promise<LoadOlderResult> => {
      const v = await this.page_(c.id, signal, first.id);
      const shown = this.state_.messages;
      if (shown[0] !== first) throw aborted(); // another conversation, or the window read again
      const older = v.messages.filter((m) => m.id < first.id);
      this.set_({ messages: older.concat(shown), hasOlder: v.more_ && older.length > 0 });
      return { ok: true, messages: older };
    });
    this.older_ = { from_: first, p_: p };
    p.then(() => {
      if (this.older_ && this.older_.p_ === p) this.older_ = null;
    });
    return p;
  };

  respondToAction = (action: Action | string, response: ActionResponse): Promise<RespondResult> => {
    const id = typeof action === "string" ? action : action && action.id;
    if (typeof id !== "string" || id === "") throw new TypeError("expected an Action, or its id");
    const r = checked(response, ["action", "content"]);
    if (RESPONSES.indexOf(r.action) < 0) throw new TypeError("action must be accept, decline or cancel");
    if (r.content !== undefined && (!r.content || typeof r.content !== "object" || Array.isArray(r.content))) throw new TypeError("content must be an object");
    const body = r.content === undefined ? { action: r.action } : { action: r.action, content: r.content };
    // The answer waiting on it goes on on its own stream; this only hands the response over.
    return this.flow_(null, async (signal): Promise<RespondResult> => {
      const c = this.state_.conversation;
      if (!c) throw new ChatError("not_found", "No such action.");
      discard(await this.retried_({ method: "POST", path: "/conversations/" + encodeURIComponent(c.id) + "/actions/" + encodeURIComponent(id), body }, signal));
      return { ok: true };
    });
  };

  openActionLink = (action: Action, url: string): Promise<RespondResult> | null => {
    if (!action || !Array.isArray(action.links) || !action.links.some((l) => l.url === url)) throw new TypeError("url must be one of the action's links");
    if (!/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false, error: new ChatError("bad_request", "Only an http or https link opens.") });
    // Opened by the user's click alone, in a tab of its own that can't reach back.
    if (typeof window === "object" && window) window.open(url, "_blank", "noopener,noreferrer");
    return action.kind === "url" && !action.done ? this.respondToAction(action, { action: "accept" }) : null;
  };

  reopen = (options?: ReopenOptions): Promise<ChatState> => {
    if (options !== undefined && (!options || typeof options !== "object")) throw new TypeError("reopen takes { token }");
    const o = options || {};
    for (const k of Object.keys(o)) if (k !== "token") throw new TypeError("unknown option " + k);
    if ("token" in o) this.way_ = tokenWay(o.token);
    else if (this.way_.kind_ === "token") throw new TypeError("reopen needs { token }, or { token: null }");
    if (this.dead_) return Promise.resolve(this.state_);
    const idle = this.state_.status === "idle";
    this.forgetUser_();
    return idle ? Promise.resolve(this.state_) : this.open();
  };

  signOut = async (): Promise<void> => {
    if (this.dead_) return;
    const auth = this.auth_;
    if (this.way_.kind_ === "token") this.way_ = { kind_: "token", token: null };
    this.forgetUser_();
    const stop = new AbortController();
    const t = setTimeout(() => stop.abort(), SIGN_OUT_MS);
    try {
      // A session token names the session, or else the cookie does.
      const bearer = auth.kind_ === "session" ? auth.token() : null;
      discard(await request(this.fetchFn_, this.base_, { method: "DELETE", path: "/session", bearer, signal: stop.signal }));
    } catch {
      // The next page that says nobody is signed in ends it.
    } finally {
      clearTimeout(t);
    }
  };

  destroy = (): void => {
    if (this.dead_) return;
    this.dropSession_();
    this.dead_ = true;
    this.listeners_.clear();
  };

  // --- state

  private set_(patch: Partial<ChatState>): void {
    this.state_ = { ...this.state_, ...patch };
    if (this.batching_) this.dirty_ = true;
    else this.emit_();
  }

  private emit_(): void {
    if (this.dead_) return;
    for (const l of Array.from(this.listeners_)) this.call_(l);
  }

  private call_(listener: (s: ChatState) => void): void {
    try {
      listener(this.state_);
    } catch (e) {
      setTimeout(() => {
        throw e;
      });
    }
  }

  private seen_(messages: readonly Message[]): void {
    for (const m of messages) if (m.id > this.maxSeen_) this.maxSeen_ = m.id;
  }

  private current_(id: string): boolean {
    return this.state_.conversation !== null && this.state_.conversation.id === id;
  }

  private dropConversation_(): void {
    this.conv_.abort();
    this.conv_ = new AbortController();
    this.convVersion_++;
    this.sending_ = null;
    this.watcher_ = null;
    this.unsure_ = null;
  }

  // clear drops the conversation shown, with everything under way in it, and shows none.
  private clear_(): void {
    this.dropConversation_();
    this.set_({ conversation: null, messages: [], hasOlder: false, outgoing: null, answer: null, answering: false, waiting: null, stop: null, error: null });
  }

  // land stops u being the page's unnamed request: it's named, refused or lost.
  private land_(u: Unnamed | null | undefined): void {
    if (u && this.unnamed_ === u) this.unnamed_ = null;
  }

  private detached_(u: Unnamed | null | undefined): u is Required<Unnamed> {
    return !!u && !!u.done_ && !u.session_.aborted;
  }

  private dropSession_(): void {
    this.session_.abort();
    this.session_ = new AbortController();
    this.opening_ = null;
    this.dropConversation_();
  }

  private forgetUser_(): void {
    this.dropSession_();
    this.auth_ = { kind_: "cookie" };
    this.who_ = null;
    this.hideNext_ = this.endNext_ = false;
    this.maxSeen_ = 0;
    this.limits_ = this.contextMax_ = undefined;
    this.state_ = IDLE;
    this.emit_();
  }

  // userChanged wipes what the page shows when a reopened session is someone
  // else's, so nobody sees another's conversation or draft, then shows theirs.
  private userChanged_(o: Opened): void {
    if (this.watcher_) this.watcher_.abort();
    this.watcher_ = null;
    this.convVersion_++;
    this.unsure_ = null;
    this.hideNext_ = this.endNext_ = false;
    this.maxSeen_ = 0;
    const s = this.state_;
    this.state_ = { ...IDLE, status: "ready", files: s.files, conversationList: s.conversationList }; // the host's, not the user's
    this.show_(o, this.convVersion_, false);
  }

  // show applies an opened session; hide keeps its conversation off the page, after
  // endConversation or openConversation, while still learning its newest message.
  private show_(o: Opened, version: number, hide: boolean): void {
    this.seen_(o.messages);
    if (version !== this.convVersion_) {
      this.set_({ anonymous: o.anonymous });
      return;
    }
    const c = o.conversation;
    if (hide || !c) {
      this.set_({ anonymous: o.anonymous, conversation: null, messages: [], hasOlder: false, answering: false });
      return;
    }
    this.set_({ anonymous: o.anonymous, ...this.shown_(c, o.messages, o.more_), answering: o.answering, answer: pending(o.answering, o.actions_) });
    if (o.answering) this.watch_(c.id);
  }

  // shown is what a read of c's last messages shows. The conversation shown keeps the
  // older ones it loaded, and hasOlder, when the read reaches back to what it shows.
  private shown_(c: Conversation, fresh: Message[], more: boolean): Partial<ChatState> {
    const old = this.state_.messages;
    const at = this.current_(c.id) && fresh.length ? old.findIndex((m) => m.id === fresh[0].id) : -1;
    const messages = merge(old, fresh);
    return at < 0 ? { conversation: c, messages, hasOlder: more } : { conversation: c, messages: old.slice(0, at).concat(messages) };
  }

  // forget stops showing conversation id when e says it's missing: ended in another tab
  // where the chat lists none, or deleted. It answers e, to throw.
  private forget_(id: string, e: unknown): unknown {
    if (isCode(e, "not_found") && this.current_(id)) this.set_({ conversation: null, messages: [], hasOlder: false, answer: null, answering: false });
    return e;
  }

  // --- opening

  private async doOpen_(): Promise<ChatState> {
    const session = this.session_;
    const version = this.convVersion_;
    const began = Date.now();
    this.set_({ status: "opening", error: null });
    for (let tries = 0; ; tries++) {
      try {
        const o = await this.establish_(session.signal);
        if (session.signal.aborted) return this.state_;
        const end = this.endNext_;
        const hide = end || this.hideNext_;
        this.hideNext_ = this.endNext_ = false;
        this.show_(o, version, hide);
        this.set_({ status: "ready", waiting: null });
        this.ending_ = end && o.conversation ? this.sendEnd_(o.conversation.id) : undefined;
        return this.state_;
      } catch (e) {
        if (session.signal.aborted) return this.state_;
        const err = asChatError(e);
        // A token the site's backend fails to give is its own error to show.
        if (TRANSIENT.indexOf(err.code) < 0 || err.code === "token_failed") {
          this.set_({ status: "error", error: err, waiting: null });
          return this.state_;
        }
        // Never given up: the page need not be reloaded once the chat is back.
        const ms = openWait(err, tries, Date.now() - began);
        this.set_({ waiting: { code: err.code, until: Date.now() + ms } });
        try {
          await sleep(ms, session.signal);
        } catch {
          return this.state_;
        }
      }
    }
  }

  // establish opens or resumes the session for the page's user and settles how
  // requests carry it.
  private async establish_(signal: AbortSignal): Promise<Opened> {
    const token = await userToken(this.way_, this.fetchFn_, signal, false);
    if (typeof token !== "string") return this.openWithout_(token === null, signal);
    try {
      return await this.openAs_(token, signal);
    } catch (e) {
      if (!isCode(e, "token_expired") || !renews(this.way_)) throw e;
    }
    const next = await userToken(this.way_, this.fetchFn_, signal, true);
    if (typeof next !== "string") return this.openWithout_(next === null, signal);
    return this.openAs_(next, signal);
  }

  private async openAs_(token: string, signal: AbortSignal): Promise<Opened> {
    if (!this.mayCarry_(token)) throw notForThisChat(this.origin_);
    const who = whoOf(token);
    if (this.cookieless_) {
      const o = await this.post_({ cookieless: true }, token, signal);
      this.auth_ = { kind_: "token", token: hide(token) };
      this.who_ = who;
      return o;
    }
    const o = await this.post_({}, token, signal);
    if (o.started_ && !(await this.cookieKept_(signal))) {
      this.cookieless_ = true;
      this.auth_ = { kind_: "token", token: hide(token) };
    } else {
      this.auth_ = { kind_: "cookie" };
    }
    this.who_ = who;
    return o;
  }

  // openWithout opens with no customer's token. When the page says nobody is
  // signed in, a signed-in session the browser still holds is ended first.
  private async openWithout_(nobody: boolean, signal: AbortSignal): Promise<Opened> {
    const held = this.auth_;
    if (held.kind_ === "session") {
      try {
        const o = await this.post_({}, held.token(), signal);
        this.who_ = "anonymous";
        return o;
      } catch (e) {
        if (!isCode(e, "session_expired") && !isCode(e, "unauthorized")) throw e;
      }
    }
    this.auth_ = { kind_: "cookie" };
    if (this.cookieless_) return this.openCookieless_(signal);
    if (nobody && (await this.signedIn_(signal))) await this.end_(signal);
    const o = await this.post_({}, null, signal);
    if (nobody && !o.anonymous) {
      throw new ChatError("protocol", "Signed in, though the page says nobody is.");
    }
    if (o.started_ && !(await this.cookieKept_(signal))) {
      this.cookieless_ = true;
      return this.openCookieless_(signal);
    }
    this.who_ = o.anonymous ? "anonymous" : "cookie";
    return o;
  }

  private async openCookieless_(signal: AbortSignal): Promise<Opened> {
    const o = await this.post_({ cookieless: true }, null, signal);
    if (!o.sessionToken_) throw new ChatError("protocol", "The chat gave no session token.");
    this.auth_ = { kind_: "session", token: hide(o.sessionToken_) };
    this.who_ = "anonymous";
    return o;
  }

  private async post_(body: { cookieless?: boolean }, bearer: string | null, signal: AbortSignal): Promise<Opened> {
    const res = await request(this.fetchFn_, this.base_, { method: "POST", path: "/session", body, bearer, signal });
    if (!res.ok) throw await failure(res, signal);
    const o = openedOf(await readJSON(res, signal));
    live(signal);
    // Every session says what the host takes, and whether it lists conversations;
    // an unchanged answer keeps the state's object.
    this.limits_ = o.files;
    this.contextMax_ = o.contextMax_;
    const files = o.files || null;
    if (JSON.stringify(files) !== JSON.stringify(this.state_.files)) this.set_({ files });
    if (o.list_ !== this.state_.conversationList) this.set_({ conversationList: o.list_ });
    return o;
  }

  // cookieKept asks, with the cookie alone, whether the browser kept the session it was just given.
  private async cookieKept_(signal: AbortSignal): Promise<boolean> {
    const res = await request(this.fetchFn_, this.base_, { method: "GET", path: "/session", signal });
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
  private async signedIn_(signal: AbortSignal): Promise<boolean> {
    const res = await request(this.fetchFn_, this.base_, { method: "GET", path: "/session", signal });
    if (res.status === 401 || res.status === 403) {
      discard(res);
      return res.status === 403;
    }
    if (!res.ok) throw await failure(res, signal);
    const v = await readJSON(res, signal);
    return !!v && typeof v === "object" && (v as { anonymous?: unknown }).anonymous === false;
  }

  private async end_(signal: AbortSignal): Promise<void> {
    const res = await request(this.fetchFn_, this.base_, { method: "DELETE", path: "/session", signal });
    if (!res.ok) throw await failure(res, signal);
    discard(res);
  }

  // mayCarry: a token goes only to the chat its aud names, or to the page's own
  // server, which forwards the chat.
  private mayCarry_(token: string): boolean {
    const page = typeof location === "object" && location ? location.origin : null;
    if (page === this.origin_) return true;
    const c = claimsOf(token);
    return !!c && c.aud.some((a) => originOf(a) === this.origin_);
  }

  // --- requests as the session's user

  private bearer_(): string | null {
    return this.auth_.kind_ === "cookie" ? null : this.auth_.token();
  }

  // authed makes a request as the session's user; a lapsed token or session is renewed or
  // reopened once, for target's conversation. u, a request starting one, is unnamed while out.
  private async authed_(c: Omit<Call, "bearer" | "signal">, signal: AbortSignal, target: string | null, u?: Unnamed | null): Promise<Response> {
    for (let retried = false; ; retried = true) {
      if (u) this.unnamed_ = u;
      const res = await request(this.fetchFn_, this.base_, { ...c, bearer: this.bearer_(), signal });
      if (res.status !== 401 || retried || (u && u.done_)) return res;
      this.land_(u);
      const err = await failure(res, signal);
      if (!(await this.recoverAuth_(err, signal, target))) throw err;
    }
  }

  // recoverAuth renews a lapsed token or reopens an ended session. It answers
  // whether to try again, and throws session_expired when the user changed.
  private async recoverAuth_(err: ChatError, signal: AbortSignal, target: string | null): Promise<boolean> {
    if (this.auth_.kind_ === "token" && (err.code === "token_expired" || err.code === "unauthorized")) {
      if (!renews(this.way_)) return false;
      const token = await userToken(this.way_, this.fetchFn_, signal, err.code === "token_expired");
      if (typeof token === "string" && whoOf(token) === this.who_) {
        if (!this.mayCarry_(token)) throw notForThisChat(this.origin_);
        this.auth_ = { kind_: "token", token: hide(token) };
        return true;
      }
    } else if (err.code !== "session_expired" && err.code !== "unauthorized") {
      return false;
    }
    // The same user: try target's conversation again, which the chat checks is theirs.
    const o = await this.reestablish_(signal);
    this.set_({ anonymous: o.anonymous });
    return true;
  }

  // reestablish opens the session again as the page's user, within the flow's
  // signal, so a sign-out meanwhile stops it. Someone else's session wipes the
  // page, and the caller fails with session_expired.
  private async reestablish_(signal: AbortSignal): Promise<Opened> {
    live(signal);
    const who = this.who_;
    const o = await this.establish_(signal);
    live(signal);
    if (this.who_ !== who) {
      this.userChanged_(o);
      throw new ChatError("session_expired", "Someone else is signed in now.", { status: 401 });
    }
    this.seen_(o.messages);
    return o;
  }

  // --- files

  // flow runs a member's request as the session's user, opening it as send
  // does. The page's signal or the session's end cuts it short.
  private async flow_<T>(signal: AbortSignal | null | undefined, run: (signal: AbortSignal) => Promise<T>): Promise<T | { ok: false; error: ChatError }> {
    if (this.dead_) return { ok: false, error: aborted() };
    const ctrl = new AbortController();
    const stop = () => ctrl.abort();
    const session = this.session_.signal;
    session.addEventListener("abort", stop);
    if (signal) signal.addEventListener("abort", stop);
    if (session.aborted || (signal && signal.aborted)) stop();
    try {
      live(ctrl.signal);
      if (this.state_.status !== "ready") {
        const st = await new Promise<ChatState>((resolve, reject) => {
          ctrl.signal.addEventListener("abort", () => reject(aborted()));
          this.open().then(resolve);
        });
        if (st.status !== "ready") throw st.error || unopened();
      }
      return await run(ctrl.signal);
    } catch (e) {
      return { ok: false, error: ctrl.signal.aborted ? aborted() : asChatError(e) };
    } finally {
      session.removeEventListener("abort", stop);
      if (signal) signal.removeEventListener("abort", stop);
    }
  }

  // retried makes a request that nothing is stored by when it's refused: a 401
  // reopens the session once, and 429 and 503 wait as the chat says, up to a minute.
  private async retried_(c: Omit<Call, "bearer" | "signal">, signal: AbortSignal): Promise<Response> {
    const until = Date.now() + WAIT_CAP_MS;
    for (;;) {
      let err: ChatError;
      try {
        const res = await this.authed_(c, signal, null);
        if (res.ok) return res;
        err = await failure(res, signal);
      } catch (e) {
        err = asChatError(e);
      }
      const wait = waitFor(err);
      if (wait === null || Date.now() + wait > until) throw err;
      await sleep(wait, signal);
    }
  }

  // sendEnd ends conversation id, trying again through about a minute while the chat can't be
  // reached or asks to wait. A request under way outlives the page and the session; no retry does.
  private async sendEnd_(id: string): Promise<void> {
    const session = this.session_.signal;
    const until = Date.now() + WAIT_CAP_MS;
    const path = "/conversations/" + encodeURIComponent(id) + "/end";
    for (let tries = 0, renewed = false; ; tries++) {
      let err: ChatError;
      try {
        const res = await request(this.fetchFn_, this.base_, { method: "POST", path, bearer: this.bearer_(), keepalive: true });
        if (res.ok || res.status === 404) return discard(res);
        err = await failure(res);
        if (res.status === 401 && !renewed && !session.aborted) {
          renewed = true;
          if (await this.recoverAuth_(err, session, id)) continue;
        }
      } catch (e) {
        err = asChatError(e);
      }
      const wait = TRANSIENT.indexOf(err.code) < 0 ? null : openWait(err, tries, 0);
      if (wait === null || Date.now() + wait > until) return;
      try {
        await sleep(wait, session);
      } catch {
        return;
      }
    }
  }

  // --- page context

  // contextOf is what a message or a start tells of the page: the browser's time zone
  // under what the context option gives. That part is left out, with a warning, when
  // the option fails or the chat would refuse it, so it never costs the message.
  private async contextOf_(signal: AbortSignal): Promise<object | undefined> {
    let zone: string | undefined;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      // No Intl: the chat goes by UTC.
    }
    const base = zone ? { timezone: zone } : {};
    const fn = this.context_;
    // A chat naming no limit predates the context, ignores it and caps a start at 1 KiB.
    if (fn && this.contextMax_ !== undefined) {
      let page: unknown;
      try {
        page = await within(new Promise((resolve) => resolve(fn())), signal, CONTEXT_MS, () => new Error("timeout"));
      } catch (e) {
        if (signal.aborted) throw aborted();
        this.warn_("the option failed or took 5 s", e);
      }
      if (page != null) {
        const v = vetted(base, page, this.contextMax_);
        if (typeof v !== "string") return v;
        this.warn_(v);
      }
    }
    const v = vetted(base, {}, this.contextMax_);
    return typeof v === "string" ? undefined : v;
  }

  // warn tells the page's developer, once for each reason, that its context was left out.
  private warn_(why: string, ...cause: unknown[]): void {
    if (this.warned_.has(why)) return;
    this.warned_.add(why);
    console.warn("@meandr/chat-sdk: context left out: " + why, ...cause);
  }

  // --- messages

  private async doSend_(raw: string, files: string[]): Promise<SendResult> {
    const text = normalize(raw);
    if (this.dead_) return { ok: false, error: aborted() };
    if (text === "" && !files.length) return { ok: false, error: new ChatError("bad_request", "The message is empty.") };
    if (this.sending_ || this.state_.answering) return { ok: false, error: busy() };
    const mine = {};
    this.sending_ = mine;
    this.streaming_ = null;
    this.moves_++;
    const scope = this.conv_;
    const u = this.unsure_;
    const recheck = u && u.text === text && String(u.files) === String(files) ? u : null;
    this.unsure_ = null;
    let began = -1;
    this.set_({ outgoing: text, error: null, stop: null });
    try {
      if (this.state_.status !== "ready") {
        const st = await this.open();
        if (scope.signal.aborted || this.sending_ !== mine) return { ok: false, error: aborted() };
        if (st.status !== "ready") return this.failed_(mine, scope, st.error || unopened(), -1);
        if (this.state_.answering) return this.failed_(mine, scope, busy(), -1);
      }
      const context = await this.contextOf_(scope.signal);
      began = this.convVersion_;
      this.set_({ answering: true, answer: { text: "", tools: [] } });
      const r = await cut(this.deliver_(text, files, context, scope.signal, recheck), scope.signal);
      return { ok: true, message: r.message, stop: r.stop };
    } catch (e) {
      return this.failed_(mine, scope, asChatError(e), began);
    } finally {
      if (this.sending_ === mine) this.sending_ = null;
    }
  }

  // doStart opens if need be, then has the assistant speak first; the chat
  // supplies the instructions, so the page sends only its context.
  private async doStart_(): Promise<SendResult> {
    if (this.dead_) return { ok: false, error: aborted() };
    if (this.sending_ || this.state_.answering) return { ok: false, error: busy() };
    const mine = {};
    this.sending_ = mine;
    this.streaming_ = null;
    this.moves_++;
    const scope = this.conv_;
    let began = -1;
    this.set_({ error: null, stop: null });
    try {
      if (this.state_.status !== "ready") {
        const st = await this.open();
        if (scope.signal.aborted || this.sending_ !== mine) return { ok: false, error: aborted() };
        if (st.status !== "ready") return this.failed_(mine, scope, st.error || unopened(), -1);
        if (this.state_.answering) return this.failed_(mine, scope, busy(), -1);
      }
      const context = await this.contextOf_(scope.signal);
      began = this.convVersion_;
      this.set_({ answering: true, answer: { text: "", tools: [] } });
      const r = await cut(this.begin_(scope.signal, context), scope.signal);
      return { ok: true, message: r.message, stop: r.stop };
    } catch (e) {
      return this.failed_(mine, scope, asChatError(e), began);
    } finally {
      if (this.sending_ === mine) this.sending_ = null;
    }
  }

  // begin asks for the start and reads its answer. Only refusals before the
  // chat starts are tried again; a start never lands twice. With no
  // conversation shown, after newConversation say, it asks for a new one.
  private async begin_(signal: AbortSignal, context: object | undefined): Promise<Reply> {
    const sent: Sent = { text: "", files: [], target_: null, known_: this.maxSeen_ };
    const fresh = this.state_.conversation === null;
    const call: Omit<Call, "bearer" | "signal"> = { method: "POST", path: "/start", body: fresh ? { new: true, context } : { context }, stream: true };
    const waitUntil = Date.now() + WAIT_CAP_MS;
    const busyUntil = Date.now() + BUSY_CAP_MS;
    for (let busyTries = 0; ; ) {
      if (this.stopping_()) throw halted();
      const stream = new AbortController();
      const u: Unnamed | null = fresh ? { session_: this.session_.signal } : null;
      const stop = () => {
        if (!this.detached_(u)) stream.abort();
      };
      signal.addEventListener("abort", stop);
      try {
        let res: Response;
        try {
          res = await this.authed_(call, stream.signal, null, u);
        } catch (e) {
          this.land_(u);
          if (signal.aborted) throw aborted();
          const reopen = isChatError(e) ? waitFor(e) : null;
          if (reopen !== null && Date.now() + reopen <= waitUntil) {
            await this.pause_((e as ChatError).code, reopen, signal);
            continue;
          }
          throw e;
        }
        if (res.ok) return await this.read_(res, stream, signal, sent, u);
        this.land_(u);
        const err = await failure(res, signal);
        const wait = waitFor(err);
        if (wait !== null && Date.now() + wait <= waitUntil) {
          await this.pause_(err.code, wait, signal);
          continue;
        }
        if (err.code === "busy" && Date.now() < busyUntil) {
          await this.pause_("busy", BUSY_STEPS_MS[Math.min(busyTries++, BUSY_STEPS_MS.length - 1)], signal);
          continue;
        }
        throw err;
      } finally {
        signal.removeEventListener("abort", stop);
        this.land_(u);
        if (u && u.done_) u.done_();
      }
    }
  }

  // failed shows a failure. A message the page doesn't show as stored stays in
  // outgoing, so it can be sent again. began is the conversation version this
  // send set answering in; once the page shows another, answering is not its own.
  private failed_(mine: object, scope: AbortController, err: ChatError, began: number): SendResult {
    if (this.sending_ === mine && !scope.signal.aborted && err.code !== "aborted") {
      // A stop is the user's own doing, never an error to show; one never sent was canceled.
      const shown: Partial<ChatState> = err.code === "stopped" ? { error: null, stop: this.state_.stop || "canceled" } : { error: err };
      if (began < 0) this.set_(shown);
      else if (began === this.convVersion_) this.set_({ answer: null, answering: false, waiting: null, ...shown });
      else this.set_({ answer: null, waiting: null, ...shown });
    }
    return { ok: false, error: err };
  }

  // deliver sends the message and reads its answer. Only refusals that come
  // before the chat stores it are tried again: nothing after a 200 is resent.
  private async deliver_(text: string, files: string[], context: object | undefined, signal: AbortSignal, recheck: Sent | null): Promise<Reply> {
    if (recheck) {
      const id = await this.landedSoon_(recheck, signal, null);
      if (id !== null) return this.follow_(id, recheck, signal);
    }
    const sent: Sent = { text, files, target_: this.state_.conversation ? this.state_.conversation.id : null, known_: this.maxSeen_ };
    const path = sent.target_ === null ? "/conversations" : "/conversations/" + encodeURIComponent(sent.target_) + "/messages";
    const waitUntil = Date.now() + WAIT_CAP_MS;
    const busyUntil = Date.now() + BUSY_CAP_MS;
    for (let busyTries = 0; ; ) {
      if (this.stopping_()) throw halted();
      const stream = new AbortController();
      const u: Unnamed | null = sent.target_ === null ? { session_: this.session_.signal } : null;
      const stop = () => {
        if (!this.detached_(u)) stream.abort();
      };
      signal.addEventListener("abort", stop);
      try {
        let res: Response;
        try {
          res = await this.authed_({ method: "POST", path, body: files.length ? { text, files, context } : { text, context }, stream: true }, stream.signal, sent.target_, u);
        } catch (e) {
          this.land_(u);
          if (signal.aborted) throw aborted();
          if (isCode(e, "network")) return await this.ifLanded_(e as ChatError, sent, signal);
          // Opening the session again was refused before the message was sent: waiting is safe.
          const reopen = isChatError(e) ? waitFor(e) : null;
          if (reopen !== null && Date.now() + reopen <= waitUntil) {
            await this.pause_((e as ChatError).code, reopen, signal);
            continue;
          }
          throw e;
        }
        if (res.ok) return await this.read_(res, stream, signal, sent, u);
        this.land_(u);
        const err = await failure(res, signal);
        if (err.code === "internal") return await this.ifLanded_(err, sent, signal);
        if (sent.target_ !== null) this.forget_(sent.target_, err);
        const wait = waitFor(err);
        if (wait !== null && Date.now() + wait <= waitUntil) {
          await this.pause_(err.code, wait, signal);
          continue;
        }
        if (err.code === "busy" && Date.now() < busyUntil) {
          await this.pause_("busy", BUSY_STEPS_MS[Math.min(busyTries++, BUSY_STEPS_MS.length - 1)], signal);
          continue;
        }
        throw err;
      } finally {
        signal.removeEventListener("abort", stop);
        this.land_(u);
        if (u && u.done_) u.done_();
      }
    }
  }

  // pause waits to try a send again; a stop ends the wait, for the send's loop to end it.
  private async pause_(code: string, ms: number, signal: AbortSignal): Promise<void> {
    live(signal);
    this.set_({ waiting: { code, until: Date.now() + ms } });
    const wake = new AbortController();
    const end = () => wake.abort();
    signal.addEventListener("abort", end, { once: true });
    this.wake_ = end;
    try {
      await sleep(ms, wake.signal);
    } catch (e) {
      if (signal.aborted) throw e;
    } finally {
      signal.removeEventListener("abort", end);
      if (this.wake_ === end) this.wake_ = null;
      if (!signal.aborted) this.set_({ waiting: null });
    }
  }

  private stopping_(): boolean {
    return this.stopped_ !== null && this.stopped_ === this.sending_;
  }

  // named notes the conversation the send's stream answers in, and asks the chat to stop
  // its answer when the user already did.
  private named_(id: string): void {
    if (!this.sending_) return;
    this.streaming_ = id;
    if (this.stopping_() && this.stopAsked_ !== this.sending_) void this.askStop_(id);
  }

  // askStop asks the chat to stop the answer being written in conversation id; the
  // answer's stream, or the conversation followed, then says how it ended.
  private askStop_(id: string): Promise<StopResult> {
    this.stopAsked_ = this.sending_;
    return this.flow_(null, async (signal): Promise<StopResult> => {
      discard(await this.retried_({ method: "POST", path: "/conversations/" + encodeURIComponent(id) + "/stop" }, signal));
      return { ok: true };
    });
  }

  // ifLanded settles a request whose outcome is unknown, a lost connection or a
  // 500: the message may have been stored, so the conversation decides.
  private async ifLanded_(err: ChatError, sent: Sent, signal: AbortSignal): Promise<Reply> {
    const id = await this.landedSoon_(sent, signal, err);
    if (id === null) throw err;
    return this.follow_(id, sent, signal);
  }

  // landedSoon looks for the message, trying again while the chat can't be
  // reached. It answers null only when a lookup said the message isn't there;
  // when none could tell, it throws, and sending the text again checks first.
  private async landedSoon_(sent: Sent, signal: AbortSignal, cause: ChatError | null): Promise<string | null> {
    const version = this.convVersion_;
    let last: ChatError | null = null;
    for (const ms of LOOKUP_STEPS_MS) {
      await sleep(ms, signal);
      try {
        return await this.landed_(sent, signal);
      } catch (e) {
        if (signal.aborted) throw aborted();
        last = asChatError(e);
        if (this.convVersion_ !== version) throw last;
        if (last.code === "not_found") return null;
        if (TRANSIENT.indexOf(last.code) < 0) break;
      }
    }
    this.unsure_ = sent;
    if (last && TRANSIENT.indexOf(last.code) < 0) throw last;
    throw cause || last || new ChatError("network", "The chat couldn't be reached.");
  }

  // landed finds the conversation that holds the message sent, if the chat
  // stored it, and shows it. A new conversation holds nothing older than known.
  private async landed_(sent: Sent, signal: AbortSignal): Promise<string | null> {
    const mine = (m: Message) => isSent(m, sent);
    let found: { conversation: Conversation; messages: Message[]; more_: boolean } | null = null;
    if (sent.target_ !== null) {
      const v = await this.view_(sent.target_, signal);
      if (v.messages.some(mine)) found = v;
    } else {
      const o = await this.latest_(signal);
      if (o.conversation && o.messages.some(mine) && o.messages.every((m) => m.id > sent.known_)) {
        found = { conversation: o.conversation, messages: o.messages, more_: o.more_ };
      }
    }
    live(signal);
    if (!found) return null;
    this.seen_(found.messages);
    this.set_({ ...this.shown_(found.conversation, found.messages, found.more_), outgoing: null });
    return found.conversation.id;
  }

  // latest opens the session as it is, for its latest conversation: a live
  // cookie needs no token, which may have expired meanwhile. A lapsed session is
  // reopened as the page's user, never swapped for an anonymous one.
  private async latest_(signal: AbortSignal): Promise<Opened> {
    if (this.auth_.kind_ === "cookie") {
      const res = await request(this.fetchFn_, this.base_, { method: "GET", path: "/session", signal });
      if (res.ok) {
        discard(res);
        const o = await this.post_({}, null, signal);
        if (!o.started_) return o;
      } else if (res.status === 401) {
        discard(res);
      } else {
        throw await failure(res, signal);
      }
      return this.reestablish_(signal);
    }
    try {
      return await this.post_(this.auth_.kind_ === "token" ? { cookieless: true } : {}, this.bearer_(), signal);
    } catch (e) {
      if (!isCode(e, "token_expired") && !isCode(e, "session_expired") && !isCode(e, "unauthorized")) throw e;
      return this.reestablish_(signal);
    }
  }

  // read applies the stream's events. A stream that ends without done or error
  // lost the answer, which runs on and is stored, so the conversation is followed.
  private async read_(res: Response, stream: AbortController, signal: AbortSignal, sent: Sent, u: Unnamed | null): Promise<Reply> {
    let conversation = sent.target_;
    let message = false;
    if (conversation !== null) this.named_(conversation);
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
          if (signal.aborted && !this.detached_(u)) throw aborted();
          if (done) break;
          clearTimeout(stall);
          stall = setTimeout(() => stream.abort(), STALL_MS);
          this.batching_ = true;
          try {
            for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
              // Ended before the chat named it: end the conversation it names, and read no further.
              if (this.detached_(u)) {
                if (ev.event !== "conversation") continue;
                u.done_(this.sendEnd_(conversationOf(JSON.parse(ev.data)).id));
                throw aborted();
              }
              if (signal.aborted) throw aborted();
              if (ev.event === "message" && message) continue;
              if (ev.event === "message") message = true;
              const out = this.event_(ev.event, ev.data);
              if (!out) continue;
              if (!("conversation" in out)) return out;
              conversation = out.conversation;
              this.land_(u);
              this.named_(conversation);
            }
          } finally {
            this.batching_ = false;
            if (this.dirty_) {
              this.dirty_ = false;
              this.emit_();
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
    return this.follow_(conversation, { ...sent, target_: conversation }, signal);
  }

  // event applies one event: it answers the reply when done, the conversation
  // when one starts, and throws the answer's error.
  private event_(name: string, data: string): Reply | { conversation: string } | null {
    if (EVENTS.indexOf(name) < 0) return null;
    let o: Record<string, unknown>;
    try {
      const v = JSON.parse(data);
      o = v && typeof v === "object" ? v : {};
    } catch {
      throw new ChatError("protocol", "The stream couldn't be read.");
    }
    const stop = typeof o.stop === "string" ? (o.stop as Stop) : null; // done's and error's
    switch (name) {
      case "conversation": {
        const c = conversationOf(o);
        // A start that goes on in the conversation shown keeps its messages.
        this.set_(this.current_(c.id) ? { conversation: c } : { conversation: c, messages: [], hasOlder: false });
        return { conversation: c.id };
      }
      case "message": {
        const m = messageOf(o);
        const c = this.state_.conversation;
        this.seen_([m]);
        this.set_({ messages: withMessage(this.state_.messages, m), outgoing: null });
        if (c && c.endedAt) this.set_({ conversation: { ...c, endedAt: null } }); // the user's message reopens it
        return null;
      }
      case "delta": {
        const a = this.state_.answer || { text: "", tools: [] };
        if (typeof o.text !== "string" || o.text === "" || a.text.length >= ANSWER_CAP) return null;
        this.set_({ answer: { ...a, text: a.text + o.text } });
        return null;
      }
      case "tool": {
        const a = this.state_.answer || { text: "", tools: [] };
        if (typeof o.name !== "string" || typeof o.status !== "string") return null;
        const tools = withTool(a.tools, o.name, o.status, typeof o.title === "string" ? o.title : "");
        if (tools !== a.tools) this.set_({ answer: { ...a, tools } });
        return null;
      }
      case "action": {
        // A tool call waits on it, or its status changed: the latest of each id shows.
        const a = this.state_.answer || { text: "", tools: [] };
        const x = actionOf(o);
        if (x) {
          const list = a.actions || [];
          const i = list.findIndex((y) => y.id === x.id);
          this.set_({ answer: { ...a, actions: i < 0 ? list.concat(x) : list.map((y, j) => (j === i ? x : y)) } });
        }
        return null;
      }
      case "done": {
        // A stop with nothing written has no message to keep.
        if (o.message == null && stop) {
          this.set_({ outgoing: null, answer: null, answering: false, waiting: null, stop });
          throw halted();
        }
        const m = messageOf(o.message);
        this.seen_([m]);
        this.set_({ messages: withMessage(this.state_.messages, m), outgoing: null, answer: null, answering: false, waiting: null, stop });
        return { message: m, stop };
      }
      default: {
        const partial = o.partial ? messageOf(o.partial) : null;
        if (partial) this.seen_([partial]);
        this.set_({ messages: partial ? withMessage(this.state_.messages, partial) : this.state_.messages, outgoing: null, answer: null, answering: false, stop });
        const code = typeof o.error === "string" && o.error !== "" ? o.error : "unavailable";
        throw new ChatError(code, typeof o.message === "string" ? o.message : "The answer failed.", { status: 200, partial });
      }
    }
  }

  // follow waits for an answer whose stream was lost: the conversation, found
  // through the session when its first event never came, is asked for until
  // it's answered. The message is stored, so a failure here leaves it unsure.
  private async follow_(id: string | null, sent: Sent, signal: AbortSignal): Promise<Reply> {
    const start = sent.text === "" && !sent.files.length; // a start: no message of the visitor's to find
    if (id === null && start) throw new ChatError("network", "The answer was lost.");
    const cid = id !== null ? id : await this.landedSoon_(sent, signal, null);
    if (cid === null) {
      this.unsure_ = sent;
      throw new ChatError("no_answer", "The answer was lost.");
    }
    this.named_(cid);
    const version = this.convVersion_;
    let v: View;
    try {
      v = await this.poll_(cid, signal);
    } catch (e) {
      if (!start && !signal.aborted && !isCode(e, "not_found") && version === this.convVersion_) this.unsure_ = { ...sent, target_: cid };
      throw e;
    }
    live(signal);
    if (this.current_(cid)) this.set_({ outgoing: null, answer: null, waiting: null });
    let reply: Message | undefined;
    if (start) {
      reply = v.messages.filter((m) => m.role === "assistant" && m.id > sent.known_).pop();
    } else {
      let i = v.messages.length - 1;
      while (i >= 0 && !isSent(v.messages[i], sent)) i--;
      reply = i >= 0 ? v.messages.slice(i + 1).find((m) => m.role === "assistant") : undefined;
    }
    if (!reply) throw this.stopping_() ? halted() : new ChatError("no_answer", "The assistant didn't answer.");
    return { message: reply, stop: null };
  }

  private async view_(id: string, signal: AbortSignal): Promise<View> {
    const res = await this.authed_({ method: "GET", path: "/conversations/" + encodeURIComponent(id) }, signal, id);
    if (!res.ok) throw this.forget_(id, await failure(res, signal));
    return viewOf(await readJSON(res, signal));
  }

  // page reads a conversation's last 20 messages, or the 20 before message before,
  // waiting as the chat says.
  private async page_(id: string, signal: AbortSignal, before?: number): Promise<View> {
    const path = "/conversations/" + encodeURIComponent(id) + (before ? "?before=" + before : "");
    try {
      return viewOf(await readJSON(await this.retried_({ method: "GET", path }, signal), signal));
    } catch (e) {
      throw this.forget_(id, e);
    }
  }

  // poll asks for the conversation every few seconds until no answer is being
  // written in it, then shows what was stored.
  private async poll_(id: string, signal: AbortSignal): Promise<View> {
    const started = Date.now();
    let failures = 0;
    for (;;) {
      const elapsed = Date.now() - started;
      if (elapsed >= POLL_CAP_MS) throw new ChatError("timeout", "The answer took too long.");
      await sleep(elapsed < 60_000 ? POLL_MS : POLL_SLOW_MS, signal);
      let v: View;
      try {
        v = await this.view_(id, signal);
      } catch (e) {
        if (signal.aborted) throw aborted();
        const err = asChatError(e);
        if (TRANSIENT.indexOf(err.code) >= 0 && ++failures < POLL_FAILURES) continue;
        throw err;
      }
      failures = 0;
      live(signal);
      if (v.answering) {
        // What the answer's tool calls wait on shows while it's written elsewhere, beside what was streamed.
        if (this.current_(id) && v.actions_.length) this.set_({ answer: { text: "", tools: [], ...this.state_.answer, actions: v.actions_ } });
        continue;
      }
      if (this.current_(id)) {
        this.seen_(v.messages);
        this.set_({ ...this.shown_(v.conversation, v.messages, v.more_), answer: null, answering: false });
      }
      return v;
    }
  }

  // watch follows an answer this page didn't start, such as one a previous
  // page left running; a newer watch replaces it.
  private watch_(id: string): void {
    if (this.watcher_) this.watcher_.abort();
    const w = new AbortController();
    this.watcher_ = w;
    const scope = this.conv_.signal;
    const stop = () => w.abort();
    scope.addEventListener("abort", stop, { once: true });
    this.poll_(id, w.signal)
      .then(
        () => {},
        () => {
          if (!w.signal.aborted && this.current_(id)) this.set_({ answer: null, answering: false });
        },
      )
      .then(() => {
        scope.removeEventListener("abort", stop);
        if (this.watcher_ === w) this.watcher_ = null;
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
  return new ChatError("busy", "Still answering.");
}

// halted: stopped with no answer to keep, before the assistant wrote anything, or
// before the chat took the message, which then stays in outgoing.
function halted(): ChatError {
  return new ChatError("stopped", "Stopped.");
}

function listOff(): ChatError {
  return new ChatError("conversation_list_off", "This chat lists no conversations.");
}

function unopened(): ChatError {
  return new ChatError("unauthorized", "The chat couldn't be opened.");
}

// checked: a member's options are an object of the keys it knows; a signal is an AbortSignal.
function checked<T extends object>(o: T | undefined, keys: string[]): T {
  if (o === undefined) return {} as T;
  if (!o || typeof o !== "object") throw new TypeError("options must be an object");
  for (const k of Object.keys(o)) if (keys.indexOf(k) < 0) throw new TypeError("unknown option " + k);
  const s = (o as { signal?: unknown }).signal;
  if (s != null && !(s instanceof AbortSignal)) throw new TypeError("signal must be an AbortSignal");
  return o;
}

function idOf(f: { id: string } | string): string {
  const id = typeof f === "string" ? f : f && f.id;
  if (typeof id !== "string" || id === "") throw new TypeError("expected a ChatFile or Conversation, or its id");
  return id;
}

// vetted is base under page as the chat takes it, undefined when empty, or why it wouldn't:
// no JSON object, a url, title or timezone that isn't a short string, or past max bytes.
function vetted(base: object, page: unknown, max: number | undefined): PageContext | string | undefined {
  let s: string | undefined;
  try {
    if (page && typeof page === "object" && !Array.isArray(page)) s = JSON.stringify({ ...base, ...page });
  } catch {
    // a getter that throws, a cycle, a BigInt
  }
  if (!s || s[0] !== "{") return "no JSON object";
  const o = JSON.parse(s) as PageContext;
  for (const k in KNOWN) {
    const f = o[k];
    if (f != null && (typeof f !== "string" || bytesOf(f) > KNOWN[k])) return k + " must be a string of at most " + KNOWN[k] + " bytes";
  }
  if (max !== undefined && bytesOf(s) > max) return "over the chat's " + max + " bytes";
  return s === "{}" ? undefined : o;
}

function bytesOf(s: string): number {
  return new TextEncoder().encode(s).length;
}

// isSent: m is the visitor's message sent, newer than any the page knew. A file
// goes with one message alone, so one with files is known by its first.
function isSent(m: Message, sent: Sent): boolean {
  if (m.role !== "user" || m.id <= sent.known_) return false;
  return sent.files.length ? !!m.files && m.files.some((f) => f.id === sent.files[0]) : m.text === sent.text;
}

function notForThisChat(origin: string): ChatError {
  return new ChatError("token_failed", "The token's aud isn't " + origin + ".");
}

// live stops a flow its page has moved on from, before it writes anything down.
function live(signal: AbortSignal): void {
  if (signal.aborted) throw aborted();
}

// cut settles as p does, or as aborted once signal aborts, leaving p to run on.
function cut<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(aborted());
    signal.addEventListener("abort", stop, { once: true });
    p.then(resolve, reject).then(() => signal.removeEventListener("abort", stop));
  });
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
  return c ? c.who_ : "token";
}

// wellFormed replaces lone surrogates, as Go's JSON decoding does; a URL can't
// carry them either.
function wellFormed(s: string): string {
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
  return from === 0 ? s : out + s.slice(from);
}

// normalize is the text the chat will store: well formed, and trimmed as Go's
// strings.TrimSpace trims.
function normalize(s: string): string {
  const t = wellFormed(s);
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
    const same = o && o.text === m.text && o.role === m.role && o.createdAt === m.createdAt && String(o.tools) === String(m.tools);
    return same && JSON.stringify([o.files, o.actions]) === JSON.stringify([m.files, m.actions]) ? o : m;
  });
}

function withMessage(list: readonly Message[], m: Message): Message[] {
  return list.some((x) => x.id === m.id) ? list.map((x) => (x.id === m.id ? m : x)) : list.concat(m);
}

// withTool records a tool's progress, titled with its name when the chat gives no title: a waiting or an end updates
// the latest call of that name not ended, keeping its title; at most TOOLS_CAP calls, answering tools itself when full.
function withTool(tools: Answer["tools"], name: string, status: string, title: string): Answer["tools"] {
  if (status !== "started") {
    for (let i = tools.length - 1; i >= 0; i--) {
      const s = tools[i].status;
      if (tools[i].name === name && (s === "started" || s === "waiting")) {
        return tools.slice(0, i).concat({ name, status, title: title || tools[i].title }, tools.slice(i + 1));
      }
    }
  }
  return tools.length >= TOOLS_CAP ? tools : tools.concat({ name, status, title: title || name });
}

function bad(what: string): ChatError {
  return new ChatError("protocol", "Unreadable " + what + " from the chat.");
}

function conversationOf(v: unknown, titled?: boolean): Conversation {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string") throw bad("conversation");
  const ended = o.ended_at;
  const c: Conversation = {
    id: o.id,
    createdAt: String(o.created_at ?? ""),
    updatedAt: String(o.updated_at ?? ""),
    endedAt: typeof ended === "string" && ended ? ended : null,
  };
  if (titled) c.title = String(o.title ?? "");
  return c;
}

function messageOf(v: unknown): Message {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "number" || typeof o.text !== "string" || (o.role !== "user" && o.role !== "assistant")) {
    throw bad("message");
  }
  const m: Message = { id: o.id, role: o.role, text: o.text, createdAt: String(o.created_at ?? "") };
  if (Array.isArray(o.tools)) {
    const tools = o.tools.filter((t): t is string => typeof t === "string");
    const said = (o.tool_titles && typeof o.tool_titles === "object" ? o.tool_titles : {}) as Record<string, unknown>;
    m.tools = tools;
    // Each tool has a title, its name where the chat knows none, as an older chat never does.
    m.toolTitles = Object.fromEntries(
      tools.map((t) => {
        const title = said[t];
        return [t, typeof title === "string" && title ? title : t];
      }),
    );
  }
  if (Array.isArray(o.files)) m.files = o.files.filter((f) => f && typeof f.id === "string").map(fileOf);
  if (Array.isArray(o.actions)) m.actions = actionsOf(o.actions);
  if (o.stop) m.stop = String(o.stop);
  return m;
}

function actionsOf(v: unknown): Action[] {
  return Array.isArray(v) ? v.map(actionOf).filter((a): a is Action => a !== null) : [];
}

// actionOf reads an action a tool call waits on; one without an id or a kind is skipped.
function actionOf(v: unknown): Action | null {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string" || typeof o.kind !== "string") return null;
  const str = (k: string) => (typeof o[k] === "string" ? (o[k] as string) : "");
  const fields = o.fields && typeof o.fields === "object" && !Array.isArray(o.fields) ? (o.fields as Record<string, unknown>) : null;
  const links = Array.isArray(o.links)
    ? o.links.filter((l) => l && typeof l.url === "string").map((l) => ({ url: l.url as string, message: typeof l.message === "string" ? l.message : "" }))
    : [];
  return {
    id: o.id,
    initiator: str("initiator") || "upstream",
    kind: o.kind,
    server: str("server"),
    tool: str("tool"),
    title: str("title") || str("tool"),
    message: str("message"),
    fields,
    links,
    done: o.done === true,
    status: str("status") || "pending",
    expiresAt: str("expires_at") || null,
  };
}

function fileOf(v: unknown): ChatFile {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || typeof o.id !== "string") throw bad("file");
  const size = typeof o.size === "number" ? o.size : 0;
  return { id: o.id, name: String(o.name ?? ""), type: String(o.type ?? ""), size, createdAt: String(o.created_at ?? "") };
}

// messagesOf skips messages of roles v1 may add later.
function messagesOf(v: unknown): Message[] {
  if (!Array.isArray(v)) return [];
  return v.filter((m) => m && typeof m === "object" && (m.role === "user" || m.role === "assistant")).map(messageOf);
}

function openedOf(v: unknown): Opened {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw bad("session");
  return {
    anonymous: o.anonymous === true,
    started_: o.started === true,
    conversation: o.conversation ? conversationOf(o.conversation) : null,
    messages: messagesOf(o.messages),
    more_: o.has_more === true,
    answering: o.answering === true,
    actions_: actionsOf(o.actions),
    sessionToken_: typeof o.session_token === "string" && o.session_token !== "" ? o.session_token : null,
    files: limitsOf(o.files),
    contextMax_: typeof o.context_max_bytes === "number" ? o.context_max_bytes : undefined,
    list_: o.conversation_list === true,
  };
}

// limitsOf reads what the host takes: null for no file; what it can't read, as from a
// chat older than files, is unsaid (undefined), so attach leaves the chat to answer.
function limitsOf(v: unknown): FileLimits | null | undefined {
  const o = v as Record<string, unknown> | null | undefined;
  if (o === null) return null;
  if (!o || typeof o !== "object" || !Array.isArray(o.types) || typeof o.max_bytes !== "number" || typeof o.per_message !== "number") return undefined;
  return { types: o.types.filter((t): t is string => typeof t === "string"), maxBytes: o.max_bytes, perMessage: o.per_message };
}

function viewOf(v: unknown): View {
  const o = v as Record<string, unknown> | null;
  if (!o || typeof o !== "object") throw bad("conversation");
  return {
    conversation: conversationOf(o.conversation),
    messages: messagesOf(o.messages),
    more_: o.has_more === true,
    answering: o.answering === true,
    actions_: actionsOf(o.actions),
  };
}

// pending is the answer a page follows but didn't start, holding what its tool calls wait on.
function pending(answering: boolean, actions: Action[]): { text: string; tools: never[]; actions: Action[] } | null {
  return answering && actions.length ? { text: "", tools: [], actions } : null;
}
