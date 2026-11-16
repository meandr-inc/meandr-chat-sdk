import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatError, createChat, isChatError } from "../src/index";
import { claimsOf } from "../src/token";
import type { ChatOptions, ChatState, SendResult } from "../src/types";
import { ALICE, BOB, FakeChat, ORIGIN, TOKEN_URL, ev, json, jwt } from "./fake";

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

function err(r: SendResult) {
  if (r.ok) throw new Error("expected a failure");
  return r.error;
}

const sessionPaths = (fake: FakeChat) => fake.seen.filter((s) => s.path === "/chat/v1/session").map((s) => s.method);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(fake.requests("POST", "/chat/v1/conversations")[0].body).toEqual({ text: "Where is it?" });
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

  it("starts a new conversation after newConversation", async () => {
    const { chat, fake } = setup({ token: ALICE });
    ok(await chat.send("one"));
    chat.newConversation();
    expect(chat.getState().conversation).toBeNull();
    expect(chat.getState().messages).toEqual([]);
    ok(await chat.send("two"));
    expect(fake.requests("POST", "/chat/v1/conversations")).toHaveLength(2);
  });

  it("opens with no conversation after newConversation before opening", async () => {
    const fake = new FakeChat();
    fake.conversation("alice", "", ["old"]);
    const { chat } = setup({ token: ALICE }, fake);
    chat.newConversation();
    const st = await chat.open();
    expect(st.conversation).toBeNull();
    expect(st.messages).toEqual([]);
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
        let at = 0;
        const body = new ReadableStream<Uint8Array>({
          pull: (c) =>
            new Promise<void>((r) =>
              setTimeout(() => {
                if (at >= bytes.length) c.close();
                else c.enqueue(bytes.slice(at, (at += 8)));
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
    const who = (t: string) => claimsOf(t)!.who;
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
    const { open, send, getState, subscribe, newConversation } = chat;
    subscribe(() => {});
    await open();
    ok(await send("q"));
    newConversation();
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

  it("opens, has the assistant speak, and shows its answer alone, sending nothing of the page's", async () => {
    const fake = new FakeChat();
    fake.startPrompt = "Greet them.";
    const { chat } = setup({ token: ALICE }, fake);
    expect(ok(await chat.start()).message.text).toBe("Hello");
    expect(chat.getState()).toMatchObject({ status: "ready", answering: false, answer: null, outgoing: null });
    expect(chat.getState().messages.map((m) => [m.role, m.text])).toEqual([["assistant", "Hello"]]);
    expect(fake.requests("POST", "/chat/v1/start")[0].body).toEqual({ new: true }); // no conversation shown
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
      expect(fake.requests("POST", "/chat/v1/start")[0].body).toEqual({ new: true });
    }
  });

  it("goes on in the conversation shown, keeping its messages, or opens a new one when the chat says so", async () => {
    const fake = new FakeChat();
    fake.startPrompt = "Say what needs attention.";
    const { chat } = setup({ token: ALICE }, fake);
    ok(await chat.send("q"));
    const conv = chat.getState().conversation!.id;
    fake.turns.push({ deltas: ["Nothing", " does"] });
    ok(await chat.start());
    expect(chat.getState().conversation!.id).toBe(conv);
    expect(chat.getState().messages.map((m) => m.text)).toEqual(["q", "Hello", "Nothing does"]);
    fake.startNew = true;
    ok(await chat.start());
    expect(chat.getState().conversation!.id).not.toBe(conv);
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
