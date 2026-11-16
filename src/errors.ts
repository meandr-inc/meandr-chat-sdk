import type { Message } from "./types.js";

export type ChatErrorCode =
  | "unauthorized"
  | "token_expired"
  | "token_failed"
  | "session_expired"
  | "origin_not_allowed"
  | "origin_required"
  | "workspace_not_available"
  | "not_found"
  | "busy"
  | "too_large"
  | "rate_limited"
  | "overloaded"
  | "not_connected"
  | "interrupted"
  | "timeout"
  | "unavailable"
  | "model_busy"
  | "no_answer"
  | "network"
  | "aborted"
  | "bad_request"
  | "internal"
  | "protocol";

export interface ChatErrorInit {
  status?: number;
  retryAfter?: number | null;
  partial?: Message | null;
  cause?: unknown;
}

const RETRYABLE = new Set([
  "busy",
  "rate_limited",
  "overloaded",
  "not_connected",
  "interrupted",
  "timeout",
  "unavailable",
  "model_busy",
  "no_answer",
  "network",
  "internal",
  "token_failed",
]);

// ChatError carries the chat's error code or one of the client's own; see the
// README's table.
export class ChatError extends Error {
  readonly code: ChatErrorCode | (string & {});
  readonly status: number;
  readonly retryAfter: number | null;
  readonly partial: Message | null;
  readonly cause?: unknown;

  constructor(code: string, message: string, init: ChatErrorInit = {}) {
    super(message);
    this.name = "ChatError";
    this.code = code;
    this.status = init.status ?? 0;
    this.retryAfter = init.retryAfter ?? null;
    this.partial = init.partial ?? null;
    if (init.cause !== undefined) this.cause = init.cause;
  }

  // retryable says whether the same message may work if the visitor tries again.
  get retryable(): boolean {
    return RETRYABLE.has(this.code);
  }
}

// isChatError works across two copies of the SDK on one page, where instanceof doesn't.
export function isChatError(e: unknown): e is ChatError {
  return e instanceof ChatError || (!!e && typeof e === "object" && (e as Error).name === "ChatError" && typeof (e as ChatError).code === "string");
}
