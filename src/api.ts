import { ChatError, isChatError } from "./errors.js";

export type Fetch = typeof fetch;

export interface Call {
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  type?: string; // the Content-Type of a body sent as it is: a file
  bearer?: string | null;
  signal?: AbortSignal;
  stream?: boolean;
  progress?: (sent: number) => void; // a file's bytes sent, through XMLHttpRequest
}

const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;
const ANSWER_MS = 30_000;
const BODY_CAP = 16 << 20;
const BODY_MS = 180_000; // a whole body beyond its bytes' time at RATE, however they trickle in
const RATE = 32; // bytes per ms, 256 kbit/s: the slowest a file's bytes are given time for

// apiBase is the API's root under the workspace's URL, or under the site's own
// domain when its server forwards /chat/*.
export function apiBase(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new TypeError("url must be an absolute URL");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL.test(u.hostname))) {
    throw new TypeError("url must be an https: URL");
  }
  if (u.username || u.password) throw new TypeError("url must not carry credentials");
  return u.origin + u.pathname.replace(/\/+$/, "") + "/chat/v1";
}

export function aborted(): ChatError {
  return new ChatError("aborted", "Cut short by the page.");
}

// within settles with p, or rejects as aborted when signal aborts, or with
// late() after ms, whether or not p ever settles.
export function within<T>(p: Promise<T>, signal: AbortSignal | undefined, ms: number, late: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal && signal.aborted) return reject(aborted());
    const stop = () => {
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      stop();
      reject(aborted());
    };
    const t = setTimeout(() => {
      stop();
      reject(late());
    }, ms);
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        stop();
        resolve(v);
      },
      (e) => {
        stop();
        reject(e);
      },
    );
  });
}

