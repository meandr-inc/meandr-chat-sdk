import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatError, createChat, isChatError } from "../src/index";
import { claimsOf } from "../src/token";
import type { AttachResult, Chat, ChatFile, ChatOptions, ChatState, PageContext, ReadFileResult, SendResult } from "../src/types";
import { ALICE, BOB, FakeChat, ORIGIN, TOKEN_URL, TYPES, ev, json, jwt, xhrOf } from "./fake";

function setup(opts: Partial<ChatOptions> = {}, fake = new FakeChat()) {
  const chat = createChat({ url: ORIGIN, fetch: fake.fetch, ...opts } as ChatOptions);
  const states: ChatState[] = [];
  chat.subscribe((s) => states.push(s));
  return { chat, fake, states };
}

function ok(r: SendResult) {
  if (!r.ok) throw r.error;
  return r;
}

function err(r: SendResult | { ok: true } | { ok: false; error: ChatError }) {
  if (r.ok) throw new Error("expected a failure");
  return r.error;
}

const sessionPaths = (fake: FakeChat) => fake.seen.filter((s) => s.path === "/chat/v1/session").map((s) => s.method);

// What every message and start tells by default: the browser's time zone.
const TZ = { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("opening", () => {
  it("sends nothing until the page shows the chat", () => {
    const { fake } = setup({ token: ALICE });
    expect(fake.seen).toHaveLength(0);
  });

  it("opens with the page's token and keeps to the cookie it was given", async () => {
    const { chat, fake } = setup({ token: ALICE });
    const st = await chat.open();
    expect(st.status).toBe("ready");
    expect(st.anonymous).toBe(false);
    const [post, check] = fake.seen;
    expect(post.method + " " + post.path).toBe("POST /chat/v1/session");
    expect(post.auth).toBe("Bearer " + ALICE);
    expect(post.init.credentials).toBe("include");
    expect(check.method + " " + check.path).toBe("GET /chat/v1/session");
    expect(check.auth).toBeNull();
    ok(await chat.send("hi"));
    expect(fake.requests("POST", "/chat/v1/conversations")[0].auth).toBeNull();
  });

  it("resumes the same user's session on the next page without asking about the cookie", async () => {
    const fake = new FakeChat();
    await setup({ token: ALICE }, fake).chat.open();
    const before = fake.cookie;
    fake.seen = [];
    await setup({ token: jwt({ sub: "alice", n: 2 }) }, fake).chat.open();
    expect(fake.cookie).toBe(before);
    expect(fake.seen.map((s) => s.method)).toEqual(["POST"]);
  });

  it("starts a new session for another user, or the same user's other team", async () => {
    const fake = new FakeChat();
    await setup({ token: ALICE }, fake).chat.open();
    const alice = fake.cookie!;
    await setup({ token: jwt({ sub: "alice", ext: { team: 2 } }) }, fake).chat.open();
    expect(fake.cookie).not.toBe(alice);
    expect(fake.sessions.get(alice)!.alive).toBe(false);
  });

  it("sends the token with every request where the browser drops the cookie", async () => {
    const fake = new FakeChat();
    fake.keepsCookie = false;
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    ok(await chat.send("hi"));
    expect(fake.requests("POST", "/chat/v1/conversations")[0].auth).toBe("Bearer " + ALICE);
    fake.seen = [];
    await chat.reopen({ token: jwt({ sub: "alice", n: 2 }) });
    expect(fake.seen.map((s) => s.method + " " + JSON.stringify(s.body))).toEqual(['POST {"cookieless":true}']);
  });

  it("opens an anonymous visitor's session where the page gives no way", async () => {
    const { chat, fake } = setup();
    const st = await chat.open();
    expect(st.anonymous).toBe(true);
    expect(fake.seen[0].auth).toBeNull();
    expect(fake.cookie).not.toBeNull();
  });

  it("gives an anonymous visitor a session token where the browser drops the cookie", async () => {
    const fake = new FakeChat();
    fake.keepsCookie = false;
    const { chat } = setup({}, fake);
    await chat.open();
    expect(fake.seen.map((s) => s.method + " " + JSON.stringify(s.body ?? null))).toEqual([
      "POST {}",
      "GET null",
      'POST {"cookieless":true}',
    ]);
    ok(await chat.send("hi"));
    expect(fake.requests("POST", "/chat/v1/conversations")[0].auth).toMatch(/^Bearer h_/);
  });

  it("ends an earlier user's session on a page that says nobody is signed in, never fetching their conversation", async () => {
    const fake = new FakeChat();
    const alice = fake.live("alice");
    fake.conversation("alice", "", ["secret"]);
    const { chat } = setup({ token: null }, fake);
    const st = await chat.open();
    expect(st.anonymous).toBe(true);
    expect(st.messages).toEqual([]);
    expect(sessionPaths(fake)).toEqual(["GET", "DELETE", "POST", "GET"]);
    expect(fake.requests("DELETE")[0].auth).toBeNull();
    expect(fake.sessions.get(alice)!.alive).toBe(false);
  });

  it("keeps an anonymous visitor's own session on a page that says nobody is signed in", async () => {
    const fake = new FakeChat();
    const anon = fake.live("anon:1");
    const { chat } = setup({ token: null }, fake);
    expect((await chat.open()).anonymous).toBe(true);
    expect(sessionPaths(fake)).toEqual(["GET", "POST"]);
    expect(fake.sessions.get(anon)!.alive).toBe(true);
  });

  it("resumes whoever's session on a page that gives no way", async () => {
    const fake = new FakeChat();
    fake.live("alice");
    const { chat } = setup({}, fake);
    expect((await chat.open()).anonymous).toBe(false);
    expect(fake.requests("DELETE")).toHaveLength(0);
  });

  it("says unauthorized when nobody is signed in and anonymous visitors aren't taken", async () => {
    const fake = new FakeChat();
    fake.anonymousAllowed = false;
    const { chat } = setup({ token: null }, fake);
    const st = await chat.open();
    expect(st.status).toBe("error");
    expect(st.error?.code).toBe("unauthorized");
  });

  it("reads tokenUrl with the site's cookies, uncached", async () => {
    const { chat, fake } = setup({ tokenUrl: TOKEN_URL });
    await chat.open();
    const t = fake.seen[0];
    expect(t.url).toBe(TOKEN_URL);
    expect(t.init.credentials).toBe("include");
    expect(t.init.cache).toBe("no-store");
    expect(t.headers.get("Accept")).toBe("application/json");
    expect(fake.seen[1].auth).toBe("Bearer " + ALICE);
  });

  it.each([[{ status: 401 }], [{ status: 403 }], [{ status: 200, body: { token: null } }]])(
    "takes tokenUrl's %j for nobody signed in",
    async (answer) => {
      const fake = new FakeChat();
      fake.live("alice");
      fake.tokenAnswers.push(answer);
      const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
      expect((await chat.open()).anonymous).toBe(true);
      expect(fake.requests("DELETE")).toHaveLength(1);
    },
  );

  it.each([
    [{ status: 500 }],
    [{ status: 200, body: { nope: 1 } }],
    [{ status: 200, body: { token: "" } }],
    [{ status: 200, body: "<html>" }],
    [new TypeError("offline")],
  ])("never takes tokenUrl's failure %j for a sign-out", async (answer) => {
    const fake = new FakeChat();
    fake.live("alice");
    fake.tokenAnswers.push(answer);
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    const st = await chat.open();
    expect(st.status).toBe("error");
    expect(st.error?.code).toBe("token_failed");
    expect(fake.seen.filter((s) => s.url.startsWith(ORIGIN))).toHaveLength(0);
  });

  it("takes a getToken that throws, or returns nothing, for an error", async () => {
    for (const getToken of [() => Promise.reject(new Error("x")), () => undefined as unknown as string]) {
      const { chat, fake } = setup({ getToken });
      const st = await chat.open();
      expect(st.error?.code).toBe("token_failed");
      expect(fake.seen).toHaveLength(0);
    }
  });

  it("refuses to send a token to a chat its aud doesn't name", async () => {
    const { chat, fake } = setup({ token: jwt({ sub: "alice", aud: "https://evil.example" }) });
    const st = await chat.open();
    expect(st.error?.code).toBe("token_failed");
    expect(fake.seen).toHaveLength(0);
    const plain = setup({ token: "not-a-jwt" });
    expect((await plain.chat.open()).error?.code).toBe("token_failed");
    expect(plain.fake.seen).toHaveLength(0);
  });

  it("renews an expired token through tokenUrl, telling getToken it expired", async () => {
    const fake = new FakeChat();
    fake.tokenAnswers.push({ status: 200, body: { token: jwt({ sub: "alice", exp: 1 }) } }, { status: 200, body: { token: ALICE } });
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    expect((await chat.open()).status).toBe("ready");
    expect(fake.tokenCalls).toBe(2);

    const asked: boolean[] = [];
    const tokens = [jwt({ sub: "alice", exp: 1 }), ALICE];
    const g = setup({ getToken: ({ expired }) => (asked.push(expired), tokens.shift()!) });
    expect((await g.chat.open()).status).toBe("ready");
    expect(asked).toEqual([false, true]);
  });

  it("asks for a reload when the page's own token expired", async () => {
    const { chat, fake } = setup({ token: jwt({ sub: "alice", exp: 1 }) });
    const st = await chat.open();
    expect(st.error?.code).toBe("token_expired");
    expect(fake.requests("POST")).toHaveLength(1);
  });

  it("opens once however often it's asked", async () => {
    const { chat, fake } = setup({ token: ALICE });
    await Promise.all([chat.open(), chat.open(), chat.open()]);
    await chat.open();
    expect(fake.requests("POST")).toHaveLength(1);
  });

  it("keeps trying when the chat can't be reached, as while it restarts: briskly, then every 15 to 30 s", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const fake = new FakeChat();
    let down = true;
    let tries = 0;
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: (u, i) => (down ? (tries++, Promise.reject(new TypeError("offline"))) : fake.fetch(u, i)),
    });
    const p = chat.open();
    await vi.advanceTimersByTimeAsync(500);
    expect(chat.getState()).toMatchObject({ status: "opening", waiting: { code: "network" } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(tries).toBe(8); // at 0, 1, 3, 7, 15, 30, 45 and 60 s
    await vi.advanceTimersByTimeAsync(300_000);
    expect(tries).toBe(21); // then every 22.5 s here, never giving up
    expect(chat.getState().status).toBe("opening");
    down = false;
    await vi.advanceTimersByTimeAsync(23_000);
    expect((await p).status).toBe("ready");
  });

  it("waits while the chat's workspace isn't connected yet, as long as it says, until it is", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.refusals.push({ method: "POST", path: /\/session$/, status: 503, error: "not_connected", retryAfter: 5, times: 2 });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.open();
    await vi.advanceTimersByTimeAsync(100);
    expect(chat.getState().waiting?.code).toBe("not_connected");
    await vi.advanceTimersByTimeAsync(11_000);
    expect((await p).status).toBe("ready");
    expect(chat.getState().waiting).toBeNull();

    const later = new FakeChat();
    later.refusals.push({ method: "POST", path: /\/session$/, status: 503, error: "not_connected", retryAfter: 30, times: 5 });
    const q = setup({ token: ALICE }, later).chat.open();
    await vi.advanceTimersByTimeAsync(70_000);
    expect(later.requests("POST")).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(90_000);
    expect((await q).status).toBe("ready"); // refused at 0, 30, 60, 90 and 120 s
  });

  it("shows the latest conversation, and watches an answer a previous page left running", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", ["q1", "a1", "q2"]);
    c.answering = 1;
    c.pending = "a2";
    const { chat } = setup({ token: ALICE }, fake);
    const st = await chat.open();
    expect(st.conversation?.id).toBe(c.id);
    expect(st.conversation?.createdAt).toBe("2026-11-15T00:00:00Z");
    expect(st.messages.map((m) => m.text)).toEqual(["q1", "a1", "q2"]);
    expect(st.answering).toBe(true);
    expect(err(await chat.send("more")).code).toBe("busy");
    await vi.advanceTimersByTimeAsync(7000);
    expect(chat.getState().answering).toBe(false);
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q1", "a1", "q2", "a2"]);
  });
});

