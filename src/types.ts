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
  toolTitles?: Record<string, string>; // with tools: each one's title by name, its name where the chat knows none
  files?: ChatFile[];
  createdAt: string;
}

// A file the visitor attached; type is its media type, size in bytes.
export interface ChatFile {
  id: string;
  name: string;
  type: string;
  size: number;
  createdAt: string;
}

// What the chat takes, as its session says: media types, a file's most bytes, a message's most files.
export interface FileLimits {
  types: string[];
  maxBytes: number;
  perMessage: number;
}

// Open string unions: v1 may add values, which the client passes through.
export type Stop = "end" | "max_tokens" | "refusal" | "paused" | (string & {});
export type ToolStatus = "started" | "done" | "failed" | (string & {});

export interface ToolProgress {
  name: string;
  status: ToolStatus;
  title: string; // the tool's, or its name when the chat knows none
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
  readonly files: FileLimits | null;
}

export type SendResult = { ok: true; message: Message; stop: Stop | null } | { ok: false; error: ChatError };

export type AttachResult = { ok: true; file: ChatFile } | { ok: false; error: ChatError };

export type ReadFileResult = { ok: true; blob: Blob } | { ok: false; error: ChatError };

export interface SendOptions {
  files?: ReadonlyArray<ChatFile | string>;
}

export interface AttachOptions {
  name?: string;
  onProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
}

export interface ReadFileOptions {
  signal?: AbortSignal;
}

export interface TokenRequest {
  expired: boolean;
  signal: AbortSignal;
}

export type TokenSource = (request: TokenRequest) => string | null | Promise<string | null>;

// What a page tells the model of itself; url, title and timezone are read as such, any other key as given.
export interface PageContext {
  url?: string;
  title?: string;
  timezone?: string;
  [key: string]: unknown;
}

export interface ChatOptions {
  url: string;
  token?: string | null;
  tokenUrl?: string;
  getToken?: TokenSource;
  fetch?: typeof fetch;
  context?: () => PageContext | undefined | Promise<PageContext | undefined>;
}

export interface ReopenOptions {
  token?: string | null;
}

export interface Chat {
  getState(): ChatState;
  subscribe(listener: (state: ChatState) => void): () => void;
  open(): Promise<ChatState>;
  send(text: string, options?: SendOptions): Promise<SendResult>;
  /** Uploads a file for a message of the visitor's within the hour; with onProgress, through XMLHttpRequest. */
  attach(file: Blob, options?: AttachOptions): Promise<AttachResult>;
  /** Fetches a file the visitor attached, with the session's credentials, for an object URL. */
  readFile(file: ChatFile | string, options?: ReadFileOptions): Promise<ReadFileResult>;
  /** Has the assistant speak first, as the chat's start instructions say: the page can't supply them. */
  start(): Promise<SendResult>;
  newConversation(): void;
  reopen(options?: ReopenOptions): Promise<ChatState>;
  signOut(): Promise<void>;
  destroy(): void;
}
