import type { ChatError } from "./errors.js";

// The chat's objects, in camelCase.
export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  createdAt: string;
}

// Open string unions: v1 may add values, which the client passes through.
export type Stop = "end" | "max_tokens" | "refusal" | "paused" | (string & {});
export type ToolStatus = "started" | "done" | "failed" | (string & {});

export interface ToolProgress {
  name: string;
  status: ToolStatus;
}

export interface Answer {
  text: string;
  tools: readonly ToolProgress[];
}

export type ChatStatus = "idle" | "opening" | "ready" | "error";

export interface Waiting {
  code: "rate_limited" | "overloaded" | "not_connected" | "busy" | "network" | (string & {});
  until: number;
}

export interface ChatState {
  readonly status: ChatStatus;
  readonly anonymous: boolean | null;
  readonly conversation: Conversation | null;
  readonly messages: readonly Message[];
  readonly outgoing: string | null;
  readonly answer: Answer | null;
  readonly answering: boolean;
  readonly waiting: Waiting | null;
  readonly stop: Stop | null;
  readonly error: ChatError | null;
}

export type SendResult = { ok: true; message: Message; stop: Stop | null } | { ok: false; error: ChatError };

export interface TokenRequest {
  expired: boolean;
  signal: AbortSignal;
}

export type TokenSource = (request: TokenRequest) => string | null | Promise<string | null>;

export interface ChatOptions {
  url: string;
  token?: string | null;
  tokenUrl?: string;
  getToken?: TokenSource;
  fetch?: typeof fetch;
}

export interface ReopenOptions {
  token?: string | null;
}

export interface Chat {
  getState(): ChatState;
  subscribe(listener: (state: ChatState) => void): () => void;
  open(): Promise<ChatState>;
  send(text: string): Promise<SendResult>;
  /** Has the assistant speak first, as the chat's start instructions say: the page can't supply them. */
  start(): Promise<SendResult>;
  newConversation(): void;
  reopen(options?: ReopenOptions): Promise<ChatState>;
  signOut(): Promise<void>;
  destroy(): void;
}