describe("messages", () => {
  it("waits when opening the session again is refused for a while, then sends", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    fake.refusals.push(
      { method: "POST", path: /\/conversations$/, status: 401, error: "session_expired", times: 1 },
      { method: "POST", path: /\/session$/, status: 503, error: "overloaded", retryAfter: 2, times: 1 },
    );
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(100);
    expect(chat.getState().waiting?.code).toBe("overloaded");
    await vi.advanceTimersByTimeAsync(3000);
    expect(ok(await p).message.text).toBe("Hello");
    expect(fake.requests("POST").filter((s) => s.path.endsWith("/conversations"))).toHaveLength(2);
  });

  it("streams the answer into the state", async () => {
    const fake = new FakeChat();
    fake.turns.push({ tools: [{ name: "orders", status: "started" }, { name: "orders", status: "done" }], deltas: ["Your ", "order"], stop: "max_tokens" });
    const { chat, states } = setup({ token: ALICE }, fake);
    const reply = ok(await chat.send("  Where is it?  "));
    expect(reply.message.text).toBe("Your order");
    expect(reply.stop).toBe("max_tokens");
    expect(states.some((s) => s.outgoing === "Where is it?")).toBe(true);
    expect(states.some((s) => s.answer?.text === "Your ")).toBe(true);
    expect(states.some((s) => s.answer?.tools.length === 1 && s.answer.tools[0].status === "done")).toBe(true);
    const end = chat.getState();
    expect(end.messages.map((m) => m.role + ":" + m.text)).toEqual(["user:Where is it?", "assistant:Your order"]);
    expect(end.messages[1].tools).toEqual(["orders"]);
    expect(end.outgoing).toBeNull();
    expect(end.answer).toBeNull();
    expect(end.answering).toBe(false);
    expect(end.stop).toBe("max_tokens");
    expect(end.conversation).not.toBeNull();
    expect(fake.requests("POST", "/chat/v1/conversations")[0].body).toEqual({ text: "Where is it?", context: TZ });
  });

  it("shows tools by their titles, or by their names where the chat gives none", async () => {
    const fake = new FakeChat();
    fake.turns.push({ tools: [{ name: "rag_search", status: "started", title: "Search the knowledge base" }, { name: "rag_search", status: "done" }, { name: "bare", status: "started" }] });
    const { chat, states } = setup({ token: ALICE }, fake);
    ok(await chat.send("find it"));
    const during = states.filter((s) => s.answer && s.answer.tools.length === 2).pop();
    const tools = during?.answer?.tools.map((t) => [t.name, t.status, t.title]);
    expect(tools).toEqual([["rag_search", "done", "Search the knowledge base"], ["bare", "started", "bare"]]);
    expect(chat.getState().messages[1].toolTitles).toEqual({ rag_search: "Search the knowledge base", bare: "bare" });
  });

  it("keeps the objects of messages that didn't change", async () => {
    const fake = new FakeChat();
    fake.turns.push({}, { deltas: ["a", "b", "c"] });
    const { chat, states } = setup({ token: ALICE }, fake);
    ok(await chat.send("one"));
    const first = chat.getState().messages[0];
    const from = states.length;
    ok(await chat.send("two"));
    expect(chat.getState().messages[0]).toBe(first);
    const deltas = states.slice(from).filter((s) => s.answer && s.answer.text !== "");
    expect(deltas).toHaveLength(3);
    expect(deltas.every((s) => s.messages === deltas[0].messages)).toBe(true);
  });

  it("sends the next message to the conversation", async () => {
    const { chat, fake } = setup({ token: ALICE });
    ok(await chat.send("one"));
    const id = chat.getState().conversation!.id;
    ok(await chat.send("two"));
    expect(fake.requests("POST", "/chat/v1/conversations/" + id + "/messages")).toHaveLength(1);
    expect(chat.getState().messages).toHaveLength(4);
  });

  it("refuses an empty message, or one while answering, without a request", async () => {
    vi.useFakeTimers();
    const { chat, fake } = setup({ token: ALICE });
    expect(err(await chat.send("   ")).code).toBe("bad_request");
    expect(() => chat.send(42 as unknown as string)).toThrow(TypeError);
    fake.turns.push({ stall: true });
    const first = chat.send("one");
    await vi.advanceTimersByTimeAsync(10);
    const n = fake.seen.length;
    expect(err(await chat.send("two")).code).toBe("busy");
    expect(fake.seen).toHaveLength(n);
    chat.destroy();
    expect(err(await first).code).toBe("aborted");
  });

  it("surfaces the answer's error with what was stored, and says the model was busy", async () => {
    const fake = new FakeChat();
    fake.turns.push({ deltas: ["Part"], error: { error: "timeout", partial: true } }, { error: { error: "model_busy" } });
    const { chat } = setup({ token: ALICE }, fake);
    const e = err(await chat.send("q"));
    expect(e).toBeInstanceOf(ChatError);
    expect(e.code).toBe("timeout");
    expect(e.retryable).toBe(true);
    expect(e.partial?.text).toBe("Part");
    expect(chat.getState().error?.code).toBe("timeout");
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q", "Part"]);
    expect(chat.getState().answering).toBe(false);
    expect(chat.getState().outgoing).toBeNull();
    expect(err(await chat.send("again")).code).toBe("model_busy");
    expect(fake.requests("POST").filter((s) => s.path.endsWith("/messages"))).toHaveLength(1);
  });

  it("ignores events and fields it doesn't know", async () => {
    const fake = new FakeChat();
    fake.turns.push({ extra: ev("reasoning", { x: 1 }) + "event: later\ndata: not json at all\n\n" });
    const { chat } = setup({ token: ALICE }, fake);
    expect(ok(await chat.send("q")).message.text).toBe("Hello");
  });

  it("follows an answer whose stream broke until it's stored", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.turns.push({ deltas: ["Hel"], text: "Hello there", drop: "after-deltas", pollsAnswering: 2 });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(10);
    expect(chat.getState().answering).toBe(true);
    expect(chat.getState().answer?.text).toBe("Hel");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ok(await p)).toMatchObject({ message: { text: "Hello there" }, stop: null });
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q", "Hello there"]);
    expect(chat.getState().answering).toBe(false);
    expect(fake.requests("GET").filter((s) => s.path.startsWith("/chat/v1/conversations/"))).toHaveLength(3);
  });

  it("finds a new conversation whose first event was lost through the session", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.turns.push({ drop: "before-conversation", text: "Found", pollsAnswering: 0 });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(4000);
    expect(ok(await p).message.text).toBe("Found");
    expect(chat.getState().conversation).not.toBeNull();
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q", "Found"]);
  });

  it("gives up on a silent stream after 45 s and follows the conversation", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.turns.push({ stall: true, text: "Late", pollsAnswering: 0 });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(44_000);
    expect(chat.getState().answering).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(ok(await p).message.text).toBe("Late");
  });

  it("finds a message whose answer was lost with the connection, instead of offering to send it twice", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    let lose = 1;
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        const res = await fake.fetch(u, i);
        if (String(u).endsWith("/conversations") && i?.method === "POST" && lose-- > 0) {
          void res.body?.cancel();
          throw new TypeError("connection lost");
        }
        return res;
      },
    });
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(5000);
    expect(ok(await p).message.text).toBe("Hello");
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
  });

  it("keeps a message the chat never stored, with the error, so it can be sent again", async () => {
    const fake = new FakeChat();
    fake.refusals.push({ method: "POST", path: /conversations/, status: 413, error: "too_large", times: 1 });
    const { chat } = setup({ token: ALICE }, fake);
    expect(err(await chat.send("long")).code).toBe("too_large");
    expect(chat.getState().outgoing).toBe("long");
    expect(chat.getState().error?.code).toBe("too_large");
    ok(await chat.send(chat.getState().outgoing!));
    expect(chat.getState().outgoing).toBeNull();
    expect(chat.getState().error).toBeNull();
  });

  it("waits as long as the chat says when the visitor writes too fast", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.refusals.push({ method: "POST", path: /conversations/, status: 429, error: "rate_limited", retryAfter: 2, times: 1 });
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(1500);
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
    expect(chat.getState().waiting).toMatchObject({ code: "rate_limited" });
    await vi.advanceTimersByTimeAsync(1000);
    ok(await p);
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(2);
    expect(chat.getState().waiting).toBeNull();
  });

  it("stops waiting past a minute and says when to try again", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.refusals.push({ method: "POST", path: /conversations/, status: 503, error: "overloaded", retryAfter: 30 });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(70_000);
    const e = err(await p);
    expect(e.code).toBe("overloaded");
    expect(e.retryAfter).toBe(30);
    expect(chat.getState().outgoing).toBe("q");
    expect(chat.getState().waiting).toBeNull();
  });

  it("waits for the user's previous answer elsewhere", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.busyUntil = Date.now() + 5000;
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(3000);
    expect(chat.getState().waiting).toMatchObject({ code: "busy" });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ok(await p).message.text).toBe("Hello");
    expect(fake.requests("POST", "/chat/v1/conversations").length).toBeGreaterThan(1);
  });

  it("opens the session again when it ended, and sends the message once more", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    ok(await chat.send("one"));
    for (const s of fake.sessions.values()) s.alive = false;
    expect(ok(await chat.send("two")).message.text).toBe("Hello");
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["one", "Hello", "two", "Hello"]);
    expect(fake.tokenCalls).toBe(2);
  });

  it("wipes the page, and resends nothing, when the reopened session is someone else's", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    ok(await chat.send("alice's question"));
    for (const s of fake.sessions.values()) s.alive = false;
    fake.tokenAnswers.push({ status: 200, body: { token: BOB } });
    const e = err(await chat.send("alice's draft"));
    expect(e.code).toBe("session_expired");
    const st = chat.getState();
    expect(st.messages).toEqual([]);
    expect(st.outgoing).toBeNull();
    expect(st.status).toBe("ready");
    const posts = fake.requests("POST").map((s) => s.path);
    expect(posts.slice(posts.lastIndexOf("/chat/v1/session"))).toEqual(["/chat/v1/session"]);
    expect(fake.requests("POST", "/chat/v1/session").pop()!.auth).toBe("Bearer " + BOB);
  });

  it("renews an expired token where the browser drops the cookie", async () => {
    const fake = new FakeChat();
    fake.keepsCookie = false;
    let n = 0;
    const tokens: string[] = [];
    const { chat } = setup({ getToken: () => (tokens.push(jwt({ sub: "alice", n: ++n })), tokens[tokens.length - 1]) }, fake);
    ok(await chat.send("one"));
    fake.expired.add(tokens[0]);
    ok(await chat.send("two"));
    const sent = fake.requests("POST").filter((s) => s.path.endsWith("/messages"));
    expect(sent.map((s) => s.auth)).toEqual(["Bearer " + tokens[0], "Bearer " + tokens[1]]);
  });

  it("wipes the page when a renewed token names someone else", async () => {
    const fake = new FakeChat();
    fake.keepsCookie = false;
    const tokens = [ALICE, BOB, BOB];
    const { chat } = setup({ getToken: () => tokens.shift()! }, fake);
    ok(await chat.send("one"));
    fake.expired.add(ALICE);
    expect(err(await chat.send("two")).code).toBe("session_expired");
    expect(chat.getState()).toMatchObject({ status: "ready", messages: [], outgoing: null, conversation: null, error: { code: "session_expired" } });
    ok(await chat.send("bob's"));
    expect(fake.requests("POST", "/chat/v1/conversations").pop()!.auth).toBe("Bearer " + BOB);
  });

  it("forgets a conversation that's gone", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    ok(await chat.send("one"));
    fake.convs.clear();
    expect(err(await chat.send("two")).code).toBe("not_found");
    expect(chat.getState().conversation).toBeNull();
    ok(await chat.send("three"));
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["three", "Hello"]);
  });

  it("ends the conversation shown on newConversation, and starts a new one with the next message", async () => {
    const { chat, fake } = setup({ token: ALICE });
    ok(await chat.send("one"));
    const first = chat.getState().conversation!.id;
    chat.newConversation();
    expect(chat.getState().conversation).toBeNull();
    expect(chat.getState().messages).toEqual([]);
    expect(fake.requests("POST", "/chat/v1/conversations/" + first + "/end")[0].init.keepalive).toBe(true);
    ok(await chat.send("two"));
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(2);
    expect(fake.convs.get(first)!.ended).not.toBeNull();
  });

  it("opens with no conversation after newConversation before opening, ending the one it would show", async () => {
    const fake = new FakeChat();
    const old = fake.conversation("alice", "", ["old"]);
    const { chat } = setup({ token: ALICE }, fake);
    chat.newConversation();
    const st = await chat.open();
    expect(st.conversation).toBeNull();
    expect(st.messages).toEqual([]);
    expect(old.ended).not.toBeNull();
    ok(await chat.send("new"));
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
  });

  it("follows a reply when the text needs Go's trimming", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    let lose = 1;
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        const res = await fake.fetch(u, i);
        if (String(u).endsWith("/conversations") && i?.method === "POST" && lose-- > 0) {
          void res.body?.cancel();
          throw new TypeError("connection lost");
        }
        return res;
      },
    });
    const text = " " + String.fromCharCode(0x85) + "héllo" + String.fromCharCode(0xd800) + "  ";
    const p = chat.send(text);
    await vi.advanceTimersByTimeAsync(5000);
    expect(ok(await p).message.text).toBe("Hello");
    expect(chat.getState().messages[0].text).toBe("héllo" + String.fromCharCode(0xfffd));
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
  });
});

describe("nothing twice", () => {
  function lossy(fake: FakeChat, lose: number) {
    return async (u: RequestInfo | URL, i?: RequestInit) => {
      const res = await fake.fetch(u, i);
      if (/\/conversations(\/[^/]+\/messages)?$/.test(String(u)) && i?.method === "POST" && lose-- > 0) {
        void res.body?.cancel();
        throw new TypeError("connection lost");
      }
      return res;
    };
  }

  it("looks again while the chat can't be reached, and finds the message", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    let lose = 0;
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        const res = await fake.fetch(u, i);
        if (String(u).endsWith("/messages") && lose-- > 0) {
          void res.body?.cancel();
          throw new TypeError("connection lost");
        }
        return res;
      },
    });
    ok(await chat.send("one"));
    lose = 1;
    fake.failViews = 2;
    const p = chat.send("two");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(ok(await p).message.text).toBe("Hello");
    const conv = chat.getState().conversation!.id;
    expect(fake.requests("POST", "/chat/v1/conversations/" + conv + "/messages")).toHaveLength(1);
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["one", "Hello", "two", "Hello"]);
  });

  it("keeps a message it couldn't confirm, and sending it again checks before storing it twice", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    ok(await chat.send("one"));
    const conv = chat.getState().conversation!.id;
    let down = true;
    const flaky = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        if (down && i?.method === "GET" && String(u).includes("/conversations/")) throw new TypeError("offline");
        const res = await fake.fetch(u, i);
        if (down && String(u).endsWith("/messages")) {
          void res.body?.cancel();
          throw new TypeError("connection lost");
        }
        return res;
      },
    });
    await flaky.open();
    const p = flaky.send("two");
    await vi.advanceTimersByTimeAsync(60_000);
    const e = err(await p);
    expect(e.code).toBe("network");
    expect(flaky.getState()).toMatchObject({ outgoing: "two", answering: false });
    down = false;
    const q = flaky.send("two");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ok(await q).message.text).toBe("Hello");
    expect(fake.requests("POST", "/chat/v1/conversations/" + conv + "/messages")).toHaveLength(1);
    expect(flaky.getState().outgoing).toBeNull();
  });

  it("finds a message a 500 stored", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.internalAfterStore = 1;
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ok(await p).message.text).toBe("Stored anyway");
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
    expect(chat.getState()).toMatchObject({ outgoing: null, answering: false, error: null });
  });

  it("says a 500 failed when the message isn't in the conversation", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.refusals.push({ method: "POST", path: /conversations/, status: 500, error: "internal", times: 1 });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(err(await p).code).toBe("internal");
    expect(chat.getState().outgoing).toBe("q");
  });

  it("lets no lookup cut short by a user change write the previous user's conversation", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    let lose = 0;
    let stall = false;
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        if (stall && i?.method === "GET" && String(u).includes("/conversations/")) {
          const real = new Uint8Array(await (await fake.fetch(u, i)).arrayBuffer());
          let sent = false;
          let cancelled = false;
          const body = new ReadableStream<Uint8Array>({
            pull: (c) =>
              new Promise<void>((resolve) =>
                setTimeout(() => {
                  if (!cancelled) {
                    if (sent) c.close();
                    else c.enqueue(real);
                  }
                  sent = true;
                  resolve();
                }, 2000),
              ),
            cancel: () => {
              cancelled = true;
            },
          });
          return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
        }
        const res = await fake.fetch(u, i);
        if (String(u).endsWith("/messages") && lose-- > 0) {
          void res.body?.cancel();
          throw new TypeError("connection lost");
        }
        return res;
      },
    });
    ok(await chat.send("alice's secret"));
    lose = 1;
    stall = true;
    const p = chat.send("two");
    await vi.advanceTimersByTimeAsync(1500);
    const st = await chat.reopen({ token: BOB });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(err(await p).code).toBe("aborted");
    expect(st.status).toBe("ready");
    expect(chat.getState().messages).toEqual([]);
    expect(JSON.stringify(chat.getState())).not.toContain("alice's secret");
  });

  it("checks an unsure first message as the page's user, never as an anonymous visitor", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    let down = false;
    let lose = 1;
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        if (down && (String(u).endsWith("/session") || String(u).includes("/conversations/"))) throw new TypeError("offline");
        const res = await fake.fetch(u, i);
        if (String(u).endsWith("/conversations") && i?.method === "POST" && lose-- > 0) {
          void res.body?.cancel();
          down = true;
          throw new TypeError("connection lost");
        }
        return res;
      },
    });
    await chat.open();
    const p = chat.send("hi");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(err(await p).code).toBe("network");
    expect(chat.getState().outgoing).toBe("hi");
    for (const s of fake.sessions.values()) s.alive = false;
    down = false;
    const q = chat.send("hi");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ok(await q).message.text).toBe("Hello");
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
    expect(Array.from(fake.sessions.values()).some((s) => s.anonymous)).toBe(false);
    expect(chat.getState().anonymous).toBe(false);
  });

  it("doesn't take an older conversation's message for one just sent", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.conversation("alice", "", ["hi", "old answer"]);
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: (u, i) => (String(u).endsWith("/conversations") && i?.method === "POST" ? Promise.reject(new TypeError("offline")) : fake.fetch(u, i)),
    });
    chat.newConversation();
    const p = chat.send("hi");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(err(await p).code).toBe("network");
    expect(chat.getState().messages).toEqual([]);
  });
});

