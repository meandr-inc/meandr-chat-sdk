import type { ChatError } from "./errors.js";

// The chat's objects, in camelCase.
export interface Conversation {
  id: string;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null; // when its user ended it; null while they haven't, and from a chat that doesn't say
  title?: string; // only from listConversations: the start of its first message, "" while it has none
}

export interface Message {
  id: number;
  role: "user" | "assistant";
  text: string;
  tools?: string[];
  toolTitles?: Record<string, string>; // with tools: each one's title by name, its name where the chat knows none
  files?: ChatFile[];
  actions?: Action[]; // an answer's: what its tool calls waited on for the user
  createdAt: string;
}

export type ActionStatus = "pending" | "allow" | "deny" | "cancel" | "expired" | "aborted" | (string & {});

// What a tool call waits on from the user: a form (fields, {} for a confirmation) or pages to open (links).
export interface Action {
  id: string;
  initiator: "upstream" | "policy" | (string & {}); // a server's ask, or the workspace's approval of the call
  kind: "form" | "url" | (string & {});
  server: string; // the server's name
  tool: string;
  title: string; // the tool's title, or its name
  message: string; // a form's text, saying why it asks, or an approval's summary; plain text
  fields: Record<string, unknown> | null; // a form's requestedSchema
  links: ActionLink[]; // a URL ask's pages
  done: boolean; // a URL ask whose response is the user's Done, once finished there, not the Open
  status: ActionStatus;
  expiresAt: string | null;
}

export interface ActionLink {
  url: string;
  message: string;
}

// The user's response: content goes only with a form's accept, holding its fields.
export interface ActionResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
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
export type ToolStatus = "started" | "done" | "failed" | "waiting" | (string & {});

export interface ToolProgress {
  name: string;
  status: ToolStatus;
  title: string; // the tool's, or its name when the chat knows none
}

export interface Answer {
  text: string;
  tools: readonly ToolProgress[];
  actions?: readonly Action[]; // what its tool calls wait on, as they come; done's message keeps them
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
  readonly hasOlder: boolean;
  readonly outgoing: string | null;
  readonly answer: Answer | null;
  readonly answering: boolean;
  readonly waiting: Waiting | null;
  readonly stop: Stop | null;
  readonly error: ChatError | null;
  readonly files: FileLimits | null;
  readonly conversationList: boolean | null;
}

export type SendResult = { ok: true; message: Message; stop: Stop | null } | { ok: false; error: ChatError };

export type AttachResult = { ok: true; file: ChatFile } | { ok: false; error: ChatError };

export type ReadFileResult = { ok: true; blob: Blob } | { ok: false; error: ChatError };

export type ListConversationsResult = { ok: true; conversations: Conversation[]; hasMore: boolean } | { ok: false; error: ChatError };

export type OpenConversationResult = { ok: true; conversation: Conversation } | { ok: false; error: ChatError };

export type DeleteConversationResult = { ok: true } | { ok: false; error: ChatError };

export type RespondResult = { ok: true } | { ok: false; error: ChatError };

export type LoadOlderResult = { ok: true; messages: Message[] } | { ok: false; error: ChatError };

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

export interface ListConversationsOptions {
  before?: Conversation | string;
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
  /** Ends the conversation shown and forgets it at once; before the session opens, the one it opens on. Never rejects. */
  endConversation(): Promise<void>;
  /** Ends the conversation shown, as endConversation does: the next message or start begins a new one. */
  newConversation(): void;
  /** Lists the user's conversations, 20 at a time, most recently active first; before goes on after that one. */
  listConversations(options?: ListConversationsOptions): Promise<ListConversationsResult>;
  /** Shows that conversation, its last 20 messages, once read, in place of the current one, which it doesn't end. */
  openConversation(conversation: Conversation | string): Promise<OpenConversationResult>;
  /** Deletes that conversation with its messages and files, where the chat lists them; one already gone counts. */
  deleteConversation(conversation: Conversation | string): Promise<DeleteConversationResult>;
  /** Adds the 20 messages before the oldest shown, while hasOlder; calls while one runs share it. */
  loadOlder(): Promise<LoadOlderResult>;
  /** Sends the user's response to an action in the conversation shown, while the answer waiting on it streams. */
  respondToAction(action: Action | string, response: ActionResponse): Promise<RespondResult>;
  /**
   * Opens one of a URL ask's pages in a new tab, never a frame; call it from the user's click. Without done,
   * opening is the response: it sends the accept and returns its result; with done, null (Done responds).
   * A link that isn't http or https opens nothing and resolves bad_request.
   */
  openActionLink(action: Action, url: string): Promise<RespondResult> | null;
  reopen(options?: ReopenOptions): Promise<ChatState>;
  signOut(): Promise<void>;
  destroy(): void;
}
