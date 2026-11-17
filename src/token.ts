import { aborted, body, type Fetch, timed, within } from "./api.js";
import { ChatError, isChatError } from "./errors.js";
import type { ChatOptions, TokenSource } from "./types.js";

const TOKEN_MS = 30_000;

// Secret holds a token behind a function, so logging the client or its state
// never prints one.
export type Secret = () => string;

export function hide(token: string): Secret {
  return () => token;
}

// Way is how the page names its user.
export type Way =
  | { kind_: "none" }
  | { kind_: "token"; token: Secret | null }
  | { kind_: "url"; url: string }
  | { kind_: "fn"; fn: TokenSource };

export function wayOf(o: ChatOptions): Way {
  for (const k of ["token", "tokenUrl", "getToken"] as const) {
    if (k in o && o[k] === undefined) throw new TypeError(k + " is undefined: omit it, or null for nobody");
  }
  const given = [o.token, o.tokenUrl, o.getToken].filter((v) => v !== undefined).length;
  if (given > 1) throw new TypeError("at most one of token, tokenUrl, getToken");
  if (o.token !== undefined) return tokenWay(o.token);
  if (o.tokenUrl !== undefined) {
    if (typeof o.tokenUrl !== "string" || o.tokenUrl === "") throw new TypeError("tokenUrl must be an address");
    return { kind_: "url", url: o.tokenUrl };
  }
  if (o.getToken !== undefined) {
    if (typeof o.getToken !== "function") throw new TypeError("getToken must be a function");
    return { kind_: "fn", fn: o.getToken };
  }
  return { kind_: "none" };
}

export function tokenWay(token: unknown): Way {
  if (token === null) return { kind_: "token", token: null };
  if (typeof token === "string" && usable(token)) return { kind_: "token", token: hide(token) };
  throw new TypeError("token must be a token or null");
}

// usable: a token travels in a header, so it's printable ASCII without spaces.
function usable(token: string): boolean {
  if (token === "") return false;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    if (c < 33 || c > 126) return false;
  }
  return true;
}

export function renews(way: Way): boolean {
  return way.kind_ === "url" || way.kind_ === "fn";
}

// userToken is the page's user's token: undefined when the page gives no way,
// null when nobody is signed in. A failure is token_failed, never a sign-out.
export async function userToken(way: Way, fetchFn: Fetch, signal: AbortSignal, expired: boolean): Promise<string | null | undefined> {
  switch (way.kind_) {
    case "none":
      return undefined;
    case "token":
      return way.token ? way.token() : null;
    case "url":
      return fromURL(way.url, fetchFn, signal);
    case "fn":
      return fromFunction(way.fn, signal, expired);
  }
}

async function fromURL(url: string, fetchFn: Fetch, signal: AbortSignal): Promise<string | null> {
  let res: Response;
  try {
    const init: RequestInit = { method: "GET", headers: { Accept: "application/json" }, credentials: "include", cache: "no-store" };
    res = await timed(fetchFn, url, init, signal);
  } catch {
    if (signal.aborted) throw aborted();
    throw new ChatError("token_failed", "The token couldn't be fetched.");
  }
  if (res.status === 401 || res.status === 403) return null;
  if (!res.ok) throw new ChatError("token_failed", "tokenUrl answered " + res.status + ".", { status: res.status });
  let v: unknown;
  try {
    v = await body(res, signal);
  } catch {
    // No cause: a parser's message quotes the body, which may hold a token.
    if (signal.aborted) throw aborted();
    throw new ChatError("token_failed", "tokenUrl didn't answer JSON.", { status: res.status });
  }
  const token = v && typeof v === "object" ? (v as { token?: unknown }).token : undefined;
  if (token === null || (typeof token === "string" && usable(token))) return token;
  throw new ChatError("token_failed", 'tokenUrl must answer {"token": token or null}.', { status: res.status });
}

async function fromFunction(fn: TokenSource, signal: AbortSignal, expired: boolean): Promise<string | null> {
  let token: unknown;
  try {
    const p = new Promise<unknown>((resolve) => resolve(fn({ expired, signal })));
    token = await within(p, signal, TOKEN_MS, () => new ChatError("token_failed", "getToken didn't answer in time."));
  } catch (e) {
    if (signal.aborted) throw aborted();
    if (isChatError(e) && e.code === "token_failed") throw e;
    throw new ChatError("token_failed", "getToken failed.", { cause: e });
  }
  if (signal.aborted) throw aborted();
  if (token === null || (typeof token === "string" && usable(token))) return token;
  throw new ChatError("token_failed", "getToken must return a token or null.");
}

// Claims are what the client reads from a token, unverified: where it may go
// and whom it names. The chat checks the signature.
export interface Claims {
  aud: string[];
  who_: string;
}

export function claimsOf(token: string): Claims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(b64 + "===".slice((b64.length + 3) % 4));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const c = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    if (!c || typeof c !== "object" || typeof c.sub !== "string") return null;
    const aud = typeof c.aud === "string" ? [c.aud] : Array.isArray(c.aud) ? c.aud.filter((a): a is string => typeof a === "string") : [];
    // The chat takes an empty ext for none.
    const empty = !!c.ext && typeof c.ext === "object" && !Array.isArray(c.ext) && Object.keys(c.ext).length === 0;
    return { aud, who_: "user:" + c.sub + "\n" + canonical(c.ext === undefined || empty ? null : c.ext) };
  } catch {
    return null;
  }
}

// canonical is JSON with sorted keys, so two encodings of one ext compare equal.
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + canonical(o[k])).join(",") + "}";
  }
  return JSON.stringify(v) ?? "null";
}

export function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}