describe("answering", () => {
  it("keeps a draft refused as busy when a send opens onto a running answer", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", ["q1"]);
    c.answering = 1;
    c.pending = "a1";
    const { chat } = setup({ token: ALICE }, fake);
    expect(err(await chat.send("draft")).code).toBe("busy");
    expect(chat.getState()).toMatchObject({ answering: true, outgoing: "draft" });
    await vi.advanceTimersByTimeAsync(7000);
    expect(chat.getState()).toMatchObject({ answering: false, outgoing: "draft" });
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q1", "a1"]);
    ok(await chat.send("draft"));
  });

  it("stops answering when a watched conversation is gone", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", ["q1"]);
    c.answering = 5;
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    fake.convs.clear();
    await vi.advanceTimersByTimeAsync(4000);
    expect(chat.getState()).toMatchObject({ answering: false, conversation: null });
    ok(await chat.send("q2"));
  });

  it("ends the cut-short message on newConversation while waiting on a busy answer", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.busyUntil = Date.now() + 60_000;
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(3000);
    expect(chat.getState().waiting).toMatchObject({ code: "busy" });
    chat.newConversation();
    expect(err(await p).code).toBe("aborted");
    expect(chat.getState()).toMatchObject({ waiting: null, answering: false, outgoing: null });
  });

  it("ends a followed answer on signOut", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.turns.push({ drop: "after-deltas", pollsAnswering: 50 });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(5000);
    await chat.signOut();
    expect(err(await p).code).toBe("aborted");
    expect(chat.getState()).toMatchObject({ status: "idle", answering: false, messages: [] });
    const n = fake.seen.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fake.seen).toHaveLength(n);
  });

  it("settles an open cut short by reopen, and opens for the new user alone", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    const first = chat.open();
    const second = chat.reopen({ token: BOB });
    await first;
    const st = await second;
    expect(st.status).toBe("ready");
    expect(fake.requests("POST", "/chat/v1/session").map((s) => s.auth)).toEqual(["Bearer " + BOB]);

    const gone = setup({ token: ALICE });
    void gone.chat.open();
    gone.chat.destroy();
    await new Promise((r) => setTimeout(r, 10));
    expect(gone.fake.seen).toHaveLength(0);
  });

  it("reads text split mid-character across chunks", async () => {
    const fake = new FakeChat();
    const enc = new TextEncoder();
    const sse =
      ev("conversation", { id: "c9", created_at: "", updated_at: "" }) +
      ev("message", { id: 1, role: "user", text: "q", created_at: "" }) +
      ev("delta", { text: "€uro" }) +
      ev("done", { message: { id: 2, role: "assistant", text: "€uro", created_at: "" }, stop: "end" });
    const bytes = enc.encode(sse);
    const cut = bytes.indexOf(0xe2) + 1;
    const done = sse.indexOf("event: done") + 2;
    const chat = createChat({
      url: ORIGIN,
      fetch: async (u, i) => {
        if (!String(u).endsWith("/conversations")) return fake.fetch(u, i);
        const parts = [bytes.slice(0, cut), bytes.slice(cut, done), bytes.slice(done)];
        const body = new ReadableStream<Uint8Array>({ pull: (c) => (parts.length ? c.enqueue(parts.shift()!) : c.close()) });
        return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      },
    });
    const { states } = { states: [] as ChatState[] };
    chat.subscribe((s) => states.push(s));
    expect(ok(await chat.send("q")).message.text).toBe("€uro");
    expect(states.some((s) => s.answer?.text === "€uro")).toBe(true);
  });

  it("follows the conversation when an event is too large to read", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const big = "x".repeat(4_300_000);
    fake.turns.push({ deltas: [big] });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(4000);
    expect(ok(await p).message.text).toHaveLength(big.length);
  });
});

describe("guards", () => {
  it("requires the new token on reopen when the client was given one, and refuses typos", () => {
    const { chat } = setup({ token: ALICE });
    expect(() => chat.reopen()).toThrow(TypeError);
    expect(() => chat.reopen({})).toThrow(TypeError);
    expect(() => chat.reopen({ tokne: null } as never)).toThrow(/unknown option tokne/);
    expect(() => chat.reopen({ token: null })).not.toThrow();
    const byUrl = setup({ tokenUrl: TOKEN_URL });
    expect(() => byUrl.chat.reopen()).not.toThrow();
  });

  it("lets no sign-out be undone by a session reopening for a 401 already in flight", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    let slow = false;
    const chat = createChat({
      url: ORIGIN,
      tokenUrl: TOKEN_URL,
      fetch: async (u, i) => {
        const res = await fake.fetch(u, i);
        if (slow && res.status === 401) {
          const text = await res.text();
          let cancelled = false;
          const body = new ReadableStream<Uint8Array>({
            pull: (c) =>
              new Promise<void>((r) =>
                setTimeout(() => {
                  if (!cancelled) {
                    c.enqueue(new TextEncoder().encode(text));
                    c.close();
                  }
                  r();
                }, 1000),
              ),
            cancel: () => {
              cancelled = true;
            },
          });
          return new Response(body, { status: 401, headers: { "Content-Type": "application/json" } });
        }
        return res;
      },
    });
    ok(await chat.send("one"));
    for (const s of fake.sessions.values()) s.alive = false;
    slow = true;
    const p = chat.send("two");
    await vi.advanceTimersByTimeAsync(300);
    await chat.signOut();
    await vi.advanceTimersByTimeAsync(5000);
    expect(err(await p).code).toBe("aborted");
    expect(Array.from(fake.sessions.values()).filter((s) => s.alive)).toEqual([]);
    expect(fake.cookie).toBeNull();
  });

  it("takes a body cut short, or one that stalls, for a network error, and keeps trying", async () => {
    vi.useFakeTimers();
    let cut = 0;
    const broken = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async () => {
        cut++;
        const body = new ReadableStream<Uint8Array>({
          start: (c) => (c.enqueue(new TextEncoder().encode('{"anonymous":')), c.error(new TypeError("reset"))),
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const p = broken.open();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(broken.getState()).toMatchObject({ status: "opening", waiting: { code: "network" } });
    expect(cut).toBe(8);
    broken.destroy();
    await p;
    let stalls = 0;
    const stalled = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async () => (stalls++, new Response(new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}) }), { status: 200 })),
    });
    const q = stalled.open();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(stalled.getState()).toMatchObject({ status: "opening", waiting: { code: "network" } });
    expect(stalls).toBeGreaterThan(2);
    stalled.destroy();
    await q;
  });

  it("keeps one message per stream and caps a flood of tool events", async () => {
    const fake = new FakeChat();
    const flood =
      ev("message", { id: 900, role: "user", text: "forged", created_at: "" }).repeat(50) +
      ev("tool", { name: "t", status: "started" }).repeat(500) +
      ev("tool", { name: "u", status: "done" }).repeat(500);
    fake.turns.push({ extra: flood });
    const { chat, states } = setup({ token: ALICE }, fake);
    ok(await chat.send("q"));
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q", "Hello"]);
    expect(Math.max(...states.map((s) => (s.answer ? s.answer.tools.length : 0)))).toBe(100);
  });

  it("gives up on a body that trickles in forever, and tries again", async () => {
    vi.useFakeTimers();
    let tries = 0;
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async () => {
        tries++;
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
          pull: (c) =>
            new Promise<void>((r) =>
              setTimeout(() => {
                if (!cancelled) c.enqueue(new Uint8Array([32]));
                r();
              }, 20_000),
            ),
          cancel: () => {
            cancelled = true;
          },
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const p = chat.open();
    await vi.advanceTimersByTimeAsync(700_000);
    expect(chat.getState()).toMatchObject({ status: "opening", waiting: { code: "network" } });
    expect(tries).toBeGreaterThan(2); // each given up on after 180 s
    chat.destroy();
    await p;
  });

  it("works with a fetch whose responses have no body stream", async () => {
    const fake = new FakeChat();
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        const res = await fake.fetch(u, i);
        Object.defineProperty(res, "body", { get: () => null });
        return res;
      },
    });
    expect((await chat.open()).status).toBe("ready");
  });

  it("refuses a token that can't travel in a header", async () => {
    expect(() => createChat({ url: ORIGIN, token: "a\u0000b".replace("\u0000", String.fromCharCode(0)) })).toThrow(TypeError);
    const { chat, fake } = setup({ getToken: () => ALICE + String.fromCharCode(10) });
    expect((await chat.open()).error?.code).toBe("token_failed");
    expect(fake.seen).toHaveLength(0);
  });

  it("follows no redirect from the chat, and lets the token address redirect", async () => {
    const { chat, fake } = setup({ tokenUrl: TOKEN_URL });
    await chat.open();
    const chatCalls = fake.seen.filter((s) => s.url.startsWith(ORIGIN));
    expect(chatCalls.length).toBeGreaterThan(0);
    expect(chatCalls.every((s) => s.init.redirect === "error")).toBe(true);
    expect(fake.seen[0].init.redirect).toBeUndefined();
  });

  it("finds a first message with the cookie alone after the page's token expired", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const short = jwt({ sub: "alice", exp: Math.floor(Date.now() / 1000) + 60 });
    let lose = 1;
    const chat = createChat({
      url: ORIGIN,
      token: short,
      fetch: async (u, i) => {
        const res = await fake.fetch(u, i);
        if (String(u).endsWith("/conversations") && i?.method === "POST" && lose-- > 0) {
          void res.body?.cancel();
          throw new TypeError("connection lost");
        }
        return res;
      },
    });
    await chat.open();
    vi.setSystemTime(Date.now() + 120_000);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ok(await p).message.text).toBe("Hello");
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
  });

  it("waits out a slow body as long as bytes keep coming", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        const res = await fake.fetch(u, i);
        if (!(String(u).endsWith("/session") && i?.method === "POST")) return res;
        const bytes = new Uint8Array(await res.arrayBuffer());
        const step = Math.ceil(bytes.length / 20); // 20 parts 5 s apart: past 30 s, within the body's 180 s
        let at = 0;
        const body = new ReadableStream<Uint8Array>({
          pull: (c) =>
            new Promise<void>((r) =>
              setTimeout(() => {
                if (at >= bytes.length) c.close();
                else c.enqueue(bytes.slice(at, (at += step)));
                r();
              }, 5000),
            ),
        });
        return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    const p = chat.open();
    await vi.advanceTimersByTimeAsync(600_000);
    expect((await p).status).toBe("ready");
  });
});

describe("hangs", () => {
  it("gives up on a getToken that never answers, or when reopened meanwhile", async () => {
    vi.useFakeTimers();
    const chat = createChat({ url: ORIGIN, getToken: () => new Promise<string>(() => {}), fetch: new FakeChat().fetch });
    const p = chat.open();
    await vi.advanceTimersByTimeAsync(31_000);
    expect((await p).error?.code).toBe("token_failed");
    const q = chat.open();
    const r = chat.reopen();
    await vi.advanceTimersByTimeAsync(10);
    expect((await q).status).not.toBe("ready");
    void r;
  });

  it("settles a sign-out whose fetch ignores its signal", async () => {
    vi.useFakeTimers();
    const chat = createChat({ url: ORIGIN, fetch: () => new Promise<Response>(() => {}) });
    let done = false;
    void chat.signOut().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(3100);
    expect(done).toBe(true);
  });
});

describe("silence", () => {
  const hang = (_u: unknown, i?: RequestInit) =>
    new Promise<Response>((_r, reject) => i!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

  it("gives up on a request no answer starts for, and tries again", async () => {
    vi.useFakeTimers();
    let tries = 0;
    const chat = createChat({ url: ORIGIN, token: ALICE, fetch: (u, i) => (tries++, hang(u, i)) });
    const p = chat.open();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(chat.getState()).toMatchObject({ status: "opening", waiting: { code: "network" } });
    expect(tries).toBeGreaterThan(2); // each given up on after 30 s
    chat.destroy();
    await p;
  });

  it("keeps a message whose sending never got an answer, once the conversation shows it wasn't stored", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: (u, i) => (String(u).endsWith("/conversations") && i?.method === "POST" ? hang(u, i) : fake.fetch(u, i)),
    });
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(35_000);
    expect(err(await p).code).toBe("network");
    expect(chat.getState()).toMatchObject({ outgoing: "q", answering: false });
  });
});

describe("users who change", () => {
  it("reopens for another user and cuts the running answer short", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.turns.push({ stall: true });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(10);
    const st = await chat.reopen({ token: BOB });
    expect(err(await p).code).toBe("aborted");
    expect(st.status).toBe("ready");
    expect(st.messages).toEqual([]);
    expect(st.answering).toBe(false);
    expect(st.error).toBeNull();
    expect(fake.requests("POST", "/chat/v1/session").pop()!.auth).toBe("Bearer " + BOB);
  });

  it("takes an empty ext for none, as the chat does, and any other for another user", () => {
    const who = (t: string) => claimsOf(t)!.who_;
    expect(who(jwt({ sub: "alice", ext: {} }))).toBe(who(ALICE));
    expect(who(jwt({ sub: "alice", ext: null }))).toBe(who(ALICE));
    expect(who(jwt({ sub: "alice", ext: { team: 2 } }))).not.toBe(who(ALICE));
  });

  it("sends nothing on reopen before the chat was ever shown", async () => {
    const { chat, fake } = setup({ token: ALICE });
    const st = await chat.reopen({ token: BOB });
    expect(st.status).toBe("idle");
    expect(fake.seen).toHaveLength(0);
    await chat.open();
    expect(fake.seen[0].auth).toBe("Bearer " + BOB);
    expect(() => chat.reopen({ token: undefined })).toThrow(TypeError);
  });

  it("signs out: the session ends and the page's token is forgotten", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    ok(await chat.send("q"));
    await chat.signOut();
    expect(chat.getState().status).toBe("idle");
    expect(chat.getState().messages).toEqual([]);
    expect(fake.requests("DELETE")[0].auth).toBeNull();
    expect(fake.cookie).toBeNull();
    fake.seen = [];
    expect((await chat.open()).anonymous).toBe(true);
    expect(fake.seen.every((s) => s.auth === null)).toBe(true);
  });

  it("signs out even a page that never showed the chat", async () => {
    const fake = new FakeChat();
    const alice = fake.live("alice");
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    await chat.signOut();
    expect(fake.sessions.get(alice)!.alive).toBe(false);
    expect(fake.tokenCalls).toBe(0);
  });

  it("signs an anonymous visitor out with its session token", async () => {
    const fake = new FakeChat();
    fake.keepsCookie = false;
    const { chat } = setup({}, fake);
    await chat.open();
    await chat.signOut();
    expect(fake.requests("DELETE")[0].auth).toMatch(/^Bearer h_/);
  });

  it("never rejects or stalls a sign-out", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    fake.refusals.push({ method: "DELETE", status: 500, error: "internal" });
    await expect(chat.signOut()).resolves.toBeUndefined();
    const offline = createChat({ url: ORIGIN, fetch: () => Promise.reject(new TypeError("offline")) });
    await expect(offline.signOut()).resolves.toBeUndefined();
    const hung = createChat({
      url: ORIGIN,
      fetch: (_u, i) => new Promise((_r, reject) => i!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))),
    });
    let done = false;
    void hung.signOut().then(() => (done = true));
    await vi.advanceTimersByTimeAsync(3100);
    expect(done).toBe(true);
  });

  it("goes quiet when destroyed", async () => {
    const { chat, fake, states } = setup({ token: ALICE });
    await chat.open();
    const n = states.length;
    const seen = fake.seen.length;
    chat.destroy();
    await chat.open();
    expect(err(await chat.send("q")).code).toBe("aborted");
    expect(states).toHaveLength(n);
    expect(fake.seen).toHaveLength(seen);
  });
});