// timed fetches until an answer starts, within ms. It holds no listener once
// settled: a body is read to its end, or its reader cancelled.
export async function timed(fetchFn: Fetch, url: string, init: RequestInit, signal?: AbortSignal, ms = ANSWER_MS): Promise<Response> {
  if (signal && signal.aborted) throw aborted();
  const ctrl = new AbortController();
  const p = new Promise<Response>((resolve, reject) => {
    try {
      fetchFn(url, { ...init, signal: ctrl.signal }).then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
  try {
    return await within(p, signal, ms, late);
  } catch (e) {
    ctrl.abort();
    p.then(discard, () => {});
    if (isChatError(e)) throw e;
    // No cause: a fetch error may quote a header, and so a token.
    throw new ChatError("network", "Couldn't connect.");
  }
}

// request makes one call with the browser's cookies for the chat's host. Only
// Authorization and Content-Type go beyond the safelisted headers: CORS allows no more.
export function request(fetchFn: Fetch, base: string, c: Call): Promise<Response> {
  const headers: Record<string, string> = { Accept: c.stream ? "text/event-stream" : "application/json" };
  if (c.body !== undefined) headers["Content-Type"] = c.type || "application/json";
  if (c.bearer) headers.Authorization = "Bearer " + c.bearer;
  // The API never redirects, and an old browser would forward Authorization across origins.
  const init: RequestInit = { method: c.method, headers, credentials: "include", cache: "no-store", redirect: "error" };
  if (c.body !== undefined) init.body = c.type ? (c.body as Blob) : JSON.stringify(c.body);
  if (!c.type) return timed(fetchFn, base + c.path, init, c.signal);
  if (c.progress && typeof XMLHttpRequest == "function") return upload(base + c.path, init, c.progress, c.signal);
  // A file's answer starts once all of it is sent.
  return timed(fetchFn, base + c.path, init, c.signal, ANSWER_MS + (c.body as Blob).size / RATE);
}

// upload sends a file with XMLHttpRequest, whose upload reports progress, and
// answers a Response. ANSWER_MS without progress either way gives up.
function upload(url: string, init: RequestInit, progress: (sent: number) => void, signal?: AbortSignal): Promise<Response> {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(aborted());
    const x = new XMLHttpRequest();
    let t: ReturnType<typeof setTimeout> | undefined;
    const end = (e?: ChatError) => {
      clearTimeout(t);
      if (signal) signal.removeEventListener("abort", stop);
      if (e) {
        x.abort();
        reject(e);
      }
    };
    const stop = () => end(aborted());
    const alive = () => {
      clearTimeout(t);
      t = setTimeout(() => end(late()), ANSWER_MS);
    };
    x.open(init.method as string, url);
    x.withCredentials = true;
    const h = init.headers as Record<string, string>;
    for (const k in h) x.setRequestHeader(k, h[k]);
    x.upload.onprogress = (e) => {
      alive();
      progress(e.loaded);
    };
    x.onprogress = alive;
    x.onerror = () => end(new ChatError("network", "Couldn't connect."));
    x.onload = () => {
      end();
      try {
        resolve(new Response(x.responseText, { status: x.status, headers: { "Retry-After": x.getResponseHeader("Retry-After") || "" } }));
      } catch {
        reject(new ChatError("protocol", "The chat's answer couldn't be read.", { status: x.status }));
      }
    };
    if (signal) signal.addEventListener("abort", stop, { once: true });
    alive();
    x.send(init.body as Blob);
  });
}

function late(): ChatError {
  return new ChatError("network", "No answer came in time.");
}

export function discard(res: Response): void {
  if (res.body && !res.body.locked) res.body.cancel().catch(() => {});
}

// chunks reads a body of at most BODY_CAP bytes, giving up when signal aborts,
// no bytes come for ANSWER_MS, or BODY_MS pass beyond their time at RATE; it's
// then cancelled, so a page that moved on never gets it. Cut short is network.
export async function chunks(res: Response, signal?: AbortSignal): Promise<Uint8Array<ArrayBuffer>[]> {
  const stream = res.body;
  if (!stream) {
    let b: ArrayBuffer;
    try {
      b = await within(res.arrayBuffer(), signal, ANSWER_MS, stalled);
    } catch (e) {
      throw isChatError(e) ? e : new ChatError("network", "The answer was cut short.");
    }
    if (b.byteLength > BODY_CAP) throw new ChatError("protocol", "The chat's answer is too large.", { status: res.status });
    return [new Uint8Array(b)];
  }
  const reader = stream.getReader();
  const out: Uint8Array<ArrayBuffer>[] = [];
  const began = Date.now();
  let n = 0;
  try {
    for (;;) {
      let r: ReadableStreamReadResult<Uint8Array<ArrayBuffer>>;
      try {
        r = await within(reader.read(), signal, Math.max(0, Math.min(ANSWER_MS, began + BODY_MS + n / RATE - Date.now())), stalled);
      } catch (e) {
        throw isChatError(e) ? e : new ChatError("network", "The answer was cut short.");
      }
      if (r.done) return out;
      n += r.value.length;
      if (n > BODY_CAP) throw new ChatError("protocol", "The chat's answer is too large.", { status: res.status });
      out.push(r.value);
    }
  } catch (e) {
    reader.cancel().catch(() => {});
    throw e;
  }
}

// body reads a JSON body: cut short is network; not JSON, protocol.
export async function body(res: Response, signal?: AbortSignal): Promise<unknown> {
  const d = new TextDecoder();
  let text = "";
  for (const c of await chunks(res, signal)) text += d.decode(c, { stream: true });
  text += d.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw new ChatError("protocol", "The chat's answer couldn't be read.", { status: res.status });
  }
}

function stalled(): ChatError {
  return new ChatError("network", "The answer stalled.");
}

// readJSON keeps no cause: a parser's message quotes the body, which may hold a session token.
export function readJSON(res: Response, signal?: AbortSignal): Promise<unknown> {
  return body(res, signal);
}

// failure is the ChatError a refused request carries.
export async function failure(res: Response, signal?: AbortSignal): Promise<ChatError> {
  let code = "";
  let message = "";
  try {
    const b = (await body(res, signal)) as { error?: unknown; message?: unknown } | null;
    if (b && typeof b.error === "string") code = b.error;
    if (b && typeof b.message === "string") message = b.message;
  } catch {
    if (signal && signal.aborted) return aborted();
  }
  if (!code) code = res.status === 429 ? "rate_limited" : res.status >= 500 ? "internal" : "protocol";
  return new ChatError(code, message || "The chat refused the request (" + res.status + ").", {
    status: res.status,
    retryAfter: retryAfter(res),
  });
}

// retryAfter reads Retry-After in seconds, from a number or an HTTP date.
export function retryAfter(res: Response): number | null {
  const v = res.headers.get("Retry-After");
  if (!v) return null;
  const s = v.trim();
  if (/^\d+$/.test(s)) return Number(s);
  const at = Date.parse(s);
  if (isNaN(at)) return null;
  return Math.max(0, Math.ceil((at - Date.now()) / 1000));
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(aborted());
    const stop = () => {
      clearTimeout(t);
      reject(aborted());
    };
    const t = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}