describe("the client", () => {
  it("checks its options", () => {
    expect(() => createChat({} as ChatOptions)).toThrow(TypeError);
    expect(() => createChat({ url: "calm-otter.meandr.io" })).toThrow(TypeError);
    expect(() => createChat({ url: "ftp://x" })).toThrow(TypeError);
    expect(() => createChat({ url: "http://calm-otter.meandr.io" })).toThrow(TypeError);
    expect(() => createChat({ url: "https://u:p@calm-otter.meandr.io" })).toThrow(TypeError);
    expect(() => createChat({ url: ORIGIN, token: "t", tokenUrl: "/t" })).toThrow(TypeError);
    expect(() => createChat({ url: ORIGIN, token: "" })).toThrow(TypeError);
    expect(() => createChat({ url: ORIGIN, token: undefined })).toThrow(TypeError);
    expect(() => createChat({ url: ORIGIN, tokenURL: "/t" } as ChatOptions)).toThrow(/unknown option tokenURL/);
    expect(() => createChat({ url: ORIGIN, getToken: "x" as never })).toThrow(TypeError);
    expect(() => createChat({ url: "http://localhost:8080" })).not.toThrow();
    expect(() => createChat({ url: ORIGIN, token: null })).not.toThrow();
  });

  it("serves the API under a site's own path when its server forwards it", async () => {
    const urls: string[] = [];
    const chat = createChat({
      url: "https://shop.example/support/",
      fetch: async (u) => {
        urls.push(String(u));
        return json(200, { anonymous: false, started: false, conversation: null, messages: [], answering: false });
      },
    });
    await chat.open();
    expect(urls).toEqual(["https://shop.example/support/chat/v1/session"]);
  });

  it("sends no header CORS would refuse", async () => {
    const fake = new FakeChat();
    fake.keepsCookie = false;
    const { chat } = setup({ getToken: () => ALICE }, fake);
    ok(await chat.send("q"));
    await chat.signOut();
    for (const s of fake.seen) {
      const names = Array.from(s.headers.keys());
      expect(names.every((h) => ["authorization", "content-type", "accept"].includes(h))).toBe(true);
      expect(s.init.credentials).toBe("include");
    }
  });

  it("never shows a token when logged or serialized", async () => {
    const fake = new FakeChat();
    fake.keepsCookie = false;
    const { chat } = setup({ token: ALICE }, fake);
    ok(await chat.send("q"));
    const printed = inspect(chat, { depth: 10, showHidden: true }) + JSON.stringify(chat) + JSON.stringify(chat.getState());
    expect(printed).not.toContain(ALICE);
  });

  it("calls a listener at once, and no more once unsubscribed", async () => {
    const { chat } = setup({ token: ALICE });
    const got: ChatState[] = [];
    const off = chat.subscribe((s) => got.push(s));
    expect(got).toEqual([chat.getState()]);
    off();
    await chat.open();
    expect(got).toHaveLength(1);
  });

  it("works with its members passed around unbound", async () => {
    const { chat } = setup({ token: ALICE });
    const { open, send, getState, subscribe, newConversation, endConversation } = chat;
    subscribe(() => {});
    await open();
    ok(await send("q"));
    newConversation();
    expect(getState().messages).toEqual([]);
    ok(await send("r"));
    await endConversation();
    expect(getState().messages).toEqual([]);
  });

  it("survives a listener that throws", async () => {
    vi.useFakeTimers();
    const { chat } = setup({ token: ALICE });
    chat.subscribe(() => {
      throw new Error("bad listener");
    });
    expect((await chat.open()).status).toBe("ready");
    expect(() => vi.runAllTimers()).toThrow("bad listener");
  });

  it("recognizes its errors across copies", () => {
    const e = new ChatError("network", "x");
    expect(isChatError(e)).toBe(true);
    expect(isChatError({ name: "ChatError", code: "network" })).toBe(true);
    expect(isChatError(new Error("x"))).toBe(false);
  });
});

describe("the assistant speaking first", () => {
  it("is refused while the chat has no start instructions, and changes nothing else", async () => {
    const { chat, fake } = setup({ token: ALICE });
    expect(err(await chat.start()).code).toBe("start_not_allowed");
    expect(chat.getState()).toMatchObject({ status: "ready", answering: false, answer: null, messages: [] });
    expect(fake.requests("POST").map((s) => s.path)).toEqual(["/chat/v1/session", "/chat/v1/start"]);
  });

  it("opens, has the assistant speak, and shows its answer alone, sending only the page's context", async () => {
    const fake = new FakeChat();
    fake.startPrompt = "Greet them.";
    const { chat } = setup({ token: ALICE }, fake);
    expect(ok(await chat.start()).message.text).toBe("Hello");
    expect(chat.getState()).toMatchObject({ status: "ready", answering: false, answer: null, outgoing: null });
    expect(chat.getState().messages.map((m) => [m.role, m.text])).toEqual([["assistant", "Hello"]]);
    expect(fake.requests("POST", "/chat/v1/start")[0].body).toEqual({ new: true, context: TZ }); // no conversation shown
  });

  it("after newConversation speaks in a new conversation, never in the one hidden", async () => {
    for (const before of [false, true]) {
      const fake = new FakeChat();
      fake.startPrompt = "Greet them.";
      const old = fake.conversation("alice", "", ["q", "a"]);
      const { chat } = setup({ token: ALICE }, fake);
      if (!before) await chat.open();
      chat.newConversation();
      ok(await chat.start());
      expect(chat.getState().conversation!.id).not.toBe(old.id);
      expect(chat.getState().messages.map((m) => m.text)).toEqual(["Hello"]);
      expect(old.messages.map((m) => m.text)).toEqual(["q", "a"]);
      expect(fake.requests("POST", "/chat/v1/start")[0].body).toEqual({ new: true, context: TZ });
    }
  });

  it("goes on in the conversation shown, keeping its messages, or in a newer one another tab moved on to", async () => {
    const fake = new FakeChat();
    fake.startPrompt = "Say what needs attention.";
    const { chat } = setup({ token: ALICE }, fake);
    ok(await chat.send("q"));
    const conv = chat.getState().conversation!.id;
    fake.turns.push({ deltas: ["Nothing", " does"] });
    ok(await chat.start());
    expect(chat.getState().conversation!.id).toBe(conv);
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q", "Hello", "Nothing does"]);
    const other = fake.conversation("alice", "", ["elsewhere"]);
    ok(await chat.start());
    expect(chat.getState().conversation!.id).toBe(other.id);
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["Hello"]);
  });

  it("follows a start whose stream was lost to its answer", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.startPrompt = "Greet them.";
    fake.turns.push({ deltas: ["Hi"], text: "Hi there", drop: "after-deltas", pollsAnswering: 1 });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ok(await p).message.text).toBe("Hi there");
    expect(chat.getState()).toMatchObject({ answering: false, answer: null });
  });
});

describe("page context", () => {
  const contexts = (fake: FakeChat) =>
    fake.seen
      .filter((s) => s.method === "POST" && /\/chat\/v1\/(start|conversations)/.test(s.path))
      .map((s) => (s.body as { context?: unknown }).context);

  // fill is a view that brings the context, the time zone under it, to exactly bytes.
  const fill = (bytes: number) => "x".repeat(bytes - new TextEncoder().encode(JSON.stringify({ ...TZ, view: "" })).length);

  it("tells the browser's time zone with every message and start when the page gives no context", async () => {
    const fake = new FakeChat();
    fake.startPrompt = "Greet them.";
    const { chat } = setup({ token: ALICE }, fake);
    ok(await chat.start());
    ok(await chat.send("q"));
    expect(contexts(fake)).toEqual([TZ, TZ]);
  });

  it("reads the context option at each message and start, the time zone under what it gives", async () => {
    const fake = new FakeChat();
    fake.startPrompt = "Greet them.";
    let n = 0;
    const view = { drawer: { open: true, order: "A-1042" } };
    const { chat } = setup({ token: ALICE, context: () => ({ url: "https://shop.example/orders", title: "Orders " + ++n, view }) }, fake);
    ok(await chat.send("one"));
    ok(await chat.start());
    ok(await chat.send("two"));
    expect(contexts(fake)).toEqual([1, 2, 3].map((i) => ({ ...TZ, url: "https://shop.example/orders", title: "Orders " + i, view })));
  });

  it("takes the page's own time zone, or none, and waits for a promise", async () => {
    const pages: Array<PageContext | undefined> = [{ timezone: "Asia/Tokyo" }, { timezone: undefined, view: "list" }, undefined];
    const { chat, fake } = setup({ token: ALICE, context: async () => pages.shift() });
    for (const t of ["a", "b", "c"]) ok(await chat.send(t));
    expect(contexts(fake)).toEqual([{ timezone: "Asia/Tokyo" }, { view: "list" }, TZ]);
  });

  it("leaves out a context past the chat's most in UTF-8 bytes, keeping the time zone, and warns once naming it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = new FakeChat();
    fake.contextMax = 200;
    fake.startPrompt = "Greet them.";
    const views = [fill(200), fill(201), "é".repeat(90), fill(300)];
    const { chat } = setup({ token: ALICE, context: () => ({ view: views.shift() }) }, fake);
    ok(await chat.send("fits"));
    ok(await chat.send("a byte over"));
    ok(await chat.send("short, in two-byte characters"));
    ok(await chat.start());
    expect(contexts(fake)).toEqual([{ ...TZ, view: fill(200) }, TZ, TZ, TZ]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("200 bytes");
  });

  it("leaves out a context whose url, title or timezone the chat would refuse, and warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pages: unknown[] = [
      { url: "https://shop.example/?q=" + "q".repeat(2048) },
      { title: 42 },
      { timezone: "Z".repeat(65) },
      { url: "https://shop.example/ok", title: "T".repeat(512) },
    ];
    const { chat, fake } = setup({ token: ALICE, context: () => pages.shift() as PageContext });
    for (const t of ["a", "b", "c", "d"]) ok(await chat.send(t));
    expect(contexts(fake)).toEqual([TZ, TZ, TZ, { ...TZ, url: "https://shop.example/ok", title: "T".repeat(512) }]);
    expect(warn).toHaveBeenCalledTimes(3);
  });

  it("sends without the page's part when the option throws, gives no JSON object or takes over 5 s, and warns", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = new Error("broken view");
    const answers: Array<() => unknown> = [
      () => {
        throw broken;
      },
      () => "orders",
      () => [1, 2],
      () => {
        const o: Record<string, unknown> = {};
        o.self = o;
        return o;
      },
      () => new Promise(() => {}),
    ];
    const { chat, fake } = setup({ token: ALICE, context: () => answers.shift()!() as PageContext });
    for (const t of ["a", "b", "c", "d"]) ok(await chat.send(t));
    const p = chat.send("e");
    await vi.advanceTimersByTimeAsync(5_100);
    ok(await p);
    expect(contexts(fake)).toEqual([TZ, TZ, TZ, TZ, TZ]);
    expect(warn).toHaveBeenCalledTimes(2); // once for each reason
    expect(warn.mock.calls[0][1]).toBe(broken);
  });

  it("sends only the time zone to a chat that doesn't say its most, which predates the context", async () => {
    const fake = new FakeChat();
    fake.contextMax = null;
    const view = fill(20_000);
    const { chat } = setup({ token: ALICE, context: () => ({ view }) }, fake);
    ok(await chat.send("q"));
    expect(contexts(fake)).toEqual([TZ]);
  });

  it("ends a message waiting on the context option when the page moves on", async () => {
    const { chat, fake } = setup({ token: ALICE, context: () => new Promise<PageContext>(() => {}) });
    await chat.open();
    const p = chat.send("q");
    await new Promise((r) => setTimeout(r, 5));
    chat.newConversation();
    expect(err(await p).code).toBe("aborted");
    expect(contexts(fake)).toEqual([]);
  });

  it("checks the context option", () => {
    expect(() => createChat({ url: ORIGIN, context: "x" as never })).toThrow(/context must be a function/);
    expect(() => createChat({ url: ORIGIN, context: undefined })).not.toThrow();
  });
});

describe("files", () => {
  function png(name = "photo.png", size = 1000): File {
    const b = new Uint8Array(size);
    b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    return new File([b], name, { type: "image/png" });
  }

  async function attached(p: Promise<AttachResult>): Promise<ChatFile> {
    const r = await p;
    if (!r.ok) throw r.error;
    return r.file;
  }

  async function read(p: Promise<ReadFileResult>): Promise<Blob> {
    const r = await p;
    if (!r.ok) throw r.error;
    return r.blob;
  }

  async function refused(p: Promise<AttachResult | ReadFileResult>): Promise<ChatError> {
    const r = await p;
    if (r.ok) throw new Error("expected a failure");
    return r.error;
  }

  const uploads = (fake: FakeChat) => fake.requests("POST").filter((s) => s.path.startsWith("/chat/v1/files"));

  const hang = (_u: unknown, i?: RequestInit) =>
    new Promise<Response>((_r, reject) => i!.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

  function withXHR(fake: FakeChat, stall = false) {
    const X = xhrOf(fake, stall);
    vi.stubGlobal("XMLHttpRequest", X);
    return X;
  }

  it("uploads a file through the page's fetch as the session's user, changing nothing in the state", async () => {
    const { chat, fake, states } = setup({ token: ALICE });
    await chat.open();
    const n = states.length;
    const f = await attached(chat.attach(png("cat.png", 1000)));
    expect(f).toEqual({ id: expect.any(String), name: "cat.png", type: "image/png", size: 1000, createdAt: "2026-11-17T00:00:00Z" });
    const [up] = uploads(fake);
    expect(up.path).toBe("/chat/v1/files?name=cat.png");
    expect(up.headers.get("Content-Type")).toBe("image/png");
    expect(up.init.credentials).toBe("include");
    expect(up.body).toBeInstanceOf(Blob);
    expect(up.auth).toBeNull();
    expect(states).toHaveLength(n);
  });

  it("opens the session first when needed, as send does", async () => {
    const { chat, fake } = setup({ token: ALICE });
    await attached(chat.attach(png()));
    expect(fake.seen.map((s) => s.method + " " + s.path.split("?")[0])).toEqual([
      "POST /chat/v1/session",
      "GET /chat/v1/session",
      "POST /chat/v1/files",
    ]);
    expect(chat.getState().status).toBe("ready");
  });

  it("reports an upload's progress through XMLHttpRequest, with the cookie or the bearer the session needs", async () => {
    for (const keepsCookie of [true, false]) {
      const fake = new FakeChat();
      fake.keepsCookie = keepsCookie;
      const X = withXHR(fake);
      const { chat } = setup({ token: ALICE }, fake);
      const seen: Array<[number, number]> = [];
      const f = await attached(chat.attach(png("a.png", 400), { onProgress: (sent, total) => seen.push([sent, total]) }));
      expect(f).toMatchObject({ name: "a.png", type: "image/png", size: 400 });
      expect(seen).toEqual([[100, 400], [200, 400], [300, 400], [400, 400]]);
      expect(X.sent).toHaveLength(1);
      expect(X.sent[0]).toMatchObject({ method: "POST", url: ORIGIN + "/chat/v1/files?name=a.png", withCredentials: true });
      expect(X.sent[0].headers["Content-Type"]).toBe("image/png");
      expect(X.sent[0].headers.Authorization).toBe(keepsCookie ? undefined : "Bearer " + ALICE);
    }
  });

  it("names an upload as the page says, as the File is, or file, and sends the type it believes", async () => {
    const { chat, fake } = setup({ token: ALICE });
    const csv = await attached(chat.attach(new File(["a,b"], "data.csv")));
    await attached(chat.attach(new Blob(["hi"])));
    await attached(chat.attach(png(), { name: "my cat " + String.fromCharCode(0xd800) + ".png" }));
    await attached(chat.attach(png(), { name: "" }));
    expect(uploads(fake).map((s) => [new URL(s.url).searchParams.get("name"), s.headers.get("Content-Type")])).toEqual([
      ["data.csv", "application/octet-stream"],
      ["file", "application/octet-stream"],
      ["my cat " + String.fromCharCode(0xfffd) + ".png", "image/png"],
      ["file", "image/png"],
    ]);
    expect(csv.type).toBe("text/plain"); // the chat reads it from the bytes
  });

  it("refuses a file larger than the proxy takes, without sending it", async () => {
    const { chat, fake } = setup({ token: ALICE });
    expect(await refused(chat.attach(new Blob([new Uint8Array((10 << 20) + 1)])))).toMatchObject({ code: "too_large", status: 0 });
    expect(fake.seen).toHaveLength(0);
  });

  it("shows what the chat takes once a session says so: null before, and while it takes no file", async () => {
    const fake = new FakeChat();
    fake.maxFileBytes = 5 << 20;
    fake.perMessage = 3;
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    expect(chat.getState().files).toBeNull();
    const first = (await chat.open()).files;
    expect(first).toEqual({ types: TYPES, maxBytes: 5 << 20, perMessage: 3 });
    for (const s of fake.sessions.values()) s.alive = false;
    ok(await chat.send("q")); // the session opened again says the same
    expect(chat.getState().files).toBe(first);
    fake.fileTypes = ["application/pdf"];
    expect((await chat.reopen()).files).toEqual({ types: ["application/pdf"], maxBytes: 5 << 20, perMessage: 3 });
    fake.fileTypes = [];
    expect((await chat.reopen()).files).toBeNull();
    fake.fileTypes = TYPES.slice();
    fake.attachments = false;
    expect((await chat.reopen()).files).toBeNull();
    fake.attachments = true;
    expect((await chat.reopen()).files).not.toBeNull();
    await chat.signOut();
    expect(chat.getState().files).toBeNull();
  });

  it("keeps what the chat takes, and whether it lists conversations, when the page is wiped for another user", async () => {
    const fake = new FakeChat();
    fake.conversationList = true;
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    await chat.open();
    for (const s of fake.sessions.values()) s.alive = false;
    fake.tokenAnswers.push({ status: 200, body: { token: BOB } });
    expect(err(await chat.send("alice's draft")).code).toBe("session_expired");
    expect(chat.getState()).toMatchObject({ messages: [], outgoing: null, files: { maxBytes: 7 << 20 }, conversationList: true });
  });

  it("refuses a file past the chat's most without sending it, once its session says", async () => {
    const fake = new FakeChat();
    fake.maxFileBytes = 500;
    const { chat } = setup({ token: ALICE }, fake);
    expect(await refused(chat.attach(png("big.png", 501)))).toMatchObject({ code: "too_large", status: 0 });
    expect(sessionPaths(fake)).toEqual(["POST", "GET"]);
    expect(uploads(fake)).toHaveLength(0);
    expect((await attached(chat.attach(png("fits.png", 500)))).size).toBe(500);
    expect(uploads(fake)).toHaveLength(1);
  });

  it("refuses at once where the chat's session takes no file, and reads a file already sent all the same", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    const f = await attached(chat.attach(png("p.png", 64)));
    fake.attachments = false;
    expect((await chat.reopen({ token: ALICE })).files).toBeNull();
    expect(await refused(chat.attach(png()))).toMatchObject({ code: "attachments_off", status: 0 });
    expect(uploads(fake)).toHaveLength(1);
    expect((await read(chat.readFile(f))).size).toBe(64);
  });

  it("leaves the chat to answer where its session says nothing of files it can read", async () => {
    const fake = new FakeChat();
    fake.saysFiles = false;
    const { chat } = setup({ token: ALICE }, fake);
    expect((await chat.open()).files).toBeNull();
    expect((await attached(chat.attach(png()))).type).toBe("image/png");
    fake.maxFileBytes = 500;
    expect(await refused(chat.attach(png("big.png", 600)))).toMatchObject({ code: "too_large", status: 413 });
    expect(await refused(chat.attach(new Blob([new Uint8Array((10 << 20) + 1)])))).toMatchObject({ code: "too_large", status: 0 });
    expect(uploads(fake)).toHaveLength(2);
    const odd = createChat({
      url: ORIGIN,
      fetch: async (u, i) =>
        String(u).endsWith("/session") && i?.method === "POST"
          ? json(200, { anonymous: false, started: false, conversation: null, messages: [], answering: false, files: { types: "all" } })
          : fake.fetch(u, i),
    });
    expect((await odd.open()).files).toBeNull();
    expect((await attached(odd.attach(png("p.png", 400)))).size).toBe(400);
  });

  it("says why the chat refused a file when what its session said has changed, trying none of those again", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open(); // its session takes files, up to 7 MiB
    fake.attachments = false;
    const off = await refused(chat.attach(png()));
    fake.attachments = true;
    fake.maxFileBytes = 500;
    const large = await refused(chat.attach(png("big.png", 600)));
    const kind = await refused(chat.attach(new File([new Uint8Array([0, 1, 2])], "x.bin")));
    fake.storageBytes = 700;
    await attached(chat.attach(png("one.png", 400)));
    const full = await refused(chat.attach(png("two.png", 400)));
    expect([off, large, kind, full].map((e) => [e.code, e.status, e.retryable])).toEqual([
      ["attachments_off", 403, false],
      ["too_large", 413, false],
      ["unsupported_type", 415, false],
      ["storage_full", 403, false],
    ]);
    expect(uploads(fake)).toHaveLength(5);
  });

  it("opens the session again when it ended, and uploads the file once more, only once", async () => {
    const fake = new FakeChat();
    const X = withXHR(fake);
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    await chat.open();
    for (const s of fake.sessions.values()) s.alive = false;
    const sent: number[] = [];
    expect((await attached(chat.attach(png("a.png", 400), { onProgress: (n) => sent.push(n) }))).name).toBe("a.png");
    expect(X.sent).toHaveLength(2);
    expect(sent).toEqual([100, 200, 300, 400, 100, 200, 300, 400]);
    expect(fake.tokenCalls).toBe(2);
    fake.refusals.push({ method: "POST", path: /\/files/, status: 401, error: "session_expired" });
    expect((await refused(chat.attach(png()))).code).toBe("session_expired");
    expect(uploads(fake)).toHaveLength(4);
  });

  it("waits as the chat says when it's short of memory or uploads come too fast, up to a minute", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.refusals.push(
      { method: "POST", path: /\/files/, status: 503, error: "overloaded", retryAfter: 2, times: 1 },
      { method: "POST", path: /\/files/, status: 429, error: "rate_limited", retryAfter: 1, times: 1 },
    );
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    const p = chat.attach(png());
    await vi.advanceTimersByTimeAsync(2500);
    expect(uploads(fake)).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    await attached(p);
    expect(uploads(fake)).toHaveLength(3);
    expect(chat.getState().waiting).toBeNull();

    fake.refusals.push({ method: "POST", path: /\/files/, status: 503, error: "overloaded", retryAfter: 30 });
    const q = chat.attach(png());
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await refused(q)).toMatchObject({ code: "overloaded", retryAfter: 30 });
    expect(uploads(fake)).toHaveLength(6); // at 0, 30 and 60 s
  });

  it("never uploads a file again when its answer was lost: it may have been stored", async () => {
    const fake = new FakeChat();
    let tries = 0;
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: (u, i) => (String(u).includes("/files") ? (tries++, Promise.reject(new TypeError("offline"))) : fake.fetch(u, i)),
    });
    expect((await refused(chat.attach(png()))).code).toBe("network");
    expect(tries).toBe(1);
  });

  it("cuts an upload short on the page's signal, or when the user changes", async () => {
    const fake = new FakeChat();
    const chat = createChat({ url: ORIGIN, token: ALICE, fetch: (u, i) => (String(u).includes("/files") ? hang(u, i) : fake.fetch(u, i)) });
    await chat.open();
    const stop = new AbortController();
    const p = chat.attach(png(), { signal: stop.signal });
    await new Promise((r) => setTimeout(r, 5));
    stop.abort();
    expect((await refused(p)).code).toBe("aborted");
    const q = chat.attach(png());
    await new Promise((r) => setTimeout(r, 5));
    await chat.reopen({ token: BOB });
    expect((await refused(q)).code).toBe("aborted");
    const n = fake.seen.length;
    expect((await refused(chat.attach(png(), { signal: stop.signal }))).code).toBe("aborted");
    expect(fake.seen).toHaveLength(n);
  });

  it("gives up on an upload that makes no progress for 30 s", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const X = withXHR(fake, true);
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    let settled = false;
    const p = chat.attach(png(), { onProgress: () => {} });
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await refused(p)).code).toBe("network");
    expect(X.sent[0].aborted).toBe(true);
  });

  it("gives an upload through fetch time for its size before its answer must start", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const chat = createChat({ url: ORIGIN, token: ALICE, fetch: (u, i) => (String(u).includes("/files") ? hang(u, i) : fake.fetch(u, i)) });
    await chat.open();
    let settled = false;
    const p = chat.attach(png("big.png", 1 << 20));
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false); // 30 s, and 1 MiB at 32 KB/s
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await refused(p)).code).toBe("network");
  });

  it("checks its arguments", () => {
    const { chat, fake } = setup({ token: ALICE });
    expect(() => chat.attach("x" as never)).toThrow(TypeError);
    expect(() => chat.attach(png(), null as never)).toThrow(TypeError);
    expect(() => chat.attach(png(), { nmae: "x" } as never)).toThrow(/unknown option nmae/);
    expect(() => chat.attach(png(), { name: 1 } as never)).toThrow(TypeError);
    expect(() => chat.attach(png(), { onProgress: 1 } as never)).toThrow(TypeError);
    expect(() => chat.attach(png(), { signal: {} } as never)).toThrow(TypeError);
    expect(() => chat.send("q", { file: [] } as never)).toThrow(/unknown option file/);
    expect(() => chat.send("q", { files: "f1" } as never)).toThrow(TypeError);
    expect(() => chat.send("q", { files: [{}] } as never)).toThrow(TypeError);
    expect(() => chat.readFile("")).toThrow(TypeError);
    expect(() => chat.readFile({ id: 1 } as never)).toThrow(TypeError);
    expect(() => chat.readFile("f1", { sginal: undefined } as never)).toThrow(/unknown option sginal/);
    expect(fake.seen).toHaveLength(0);
  });

  it("sends a message with files, by their ChatFiles or ids, its text empty or not", async () => {
    const { chat, fake } = setup({ token: ALICE });
    const a = await attached(chat.attach(png("a.png")));
    const b = await attached(chat.attach(new File(["# Notes"], "notes.md", { type: "text/markdown" })));
    expect(b.type).toBe("text/markdown");
    expect(ok(await chat.send("  ", { files: [a, b.id] })).message.text).toBe("Hello");
    expect(fake.requests("POST", "/chat/v1/conversations")[0].body).toEqual({ text: "", files: [a.id, b.id], context: TZ });
    expect(chat.getState().messages[0]).toMatchObject({ role: "user", text: "" });
    expect(chat.getState().messages[0].files).toEqual([a, b]);
    const c = await attached(chat.attach(png("c.png")));
    ok(await chat.send("And this", { files: [c] }));
    ok(await chat.send("Plain", { files: [] }));
    expect(fake.requests("POST").filter((s) => s.path.endsWith("/messages")).map((s) => s.body)).toEqual([
      { text: "And this", files: [c.id], context: TZ },
      { text: "Plain", context: TZ },
    ]);
    expect(chat.getState().messages.map((m) => (m.files ? m.files.length : 0))).toEqual([2, 0, 1, 0, 0, 0]);
  });

  it("keeps a message with files the chat refused, with its error", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    const a = await attached(chat.attach(png()));
    ok(await chat.send("first", { files: [a] }));
    expect(err(await chat.send("again", { files: [a] }))).toMatchObject({ code: "bad_request", status: 400 });
    expect(chat.getState()).toMatchObject({ outgoing: "again", error: { code: "bad_request" } });
    fake.attachments = false;
    expect(err(await chat.send("", { files: ["f-other"] })).code).toBe("attachments_off");
    expect(err(await chat.send("", {})).code).toBe("bad_request");
  });

  it("finds a message of files alone whose answer was lost, by its file", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.turns.push({ drop: "before-conversation", text: "Seen it", pollsAnswering: 0 });
    const { chat } = setup({ token: ALICE }, fake);
    const f = await attached(chat.attach(png()));
    const p = chat.send("", { files: [f] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ok(await p).message.text).toBe("Seen it");
    expect(chat.getState().messages.map((m) => [m.text, m.files ? m.files.map((x) => x.id) : []])).toEqual([
      ["", [f.id]],
      ["Seen it", []],
    ]);
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
  });

  it("reads a file with the session's credentials: the cookie, the customer's token or the session token", async () => {
    const cases: Array<[Partial<ChatOptions>, boolean, unknown]> = [
      [{ token: ALICE }, true, null],
      [{ token: ALICE }, false, "Bearer " + ALICE],
      [{}, false, expect.stringMatching(/^Bearer h_/)],
    ];
    for (const [opts, keepsCookie, auth] of cases) {
      const fake = new FakeChat();
      fake.keepsCookie = keepsCookie;
      const { chat } = setup(opts, fake);
      const f = await attached(chat.attach(png("p.png", 64)));
      const blob = await read(chat.readFile(f));
      expect(blob.type).toBe("image/png");
      expect(new Uint8Array(await blob.arrayBuffer())).toEqual(fake.files.get(f.id)!.bytes);
      const [get] = fake.requests("GET", "/chat/v1/files/" + f.id);
      expect(get.auth).toEqual(auth);
      expect(get.init.credentials).toBe("include");
    }
  });

  it("reads a file by its id on a page that hasn't opened the chat, opening it first", async () => {
    const fake = new FakeChat();
    const f = await attached(setup({ token: ALICE }, fake).chat.attach(png("p.png", 64)));
    const { chat } = setup({ token: ALICE }, fake);
    expect((await read(chat.readFile(f.id))).size).toBe(64);
    expect(chat.getState().status).toBe("ready");
  });

  it("hands over anything but an image as a file to save, never one to render, whatever the chat says", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    const t = await attached(chat.attach(new File(["hello"], "a.txt", { type: "text/plain" })));
    expect(t.type).toBe("text/plain");
    const blob = await read(chat.readFile(t));
    expect(blob.type).toBe("application/octet-stream");
    expect(await blob.text()).toBe("hello");
    const odd = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => (String(u).includes("/files/") ? new Response("<script>", { headers: { "Content-Type": "text/html" } }) : fake.fetch(u, i)),
    });
    expect((await read(odd.readFile("f1"))).type).toBe("application/octet-stream");
  });

  it("says not_found for a file someone else attached", async () => {
    const fake = new FakeChat();
    const f = await attached(setup({ token: ALICE }, fake).chat.attach(png()));
    const { chat } = setup({ token: BOB }, fake);
    expect(await refused(chat.readFile(f))).toMatchObject({ code: "not_found", status: 404 });
  });

  it("reads stored messages' files in camelCase, dropping any it can't read", async () => {
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", ["look", "nice"]);
    c.messages[0].files = [{ id: "f9", name: "cat.png", type: "image/png", size: 3, created_at: "2026-11-17T00:00:00Z" }, { name: "x" } as never];
    const { chat } = setup({ token: ALICE }, fake);
    const st = await chat.open();
    expect(st.messages[0].files).toEqual([{ id: "f9", name: "cat.png", type: "image/png", size: 3, createdAt: "2026-11-17T00:00:00Z" }]);
    expect(st.messages[1].files).toBeUndefined();
  });
});

describe("conversations", () => {
  const texts = (n: number, p = "m") => Array.from({ length: n }, (_, i) => p + (i + 1));
  const shown = (chat: Chat) => chat.getState().messages.map((m) => m.text);
  const older = (fake: FakeChat) => fake.requests("GET").filter((s) => s.path.includes("?before=")).map((s) => s.path);
  const AT = "2026-11-15T00:00:00Z";

  async function done<T extends { ok: boolean }>(p: Promise<T>): Promise<Extract<T, { ok: true }>> {
    const r = await p;
    if (!r.ok) throw (r as { error?: unknown }).error;
    return r as Extract<T, { ok: true }>;
  }

  async function fails(p: Promise<{ ok: boolean; error?: ChatError }>): Promise<ChatError> {
    const r = await p;
    if (r.ok || !r.error) throw new Error("expected a failure");
    return r.error;
  }

  // gated holds the first POST to path, its answer or only its body, until release is called.
  function gated(fake: FakeChat, path: RegExp, part: "answer" | "body") {
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let held = false;
    const fetch = async (u: RequestInfo | URL, i?: RequestInit): Promise<Response> => {
      const res = await fake.fetch(u, i);
      if (held || i?.method !== "POST" || !path.test(String(u))) return res;
      held = true;
      if (part === "answer") return gate.then(() => res);
      const reader = res.body!.getReader();
      const body = new ReadableStream<Uint8Array>({
        pull: async (c) => {
          await gate;
          const r = await reader.read();
          if (r.done) c.close();
          else c.enqueue(r.value);
        },
        cancel: (why) => reader.cancel(why),
      });
      return new Response(body, { status: res.status, headers: res.headers });
    };
    return { fetch, release: () => release() };
  }

  it("opens on the latest conversation's last 20 messages, saying whether older ones remain and whether the chat lists conversations", async () => {
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", texts(25));
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    expect(chat.getState()).toMatchObject({ hasOlder: false, conversationList: null });
    const st = await chat.open();
    expect(st.messages.map((m) => m.text)).toEqual(texts(25).slice(5));
    expect(st).toMatchObject({ hasOlder: true, conversationList: false });
    fake.conversationList = true;
    expect(await chat.reopen()).toMatchObject({ hasOlder: true, conversationList: true });
    fake.conversationList = null; // a chat from before the list says nothing of it
    expect((await chat.reopen()).conversationList).toBe(false);
    c.messages.splice(0, 5);
    expect((await chat.reopen()).hasOlder).toBe(false);
    fake.add(c, texts(3, "x"));
    expect((await chat.reopen()).hasOlder).toBe(true);
    chat.newConversation();
    expect(chat.getState()).toMatchObject({ conversation: null, hasOlder: false });
    await chat.signOut();
    expect(chat.getState()).toMatchObject({ hasOlder: false, conversationList: null });
  });

  it("lists the user's conversations a page at a time, most recently active first, with their titles, changing nothing in the state", async () => {
    const fake = new FakeChat();
    fake.conversationList = true;
    const convs = texts(25).map((t) => fake.conversation("alice", "", ["  Where\n\n is " + t + "?  ", "Here."]));
    fake.conversation("bob", "", ["bob's"]);
    const { chat, states } = setup({ token: ALICE }, fake);
    await chat.open();
    const n = states.length;
    const first = await done(chat.listConversations());
    expect(first.hasMore).toBe(true);
    expect(first.conversations.map((c) => c.id)).toEqual(convs.slice(5).reverse().map((c) => c.id));
    expect(first.conversations[0]).toEqual({ id: convs[24].id, createdAt: AT, updatedAt: AT, endedAt: null, title: "Where is m25?" });
    const rest = await done(chat.listConversations({ before: first.conversations[19] }));
    expect(rest.hasMore).toBe(false);
    expect(rest.conversations.map((c) => c.id)).toEqual(convs.slice(0, 5).reverse().map((c) => c.id));
    expect((await done(chat.listConversations({ before: convs[5].id }))).conversations).toEqual(rest.conversations);
    const base = "/chat/v1/conversations";
    const lists = fake.requests("GET").filter((s) => s.path === base || s.path.startsWith(base + "?"));
    expect(lists.map((s) => s.path)).toEqual([base, base + "?before=" + convs[5].id, base + "?before=" + convs[5].id]);
    expect(states).toHaveLength(n);
    expect(chat.getState().conversation!.id).toBe(convs[24].id);
  });

  it("opens the session first when needed, and lists as the session's user", async () => {
    for (const keepsCookie of [true, false]) {
      const fake = new FakeChat();
      fake.conversationList = true;
      fake.keepsCookie = keepsCookie;
      fake.conversation("alice", "", ["hi"]);
      const { chat } = setup({ token: ALICE }, fake);
      expect((await done(chat.listConversations())).conversations.map((c) => c.title)).toEqual(["hi"]);
      expect(chat.getState().status).toBe("ready");
      expect(fake.requests("GET", "/chat/v1/conversations")[0].auth).toBe(keepsCookie ? null : "Bearer " + ALICE);
    }
  });

  it("refuses a list where the chat keeps none: without a request once its session says so, or as the chat says", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    expect(await fails(chat.listConversations())).toMatchObject({ code: "conversation_list_off", status: 0, retryable: false });
    expect(fake.requests("GET", "/chat/v1/conversations")).toHaveLength(0);
    expect(chat.getState().status).toBe("ready");
    fake.conversationList = true;
    await chat.reopen({ token: ALICE });
    fake.conversationList = false; // turned off since the session said
    expect(await fails(chat.listConversations())).toMatchObject({ code: "conversation_list_off", status: 403 });
    expect(chat.getState().conversationList).toBe(true);
    fake.conversationList = true;
    const hers = fake.conversation("bob", "", ["hers"]);
    expect(await fails(chat.listConversations({ before: hers.id }))).toMatchObject({ code: "not_found", status: 404 });
  });

  it("checks the arguments of listConversations, openConversation and deleteConversation, changing nothing", async () => {
    const fake = new FakeChat();
    fake.conversation("alice", "", ["hi"]);
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    const n = fake.seen.length;
    expect(() => chat.listConversations(null as never)).toThrow(TypeError);
    expect(() => chat.listConversations({ befor: "c1" } as never)).toThrow(/unknown option befor/);
    for (const before of [null, 1, "", {}]) expect(() => chat.listConversations({ before } as never)).toThrow(TypeError);
    expect(() => chat.listConversations({ signal: {} } as never)).toThrow(TypeError);
    for (const c of [undefined, null, "", 7, {}, { id: "" }]) {
      expect(() => chat.openConversation(c as never)).toThrow(TypeError);
      expect(() => chat.deleteConversation(c as never)).toThrow(TypeError);
    }
    expect(fake.seen).toHaveLength(n);
    expect(shown(chat)).toEqual(["hi"]);
  });

  it("shows a conversation it opens in place of the one shown, its last 20 messages, and sends the next message there", async () => {
    const fake = new FakeChat();
    fake.conversationList = true;
    const a = fake.conversation("alice", "", texts(25, "a"));
    const b = fake.conversation("alice", "", ["b1", "b2"]);
    const { chat } = setup({ token: ALICE }, fake);
    expect((await chat.open()).conversation!.id).toBe(b.id);
    const r = await done(chat.openConversation(a.id));
    expect(r.conversation).toEqual({ id: a.id, createdAt: AT, updatedAt: AT, endedAt: null });
    expect(chat.getState()).toMatchObject({ conversation: r.conversation, hasOlder: true, answering: false, outgoing: null, error: null });
    expect(shown(chat)).toEqual(texts(25, "a").slice(5));
    ok(await chat.send("more"));
    expect(fake.requests("POST", "/chat/v1/conversations/" + a.id + "/messages")).toHaveLength(1);
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(0);
    expect(shown(chat).slice(-3)).toEqual(["a25", "more", "Hello"]);
    expect(a.messages.map((m) => m.text).slice(-2)).toEqual(["more", "Hello"]);

    const [top, next] = (await done(chat.listConversations())).conversations; // a moved to the top
    expect([top.id, next.id]).toEqual([a.id, b.id]);
    await done(chat.openConversation(next));
    expect(chat.getState()).toMatchObject({ conversation: { id: b.id }, hasOlder: false });
    expect(chat.getState().conversation).not.toHaveProperty("title");
    expect(shown(chat)).toEqual(["b1", "b2"]);
  });

  it("watches an answer still being written in the conversation it opens", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const a = fake.conversation("alice", "", ["q1", "a1", "q2"]);
    fake.conversation("alice", "", ["latest"]);
    a.answering = 1;
    a.pending = "a2";
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    await done(chat.openConversation(a.id));
    expect(chat.getState()).toMatchObject({ conversation: { id: a.id }, answering: true });
    expect(err(await chat.send("more")).code).toBe("busy");
    await vi.advanceTimersByTimeAsync(7000);
    expect(chat.getState().answering).toBe(false);
    expect(shown(chat)).toEqual(["q1", "a1", "q2", "a2"]);
  });

  it("opens a conversation on a page that hasn't opened the chat, never showing or watching the latest", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const a = fake.conversation("alice", "", ["a1", "a2"]);
    const b = fake.conversation("alice", "", ["b1"]);
    b.answering = 50;
    const { chat, states } = setup({ token: ALICE }, fake);
    await done(chat.openConversation(a.id));
    expect(chat.getState()).toMatchObject({ status: "ready", conversation: { id: a.id }, answering: false });
    expect(shown(chat)).toEqual(["a1", "a2"]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(states.some((s) => s.conversation !== null && s.conversation.id === b.id)).toBe(false);
    expect(fake.requests("GET", "/chat/v1/conversations/" + b.id)).toHaveLength(0);
  });

  it("keeps what's shown, resolving aborted, when newConversation, a later openConversation or a message comes first", async () => {
    const fake = new FakeChat();
    fake.conversationList = true;
    const a = fake.conversation("alice", "", ["a1"]);
    const b = fake.conversation("alice", "", ["b1"]);
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        if (/\/conversations\/c\d+$/.test(String(u)) && i?.method === "GET") await new Promise((r) => setTimeout(r, 20));
        return fake.fetch(u, i);
      },
    });
    await chat.open();
    const first = chat.openConversation(a.id);
    expect(shown(chat)).toEqual(["b1"]); // until a is read
    chat.newConversation();
    expect((await fails(first)).code).toBe("aborted");
    expect(chat.getState()).toMatchObject({ conversation: null, messages: [] });

    const toA = chat.openConversation(a.id);
    const toB = chat.openConversation(b.id); // ended by newConversation, and readable where the chat lists them
    expect((await fails(toA)).code).toBe("aborted");
    expect((await done(toB)).conversation).toMatchObject({ id: b.id, endedAt: "2026-11-17T00:00:00Z" });
    expect(shown(chat)).toEqual(["b1"]);

    const late = chat.openConversation(a.id);
    const sent = chat.send("more");
    ok(await sent);
    expect((await fails(late)).code).toBe("aborted");
    expect(chat.getState().conversation).toMatchObject({ id: b.id, endedAt: null }); // the message reopened it
    expect(shown(chat)).toEqual(["b1", "more", "Hello"]);
    expect(b.ended).toBeNull();
  });

  it("says not_found for a conversation that isn't the user's, keeping the one shown", async () => {
    const fake = new FakeChat();
    const hers = fake.conversation("bob", "", ["secret"]);
    const mine = fake.conversation("alice", "", ["mine"]);
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    expect(await fails(chat.openConversation(hers.id))).toMatchObject({ code: "not_found", status: 404 });
    expect(chat.getState()).toMatchObject({ conversation: { id: mine.id }, hasOlder: false, error: null });
    expect(shown(chat)).toEqual(["mine"]);
    ok(await chat.send("next"));
    expect(fake.requests("POST", "/chat/v1/conversations/" + mine.id + "/messages")).toHaveLength(1);
  });

  it("adds the messages before the oldest shown, 20 at a time, until none are left", async () => {
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", texts(45));
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    const kept = chat.getState().messages;
    const one = await done(chat.loadOlder());
    expect(one.messages.map((m) => m.text)).toEqual(texts(45).slice(5, 25));
    expect(chat.getState().hasOlder).toBe(true);
    expect(chat.getState().messages.slice(20).every((m, i) => m === kept[i])).toBe(true);
    const two = await done(chat.loadOlder());
    expect(two.messages.map((m) => m.text)).toEqual(texts(5));
    expect(shown(chat)).toEqual(texts(45));
    expect(chat.getState().hasOlder).toBe(false);
    const n = fake.seen.length;
    expect(await chat.loadOlder()).toEqual({ ok: true, messages: [] });
    expect(fake.seen).toHaveLength(n);
    const at = (i: number) => "/chat/v1/conversations/" + c.id + "?before=" + c.messages[i].id;
    expect(older(fake)).toEqual([at(25), at(5)]);
  });

  it("shares one request among calls while one runs, and asks nothing with no conversation shown", async () => {
    const fake = new FakeChat();
    fake.conversation("alice", "", texts(30));
    const { chat } = setup({ token: ALICE }, fake);
    const { loadOlder } = chat;
    expect(await loadOlder()).toEqual({ ok: true, messages: [] }); // nothing shown yet
    expect(fake.seen).toHaveLength(0);
    await chat.open();
    const [x, y] = await Promise.all([loadOlder(), loadOlder()]);
    expect(x).toBe(y);
    expect((await done(Promise.resolve(x))).messages).toHaveLength(10);
    expect(older(fake)).toHaveLength(1);
    expect(shown(chat)).toEqual(texts(30));
    chat.newConversation();
    const n = fake.seen.length;
    expect(await loadOlder()).toEqual({ ok: true, messages: [] });
    expect(fake.seen).toHaveLength(n);
  });

  it("takes a page that brings nothing older for the end, whatever the chat says", async () => {
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", texts(25));
    const empty = { conversation: { id: c.id, created_at: AT, updated_at: AT }, messages: [], has_more: true, answering: false };
    const chat = createChat({ url: ORIGIN, token: ALICE, fetch: async (u, i) => (String(u).includes("?before=") ? json(200, empty) : fake.fetch(u, i)) });
    expect((await chat.open()).hasOlder).toBe(true);
    expect(await chat.loadOlder()).toEqual({ ok: true, messages: [] });
    expect(chat.getState().hasOlder).toBe(false);
    expect(shown(chat)).toEqual(texts(25).slice(5));
  });

  it("adds nothing, resolving aborted, when the conversation shown changes meanwhile", async () => {
    const fake = new FakeChat();
    const a = fake.conversation("alice", "", texts(25, "a"));
    fake.conversation("alice", "", texts(25, "b"));
    const chat = createChat({
      url: ORIGIN,
      token: ALICE,
      fetch: async (u, i) => {
        if (String(u).includes("?before=")) await new Promise((r) => setTimeout(r, 20));
        return fake.fetch(u, i);
      },
    });
    await chat.open();
    const p = chat.loadOlder();
    await done(chat.openConversation(a.id));
    expect((await fails(p)).code).toBe("aborted");
    expect(shown(chat)).toEqual(texts(25, "a").slice(5));
    expect(chat.getState().hasOlder).toBe(true);
    const q = chat.loadOlder();
    chat.newConversation();
    expect((await fails(q)).code).toBe("aborted");
    expect(chat.getState()).toMatchObject({ messages: [], hasOlder: false });
  });

  it("keeps the older messages it loaded when the conversation shown is read again, as after a lost stream", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.conversation("alice", "", texts(25));
    fake.turns.push({ deltas: ["Hel"], text: "Hello there", drop: "after-deltas", pollsAnswering: 1 });
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    await done(chat.loadOlder());
    const oldest = chat.getState().messages[0];
    expect(chat.getState().hasOlder).toBe(false);
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ok(await p).message.text).toBe("Hello there");
    expect(shown(chat)).toEqual([...texts(25), "q", "Hello there"]);
    expect(chat.getState().messages[0]).toBe(oldest);
    expect(chat.getState().hasOlder).toBe(false);
    expect(fake.requests("GET").filter((s) => /\/conversations\/c\d+$/.test(s.path)).length).toBeGreaterThan(1);
  });

  it("drops older messages a read of the conversation shown doesn't reach back to, for loadOlder to bring", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", ["a1", "a2"]);
    fake.turns.push({ drop: "after-message", text: "Late", pollsAnswering: 0 });
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    expect(chat.getState().hasOlder).toBe(false);
    fake.add(c, texts(25, "x")); // another tab's
    const p = chat.send("q");
    await vi.advanceTimersByTimeAsync(10_000);
    ok(await p);
    expect(shown(chat)).toEqual([...texts(25, "x").slice(7), "q", "Late"]);
    expect(chat.getState().hasOlder).toBe(true);
    expect((await done(chat.loadOlder())).messages.map((m) => m.text)).toEqual(["a1", "a2", ...texts(7, "x")]);
    expect(shown(chat)).toEqual(["a1", "a2", ...texts(25, "x"), "q", "Late"]);
    expect(chat.getState().hasOlder).toBe(false);
  });

  it("keeps nothing of the conversation shown when the session opens again onto another, or someone else's", async () => {
    const fake = new FakeChat();
    const a = fake.conversation("alice", "", texts(25, "a"));
    const b = fake.conversation("alice", "", texts(25, "b"));
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    await chat.open();
    await done(chat.openConversation(a.id));
    await done(chat.loadOlder());
    expect(chat.getState()).toMatchObject({ conversation: { id: a.id }, hasOlder: false });
    const st = await chat.reopen();
    expect(st).toMatchObject({ conversation: { id: b.id }, hasOlder: true });
    expect(st.messages.map((m) => m.text)).toEqual(texts(25, "b").slice(5));

    await done(chat.loadOlder());
    expect(chat.getState().hasOlder).toBe(false);
    const hers = fake.conversation("bob", "", texts(30, "h"));
    for (const s of fake.sessions.values()) s.alive = false;
    fake.tokenAnswers.push({ status: 200, body: { token: BOB } });
    expect(err(await chat.send("alice's draft")).code).toBe("session_expired");
    expect(chat.getState()).toMatchObject({ conversation: { id: hers.id }, hasOlder: true });
    expect(shown(chat)).toEqual(texts(30, "h").slice(10));
  });

  it("shows nothing older once a start goes on in another conversation, or the one shown is gone", async () => {
    const fake = new FakeChat();
    fake.startPrompt = "Sum up.";
    fake.conversation("alice", "", texts(25));
    const { chat } = setup({ token: ALICE }, fake);
    expect((await chat.open()).hasOlder).toBe(true);
    fake.conversation("alice", "", ["another tab's"]);
    ok(await chat.start());
    expect(chat.getState().hasOlder).toBe(false);
    expect(shown(chat)).toEqual(["Hello"]);

    const gone = new FakeChat();
    gone.conversation("alice", "", texts(25));
    const g = setup({ token: ALICE }, gone);
    expect((await g.chat.open()).hasOlder).toBe(true);
    gone.convs.clear();
    expect(err(await g.chat.send("q")).code).toBe("not_found");
    expect(g.chat.getState()).toMatchObject({ conversation: null, messages: [], hasOlder: false });
  });

  it("reads when a conversation was ended, null while it isn't and from a chat that doesn't say", async () => {
    const fake = new FakeChat();
    fake.conversationList = true;
    const over = fake.conversation("alice", "", ["over"]);
    over.ended = "2026-11-16T10:00:00Z";
    const going = fake.conversation("alice", "", ["going on"]);
    const { chat } = setup({ token: ALICE }, fake);
    expect((await chat.open()).conversation).toEqual({ id: going.id, createdAt: AT, updatedAt: AT, endedAt: null });
    const listed = (await done(chat.listConversations())).conversations;
    expect(listed.map((c) => [c.title, c.endedAt])).toEqual([["going on", null], ["over", "2026-11-16T10:00:00Z"]]);
    const older = { id: "c1", created_at: AT, updated_at: AT };
    const old = createChat({ url: ORIGIN, fetch: async () => json(200, { anonymous: true, started: false, conversation: older, messages: [], answering: false }) });
    expect((await old.open()).conversation).toEqual({ id: "c1", createdAt: AT, updatedAt: AT, endedAt: null });
  });

  it("ends the conversation shown: shows none at once, and sends the end with keepalive, so no page shows it again", async () => {
    for (const keepsCookie of [true, false]) {
      const fake = new FakeChat();
      fake.keepsCookie = keepsCookie;
      const { chat } = setup({ token: ALICE }, fake);
      ok(await chat.send("one"));
      const id = chat.getState().conversation!.id;
      const p = chat.endConversation();
      expect(chat.getState()).toMatchObject({ status: "ready", conversation: null, messages: [], hasOlder: false, answering: false, outgoing: null, error: null });
      await expect(p).resolves.toBeUndefined();
      const [end, ...more] = fake.requests("POST", "/chat/v1/conversations/" + id + "/end");
      expect(more).toHaveLength(0);
      expect(end.init).toMatchObject({ keepalive: true, credentials: "include" });
      // No body, and with the cookie no bearer: nothing a preflight would have to clear first.
      expect([end.body, end.headers.get("Content-Type"), end.auth]).toEqual([undefined, null, keepsCookie ? null : "Bearer " + ALICE]);
      expect(fake.convs.get(id)!.ended).not.toBeNull();
      expect((await setup({ token: ALICE }, fake).chat.open()).conversation).toBeNull();
      const n = fake.seen.length;
      await chat.endConversation(); // nothing shown
      expect(fake.seen).toHaveLength(n);
    }
  });

  it("cuts short an answer under way in the conversation it ends", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    ok(await chat.send("one"));
    const id = chat.getState().conversation!.id;
    fake.turns.push({ stall: true });
    const p = chat.send("two");
    await new Promise((r) => setTimeout(r, 10));
    expect(chat.getState().answering).toBe(true);
    await chat.endConversation();
    expect(err(await p).code).toBe("aborted");
    expect(chat.getState()).toMatchObject({ conversation: null, messages: [], answering: false, answer: null, outgoing: null });
    expect(fake.convs.get(id)!.ended).not.toBeNull();
  });

  it("ends the conversation the session opens on when called before it opened, awaiting an opening under way", async () => {
    const fake = new FakeChat();
    const old = fake.conversation("alice", "", ["old"]);
    const { chat, states } = setup({ token: ALICE }, fake);
    await chat.endConversation(); // nothing opening: it settles at once, sending nothing
    expect(fake.seen).toHaveLength(0);
    expect((await chat.open()).conversation).toBeNull();
    expect(states.some((s) => s.messages.length > 0)).toBe(false);
    expect(fake.requests("POST", "/chat/v1/conversations/" + old.id + "/end")).toHaveLength(1);
    expect(old.ended).not.toBeNull();

    const next = fake.conversation("alice", "", ["next"]);
    let release = () => {};
    const fetch = async (u: RequestInfo | URL, i?: RequestInit) => {
      if (String(u).endsWith("/end")) await new Promise<void>((r) => (release = r));
      return fake.fetch(u, i);
    };
    const slow = setup({ token: ALICE, fetch }, fake).chat;
    const opening = slow.open();
    let settled = false;
    const ended = slow.endConversation().then(() => (settled = true));
    expect((await opening).conversation).toBeNull();
    expect(settled).toBe(false); // the end is on its way
    release();
    await ended;
    expect(next.ended).not.toBeNull();
    expect((await setup({ token: ALICE }, fake).chat.open()).conversation).toBeNull();
  });

  it("tries an end again through about a minute while the chat can't be reached or asks to wait, then gives up quietly", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    let tries = 0;
    let offline = 0;
    const fetch = (u: RequestInfo | URL, i?: RequestInit) => {
      if (!String(u).endsWith("/end")) return fake.fetch(u, i);
      tries++;
      return offline-- > 0 ? Promise.reject(new TypeError("offline")) : fake.fetch(u, i);
    };
    const { chat } = setup({ token: ALICE, fetch }, fake);
    ok(await chat.send("one"));
    const first = chat.getState().conversation!.id;
    offline = 2;
    fake.refusals.push({ method: "POST", path: /\/end$/, status: 429, error: "rate_limited", retryAfter: 2, times: 1 });
    let settled = false;
    void chat.endConversation().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4_500);
    expect([tries, settled]).toEqual([3, false]); // at 0, 1 and 3 s
    await vi.advanceTimersByTimeAsync(1_000);
    expect([tries, settled]).toEqual([4, true]); // at 5 s, as the chat said
    expect(fake.convs.get(first)!.ended).not.toBeNull();
    expect(chat.getState().waiting).toBeNull();

    ok(await chat.send("two"));
    const second = chat.getState().conversation!.id;
    fake.refusals.push({ method: "POST", path: /\/end$/, status: 503, error: "overloaded", retryAfter: 5 });
    tries = 0;
    settled = false;
    void chat.endConversation().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(55_500);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(5_000);
    expect([tries, settled]).toEqual([13, true]); // at 0, 5, … 60 s
    await vi.advanceTimersByTimeAsync(120_000);
    expect(tries).toBe(13);
    expect(fake.convs.get(second)!.ended).toBeNull();
  });

  it("gives an end up at once for a refusal waiting won't fix, and tries it no more once the user signs out", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    let tries = 0;
    let offline = false;
    const fetch = (u: RequestInfo | URL, i?: RequestInit) => {
      if (!String(u).endsWith("/end")) return fake.fetch(u, i);
      tries++;
      return offline ? Promise.reject(new TypeError("offline")) : fake.fetch(u, i);
    };
    const { chat } = setup({ token: ALICE, fetch }, fake);
    ok(await chat.send("one"));
    fake.refusals.push({ method: "POST", path: /\/end$/, status: 403, error: "origin_not_allowed", times: 1 });
    await chat.endConversation();
    expect(tries).toBe(1);

    ok(await chat.send("two"));
    offline = true;
    tries = 0;
    let settled = false;
    void chat.endConversation().then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2_000);
    expect([tries, settled]).toEqual([2, false]);
    await chat.signOut();
    await vi.advanceTimersByTimeAsync(60_000);
    expect([tries, settled]).toEqual([2, true]);
  });

  it("ends as the session's user, opening the session again once when it lapsed", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ tokenUrl: TOKEN_URL }, fake);
    ok(await chat.send("one"));
    const id = chat.getState().conversation!.id;
    for (const s of fake.sessions.values()) s.alive = false;
    await chat.endConversation();
    expect(fake.requests("POST", "/chat/v1/conversations/" + id + "/end")).toHaveLength(2);
    expect(fake.convs.get(id)!.ended).not.toBeNull();
    expect(chat.getState()).toMatchObject({ status: "ready", anonymous: false, conversation: null });
  });

  it("ends nothing when it opens another conversation, and keeps the one shown when the read fails", async () => {
    const fake = new FakeChat();
    const a = fake.conversation("alice", "", ["a1"]);
    const b = fake.conversation("alice", "", ["b1"]);
    let offline = false;
    const fetch = (u: RequestInfo | URL, i?: RequestInit) => (offline ? Promise.reject(new TypeError("offline")) : fake.fetch(u, i));
    const { chat } = setup({ token: ALICE, fetch }, fake);
    await chat.open();
    offline = true;
    expect(await fails(chat.openConversation(a.id))).toMatchObject({ code: "network" });
    expect(chat.getState()).toMatchObject({ conversation: { id: b.id }, error: null });
    expect(shown(chat)).toEqual(["b1"]);
    offline = false;
    await done(chat.openConversation(a.id));
    expect(shown(chat)).toEqual(["a1"]);
    expect(fake.seen.some((s) => s.path.endsWith("/end"))).toBe(false);
    expect(b.ended).toBeNull();
    expect((await chat.reopen({ token: ALICE })).conversation!.id).toBe(b.id); // the latest, still going on
  });

  it("deletes a conversation where the chat lists them, forgetting it when shown, and takes one already gone for deleted", async () => {
    const fake = new FakeChat();
    fake.conversationList = true;
    const a = fake.conversation("alice", "", ["a1"]);
    const b = fake.conversation("alice", "", ["b1"]);
    const { chat } = setup({ token: ALICE }, fake);
    expect(await chat.deleteConversation(a.id)).toEqual({ ok: true }); // opening the session first
    expect(fake.convs.has(a.id)).toBe(false);
    expect(chat.getState()).toMatchObject({ status: "ready", conversation: { id: b.id } });
    expect(await chat.deleteConversation(a.id)).toEqual({ ok: true });
    expect(fake.requests("DELETE", "/chat/v1/conversations/" + a.id)).toHaveLength(2);
    expect(await chat.deleteConversation(chat.getState().conversation!)).toEqual({ ok: true });
    expect(fake.convs.has(b.id)).toBe(false);
    expect(chat.getState()).toMatchObject({ conversation: null, messages: [], hasOlder: false });
    expect(fake.seen.some((s) => s.path.endsWith("/end"))).toBe(false);
    ok(await chat.send("next"));
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
  });

  it("refuses deleting where the chat lists none: without a request once its session says so, or as the chat says", async () => {
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", ["hi"]);
    const { chat } = setup({ token: ALICE }, fake);
    expect(await fails(chat.deleteConversation(c.id))).toMatchObject({ code: "conversation_list_off", status: 0, retryable: false });
    expect(fake.requests("DELETE")).toHaveLength(0);
    expect(chat.getState()).toMatchObject({ status: "ready", conversation: { id: c.id } });
    fake.conversationList = true;
    await chat.reopen({ token: ALICE });
    fake.conversationList = false; // turned off since the session said
    expect(await fails(chat.deleteConversation(c.id))).toMatchObject({ code: "conversation_list_off", status: 403 });
    expect(fake.convs.has(c.id)).toBe(true);
    expect(chat.getState().conversation!.id).toBe(c.id);
  });

  it("says busy while an answer is being written in the conversation, deleting nothing", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.conversationList = true;
    const c = fake.conversation("alice", "", ["q1"]);
    c.answering = 1;
    c.pending = "a1";
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    expect(await fails(chat.deleteConversation(c.id))).toMatchObject({ code: "busy", status: 409, retryable: true });
    expect(chat.getState()).toMatchObject({ conversation: { id: c.id }, answering: true });
    expect(fake.convs.has(c.id)).toBe(true);
    await vi.advanceTimersByTimeAsync(7000);
    expect(chat.getState().answering).toBe(false);
    expect(await chat.deleteConversation(c.id)).toEqual({ ok: true });
    expect(chat.getState().conversation).toBeNull();
  });

  it("forgets the conversation shown once another tab ended it where the chat lists none: reading, sending or following it", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const c = fake.conversation("alice", "", texts(25));
    const [reader, sender, follower, ender] = [1, 2, 3, 4].map(() => setup({ token: ALICE }, fake).chat);
    for (const tab of [reader, sender, ender]) expect((await tab.open()).conversation!.id).toBe(c.id);
    await ender.endConversation();

    expect(await fails(reader.loadOlder())).toMatchObject({ code: "not_found" });
    expect(reader.getState()).toMatchObject({ conversation: null, messages: [], hasOlder: false });

    expect(err(await sender.send("more")).code).toBe("not_found");
    expect(sender.getState()).toMatchObject({ conversation: null, messages: [], outgoing: "more" });
    ok(await sender.send("more"));
    expect(sender.getState().conversation!.id).not.toBe(c.id);
    expect(c.messages).toHaveLength(25);

    const d = fake.conversation("alice", "", ["q"]);
    d.answering = 50;
    expect(await follower.open()).toMatchObject({ conversation: { id: d.id }, answering: true });
    await ender.reopen({ token: ALICE });
    await ender.endConversation();
    await vi.advanceTimersByTimeAsync(4000);
    expect(follower.getState()).toMatchObject({ conversation: null, messages: [], answering: false });
  });

  it("ends a first message's conversation once the chat names it, ended before: unseen, and a send meanwhile unaffected", async () => {
    for (const part of ["answer", "body"] as const) {
      const fake = new FakeChat();
      fake.turns.push({ deltas: ["unseen"] }, { deltas: ["seen"] });
      const g = gated(fake, /\/conversations$/, part);
      const { chat, states } = setup({ token: ALICE, fetch: g.fetch }, fake);
      await chat.open();
      const first = chat.send("first");
      await new Promise((r) => setTimeout(r, 5));
      expect(chat.getState()).toMatchObject({ outgoing: "first", answering: true, conversation: null });
      let settled = false;
      const ended = chat.endConversation().then(() => (settled = true));
      expect(chat.getState()).toMatchObject({ conversation: null, messages: [], outgoing: null, answer: null, answering: false });
      expect(err(await first).code).toBe("aborted"); // at once, as before

      ok(await chat.send("next"));
      const next = chat.getState().conversation!.id;
      const unnamed = Array.from(fake.convs.values()).find((c) => c.id !== next)!;
      expect([unnamed.ended, settled]).toEqual([null, false]);
      g.release();
      await ended;
      expect(unnamed.ended).not.toBeNull();
      expect(fake.convs.get(next)!.ended).toBeNull();
      expect(fake.requests("POST").filter((s) => s.path.endsWith("/end")).map((s) => s.path)).toEqual(["/chat/v1/conversations/" + unnamed.id + "/end"]);
      expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(2);
      expect(chat.getState()).toMatchObject({ conversation: { id: next }, outgoing: null, waiting: null, error: null });
      expect(shown(chat)).toEqual(["next", "seen"]);
      for (const s of states) {
        expect(s.conversation ? s.conversation.id : null).not.toBe(unnamed.id);
        expect(s.answer ? s.answer.text : "").not.toBe("unseen");
        expect(s.messages.map((m) => m.text)).not.toContain("first");
      }
    }
  });

  it("ends a start's new conversation once the chat names it, ended before, unseen", async () => {
    for (const part of ["answer", "body"] as const) {
      const fake = new FakeChat();
      fake.startPrompt = "Greet them.";
      fake.turns.push({ deltas: ["unseen"] }, { deltas: ["seen"] });
      const g = gated(fake, /\/start$/, part);
      const { chat, states } = setup({ token: ALICE, fetch: g.fetch }, fake);
      await chat.open();
      const greeting = chat.start();
      await new Promise((r) => setTimeout(r, 5));
      expect(chat.getState().answering).toBe(true);
      const ended = chat.endConversation();
      expect(err(await greeting).code).toBe("aborted");
      expect(chat.getState()).toMatchObject({ conversation: null, messages: [], answer: null, answering: false });

      ok(await chat.send("next"));
      const next = chat.getState().conversation!.id;
      g.release();
      await ended;
      expect(fake.requests("POST", "/chat/v1/start")[0].body).toMatchObject({ new: true });
      const greeted = Array.from(fake.convs.values()).find((c) => c.id !== next)!;
      expect(greeted.ended).not.toBeNull();
      expect(fake.convs.get(next)!.ended).toBeNull();
      expect(shown(chat)).toEqual(["next", "seen"]);
      expect(states.some((s) => (s.conversation && s.conversation.id === greeted.id) || (s.answer && s.answer.text === "unseen"))).toBe(false);
    }
  });

  it("ends nothing for a first message ended before the chat named a conversation, when it's refused, and never sends it again", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.refusals.push({ method: "POST", path: /\/conversations$/, status: 429, error: "rate_limited", retryAfter: 2, times: 2 });
    const g = gated(fake, /\/conversations$/, "answer");
    const { chat, states } = setup({ token: ALICE, fetch: g.fetch }, fake);
    await chat.open();
    const first = chat.send("first");
    await vi.advanceTimersByTimeAsync(5);
    const ended = chat.endConversation(); // while the message is out
    expect(err(await first).code).toBe("aborted");
    g.release(); // refused: nothing was started
    await ended;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
    expect(states.every((s) => s.waiting === null)).toBe(true);
    expect(chat.getState()).toMatchObject({ conversation: null, outgoing: null, error: null });

    const second = chat.send("second"); // refused too, and ended while it waits to try again
    await vi.advanceTimersByTimeAsync(500);
    expect(chat.getState().waiting).toMatchObject({ code: "rate_limited" });
    await chat.endConversation();
    expect(err(await second).code).toBe("aborted");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(2);
    expect(fake.seen.some((s) => s.path.endsWith("/end"))).toBe(false);
    expect(fake.convs.size).toBe(0);
  });

  it("ends nothing for a first message ended before the chat named a conversation once the user changes meanwhile", async () => {
    const fake = new FakeChat();
    const g = gated(fake, /\/conversations$/, "body");
    const { chat } = setup({ token: ALICE, fetch: g.fetch }, fake);
    await chat.open();
    const first = chat.send("first");
    await new Promise((r) => setTimeout(r, 5));
    const ended = chat.endConversation();
    expect(err(await first).code).toBe("aborted");
    expect((await chat.reopen({ token: BOB })).status).toBe("ready");
    g.release();
    await ended;
    expect(fake.seen.some((s) => s.path.endsWith("/end"))).toBe(false);
    expect(Array.from(fake.convs.values()).map((c) => c.ended)).toEqual([null]);
  });
});

describe("actions", () => {
  const form = {
    id: "a1", initiator: "upstream", kind: "form", server: "Weather", tool: "forecast", title: "Forecast", message: "Which city?",
    fields: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
    status: "pending", expires_at: "2026-11-22T12:00:00Z",
  };
  const url = {
    id: "a2", initiator: "upstream", kind: "url", server: "Keys", tool: "connect", title: "Connect",
    links: [{ url: "https://keys.example/1", message: "Add your key" }], status: "pending",
  };

  it("shows an action while its tool call waits, after the tool's waiting, its status as it changes, and keeps it with the answer", async () => {
    const { chat, fake, states } = setup({ token: ALICE });
    fake.turns.push({ deltas: ["Sunny"], tools: [{ name: "forecast", status: "started", title: "Forecast" }], actions: [form, { ...form, status: "allow" }] });
    const r = ok(await chat.send("Weather?"));
    const waiting = states.find((s) => s.answer && s.answer.actions && s.answer.actions.length && !s.answer.text);
    expect(waiting!.answer!.actions![0]).toMatchObject({ id: "a1", initiator: "upstream", kind: "form", server: "Weather", message: "Which city?", status: "pending", expiresAt: "2026-11-22T12:00:00Z" });
    expect(waiting!.answer!.tools[waiting!.answer!.tools.length - 1]).toMatchObject({ name: "forecast", status: "waiting", title: "Forecast" });
    const decided = states.find((s) => s.answer && s.answer.actions && s.answer.actions[0].status === "allow");
    expect(decided!.answer!.actions).toHaveLength(1);
    expect(r.message.actions![0]).toMatchObject({ id: "a1", fields: form.fields, links: [], done: false, status: "allow" });
  });

  it("moves a tool call from started through waiting to done as one entry, and a second waiting changes nothing", async () => {
    const { chat, fake, states } = setup({ token: ALICE });
    const started = { name: "forecast", status: "started", title: "Forecast" };
    fake.turns.push({ deltas: ["Sunny"], tools: [started], actions: [form, { ...form, status: "allow" }], toolsAfter: [{ ...started, status: "done" }] });
    ok(await chat.send("Weather?"));
    const streamed = states.filter((s) => s.answer && s.answer.text === "Sunny").pop()!;
    expect(streamed.answer!.tools).toEqual([{ name: "forecast", status: "done", title: "Forecast" }]);

    fake.turns.push({ deltas: ["Sunny"], tools: [started], actions: [form, { ...form, id: "a3" }] });
    ok(await chat.send("Again?"));
    const again = states.filter((s) => s.answer && s.answer.text === "Sunny").pop()!;
    expect(again.answer!.tools).toEqual([{ name: "forecast", status: "waiting", title: "Forecast" }]);
  });

  it("keeps the text and tools shown while it follows a lost stream that waits on an action", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    fake.turns.push({ deltas: ["Hel"], text: "Hello there", tools: [{ name: "forecast", status: "started", title: "Forecast" }], actions: [form], drop: "after-deltas", pollsAnswering: 2 });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("Weather?");
    await vi.advanceTimersByTimeAsync(3_500);
    expect(fake.requests("GET").filter((s) => s.path.startsWith("/chat/v1/conversations/"))).toHaveLength(1);
    expect(chat.getState()).toMatchObject({ answering: true, answer: { text: "Hel", tools: [{ name: "forecast", status: "waiting" }], actions: [{ id: "a1", status: "pending" }] } });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(ok(await p).message.text).toBe("Hello there");
    expect(chat.getState()).toMatchObject({ answering: false, answer: null });
  });

  it("follows an answer past ten minutes, and one given up on past sixteen leaves nothing pending", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const first = setup({ token: ALICE }, fake);
    ok(await first.chat.send("Weather?"));
    const c = fake.convs.get(first.chat.getState().conversation!.id)!;
    c.answering = 100_000;
    c.waitingOn = [form];
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    expect(chat.getState()).toMatchObject({ answering: true, answer: { actions: [{ id: "a1", status: "pending" }] } });
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(chat.getState()).toMatchObject({ answering: false, answer: null });
  });

  it("sends the user's response to the conversation shown, and says one no longer pending is closed", async () => {
    const { chat, fake } = setup({ token: ALICE });
    fake.turns.push({ actions: [form] });
    ok(await chat.send("Weather?"));
    const conv = chat.getState().conversation!.id;
    expect(await chat.respondToAction("a1", { action: "accept", content: { city: "Narva" } })).toEqual({ ok: true });
    expect(fake.requests("POST", "/chat/v1/conversations/" + conv + "/actions/a1")[0].body).toEqual({ action: "accept", content: { city: "Narva" } });
    expect(fake.responses.map((x) => x.body)).toEqual([{ action: "accept", content: { city: "Narva" } }]);
    fake.convs.get(conv)!.messages[1].actions![0].status = "allow";
    expect(err(await chat.respondToAction(chat.getState().messages[1].actions![0], { action: "decline" })).code).toBe("action_closed");
    expect(err(await chat.respondToAction("a9", { action: "decline" })).code).toBe("not_found");
  });

  it("shows what an answer it follows waits on, from a page opened while it's written", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const first = setup({ token: ALICE }, fake);
    ok(await first.chat.send("Weather?"));
    const conv = first.chat.getState().conversation!.id;
    const c = fake.convs.get(conv)!;
    c.answering = 2;
    c.waitingOn = [form];
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    expect(chat.getState()).toMatchObject({ answering: true });
    expect(chat.getState().answer!.actions![0]).toMatchObject({ id: "a1", status: "pending" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(chat.getState()).toMatchObject({ answering: false, answer: null });
  });

  it("checks what it's given before anything is sent", () => {
    const { chat } = setup({ token: ALICE });
    expect(() => chat.respondToAction("a1", { action: "maybe" } as never)).toThrow(TypeError);
    expect(() => chat.respondToAction("a1", { action: "accept", content: [] } as never)).toThrow(TypeError);
    expect(() => chat.respondToAction("", { action: "accept" })).toThrow(TypeError);
    expect(() => chat.respondToAction("a1", { action: "accept", other: 1 } as never)).toThrow(TypeError);
  });

  it("opens a URL ask's page from the click in a tab of its own, which responds unless the user says Done", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const { chat, fake } = setup({ token: ALICE });
    fake.turns.push({ actions: [url] });
    const a = ok(await chat.send("Connect it")).message.actions![0];
    expect(a).toMatchObject({ kind: "url", links: [{ url: "https://keys.example/1", message: "Add your key" }], done: false, fields: null });
    expect(() => chat.openActionLink(a, "https://elsewhere.example/")).toThrow(TypeError);
    expect(open).not.toHaveBeenCalled();
    expect(await chat.openActionLink(a, "https://keys.example/1")).toEqual({ ok: true });
    expect(open).toHaveBeenCalledWith("https://keys.example/1", "_blank", "noopener,noreferrer");
    expect(fake.responses.map((x) => x.body)).toEqual([{ action: "accept" }]);
    expect(chat.openActionLink({ ...a, done: true }, "https://keys.example/1")).toBeNull();
    expect(open).toHaveBeenCalledTimes(2);
    expect(fake.responses).toHaveLength(1);
  });

  it("opens only an http or https link, refusing any other without opening or sending anything", async () => {
    const open = vi.fn();
    vi.stubGlobal("window", { open });
    const { chat, fake } = setup({ token: ALICE });
    fake.turns.push({ actions: [url] });
    const a = ok(await chat.send("Connect it")).message.actions![0];
    for (const bad of ["javascript:alert(1)", "data:text/html,<b>x</b>", " https://keys.example/", "//keys.example/", "vbscript:x"]) {
      const r = await chat.openActionLink({ ...a, links: [{ url: bad, message: "" }] }, bad);
      expect(err(r!).code).toBe("bad_request");
    }
    expect(open).not.toHaveBeenCalled();
    expect(fake.responses).toHaveLength(0);
    expect(await chat.openActionLink({ ...a, links: [{ url: "HTTP://keys.example/2", message: "" }] }, "HTTP://keys.example/2")).toEqual({ ok: true });
    expect(open).toHaveBeenCalledTimes(1);
  });
});

describe("stopping", () => {
  it("stops the answer under way, which keeps what it wrote", async () => {
    const fake = new FakeChat();
    fake.turns.push({ deltas: ["Half "], untilStopped: true });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.waitFor(() => expect(chat.getState().answer?.text).toBe("Half "));
    expect(await chat.stop()).toEqual({ ok: true });
    const r = ok(await p);
    expect([r.message.text, r.stop]).toEqual(["Half ", "stopped"]);
    expect(chat.getState()).toMatchObject({ answering: false, answer: null, stop: "stopped", error: null });
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q", "Half "]);
    expect(fake.stops).toEqual([chat.getState().conversation!.id]);
  });

  it("says stopped, showing no error, when the assistant hadn't written anything", async () => {
    const fake = new FakeChat();
    fake.turns.push({ deltas: [], untilStopped: true });
    const { chat } = setup({ token: ALICE }, fake);
    const p = chat.send("q");
    await vi.waitFor(() => expect(chat.getState().messages).toHaveLength(1));
    await chat.stop();
    expect(err(await p).code).toBe("stopped");
    expect(chat.getState()).toMatchObject({ answering: false, answer: null, outgoing: null, stop: "stopped", error: null });
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q"]);
  });

  it("sends nothing when stopped before the message goes, or while it waits to try again, keeping the draft", async () => {
    vi.useFakeTimers();
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    const first = chat.send("q");
    await chat.stop();
    expect(err(await first).code).toBe("stopped");
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(0);

    fake.refusals.push({ method: "POST", path: /\/conversations$/, status: 429, error: "rate_limited", retryAfter: 30, times: 1 });
    const second = chat.send("q");
    await vi.advanceTimersByTimeAsync(100);
    expect(chat.getState().waiting?.code).toBe("rate_limited");
    await chat.stop();
    expect(err(await second).code).toBe("stopped");
    expect(chat.getState()).toMatchObject({ outgoing: "q", waiting: null, answering: false, stop: "stopped", error: null });
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(1);
    expect(fake.stops).toEqual([]);
  });

  it("asks the chat to stop once the stream names a conversation the message was on its way to start", async () => {
    const fake = new FakeChat();
    fake.turns.push({ deltas: ["Half "], untilStopped: true });
    let go!: () => void;
    const held = new Promise<void>((resolve) => (go = resolve));
    const slow: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/conversations") && init?.method === "POST") await held;
      return fake.fetch(input, init);
    };
    const { chat } = setup({ token: ALICE, fetch: slow }, fake);
    await chat.open();
    const p = chat.send("q");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await chat.stop()).toEqual({ ok: true });
    expect(fake.stops).toEqual([]);
    go();
    expect(ok(await p).stop).toBe("stopped");
    expect(fake.stops).toEqual([chat.getState().conversation!.id]);
  });

  it("stops an answer it follows but didn't start, and asks nothing when none is being written", async () => {
    const fake = new FakeChat();
    const { chat } = setup({ token: ALICE }, fake);
    await chat.open();
    expect(await chat.stop()).toEqual({ ok: true });
    expect(fake.requests("POST").filter((s) => s.path.endsWith("/stop"))).toHaveLength(0);

    const c = fake.conversation("alice", "", ["q1"]);
    c.pending = "a1";
    const other = setup({ token: ALICE }, fake).chat;
    expect((await other.open()).answering).toBe(true);
    expect(await other.stop()).toEqual({ ok: true });
    expect(fake.stops).toEqual([c.id]);
  });
});
