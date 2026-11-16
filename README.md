# @meandr/chat-sdk

The JavaScript client for Meandr Chat. It opens the visitor's session, sends their messages and streams the answers,
which come from a model that uses your workspace's tools. It has no dependencies, and draws nothing: your page renders
its state. `@meandr/chat-sdk/markdown` renders the answers' Markdown safely.

It speaks Meandr Chat's API v1, served at your workspace's URL.

## Install

```sh
npm install @meandr/chat-sdk
```

Or load the script file, which defines `window.MeandrChat`:

```html
<script src="https://cdn.jsdelivr.net/npm/@meandr/chat-sdk@0.0.1/dist/meandr-chat.js"
        integrity="sha384-…" crossorigin="anonymous"></script>
```

The script runs with your page's rights, so pin the version and keep its `integrity` hash: each release's notes on
GitHub give the whole tag.

## Use

```js
import { createChat } from "@meandr/chat-sdk";

const chat = createChat({
  url: "https://calm-otter.meandr.io", // your workspace's URL
  tokenUrl: "/chat_token",             // or token, or getToken: who your user is
});

chat.subscribe(render);                // render(state) now and on every change

launcher.onclick = () => chat.open();  // when the visitor shows interest
const result = await chat.send("Where is my order?");
```

The client does nothing until it's used, so create it with the page: until then it sends nothing, loads nothing and
leaves nothing behind. Create one client per page, not one per component render. It activates in one of three ways:

- **`open()`**, when the visitor shows interest: opens the chat, or starts typing. It loads their latest conversation.
- **`send(text)`** opens by itself.
- **`start()`** has the assistant speak first, such as a greeting or a summary of what needs the visitor's attention.
  What it does is the chat's own start instructions, set in its settings (`CHAT_START_PROMPT`), so a page or a visitor
  can't supply them; the visitor sees only the answer. Without them, it's refused (`start_not_allowed`). With no
  conversation shown, after `newConversation()` say, it speaks in a new one.

## Who the user is

Give the client one way to get your user's token. A token is a JWT your backend signs with the chat's **Session
signing secret**. See the help center's "Sign your users in to Meandr Chat".

| Option | For | The client |
|---|---|---|
| `token` | pages your server builds: it writes the token in, or `null` when nobody is signed in | uses it as it is. It can't renew it: when it expires, the client asks for a reload (`token_expired`) |
| `tokenUrl` | sites that know their user by a cookie | sends `GET` with your site's cookies and reads `{"token": "…"}`. A 401, a 403 or `{"token": null}` means nobody is signed in |
| `getToken` | sites whose requests need more than a cookie, such as a bearer token kept in JavaScript | calls `getToken({ expired, signal })`, which returns the token, or `null` when nobody is signed in. `expired` is true when the chat refused the last token as expired, so skip any cache of yours |
| none | sites without sign-in, or whose server forwards the chat (below) | resumes the browser's session, whoever's it is, or starts an anonymous one |

On a site with sign-in, every page that shows the chat must say who is signed in, `null` included. A page that says
nobody is signed in ends a signed-in session the browser still holds, so the next visitor of a shared computer never
inherits it. A page that gives no way resumes it.

- **Failures:** any other failure of `tokenUrl` or `getToken`, such as a 500, a network error or a function that throws,
  is an error to show and retry (`token_failed`), never a sign-out.
- **Where tokens go:** a token goes only to the chat its `aud` claim names, or to your page's own origin.
- **Memory only:** the client keeps tokens in memory, never in storage, the state or an error. The session lives in the
  chat's own cookie, which no script can read.
- **Your token address:** answer `Cache-Control: no-store`, sign tokens that expire within minutes, and answer 401
  rather than redirecting to a sign-in page. It's best on your page's own origin; on another, it needs CORS with
  credentials for your page's origin.

## Options

| Option | |
|---|---|
| `url` | required: your workspace's URL, `https://<slug>.meandr.io`, or your own address when your server forwards the chat |
| `token` | `string \| null` |
| `tokenUrl` | `string`: an address, absolute or relative to the page |
| `getToken` | `({ expired, signal }) => string \| null \| Promise<string \| null>` |
| `fetch` | your own `fetch`, for tests or a wrapper. Add no headers: the chat's CORS allows only `Authorization` and `Content-Type`, so a tracing header such as `traceparent` fails every request |

An option the client doesn't know, or a token option set to `undefined`, is an error, so a typo or a missing value
can't silently resume someone's session.

## The client

| Member | |
|---|---|
| `getState()` | the current state, below |
| `subscribe(listener)` | calls `listener(state)` now and on every change; returns the function that unsubscribes |
| `open()` | opens the session: call it when the visitor shows interest. Calling it again while open does nothing. Resolves with the state once it opened, or failed for a reason waiting won't fix: see `status` and `error` |
| `send(text)` | sends the message and streams the answer into the state. Resolves with `{ ok: true, message, stop }`, the stored answer, or `{ ok: false, error }` |
| `start()` | has the assistant speak first, as the chat's start instructions say, and streams the answer: in the user's latest conversation, usually the one shown, or a new one when none is shown or the chat is set so. Resolves as `send` does |
| `newConversation()` | forgets the current conversation: the next message, or `start()`, starts a new one |
| `reopen({ token })` | the user changed without a page load: signed in, signed out or switched team. Forgets everything shown and, if the chat was open, opens it again. Pass `token` when you give `token` |
| `signOut()` | ends the session and forgets the user, even if the page never showed the chat. Call it from your sign-out and await it before you navigate: it settles within three seconds, and never rejects |
| `destroy()` | stops everything this client does; it sends nothing more |

No member rejects for a chat failure: the result and the state carry it. Members work passed around on their own, as
in `onClick={chat.newConversation}` or `onFocus={chat.open}`; `send` and `reopen` take arguments, so call those
yourself rather than handing them an event.

## The state

| Field | |
|---|---|
| `status` | `"idle"` before opening, `"opening"`, `"ready"`, or `"error"` when opening failed (`error` says why) |
| `anonymous` | whether the session is an anonymous visitor's; `null` before opening |
| `conversation` | `{ id, createdAt, updatedAt }`, or `null` before the first message |
| `messages` | the conversation's stored messages, oldest first: `{ id, role, text, tools?, createdAt }`. `tools` names the tools the answer used |
| `outgoing` | the message being sent, until the page shows it stored. With `error` set, it may not have reached the chat: offer to send it again, which never stores it twice |
| `answer` | the answer being written in this page: `{ text, tools: [{ name, status }] }`, or `null` |
| `answering` | an answer is being written in this conversation: in this page, or one the page lost or a previous page left running |
| `waiting` | `{ code, until }` while the client waits by itself, such as `rate_limited`, or `null`. `until` is a time in milliseconds, as from `Date.now()` |
| `stop` | why the last answer ended: `"end"`, `"max_tokens"` (cut short), `"refusal"` or `"paused"`; `null` when unknown |
| `error` | the last failure, until the next action |

Show `messages`, then `outgoing`, then `answer`. Disable sending while `answering` or `status` is `"opening"`. An
assistant's `text` is Markdown from a model: render it with `@meandr/chat-sdk/markdown`, or another renderer that
never passes raw HTML through. A user's text is plain text.

The state is replaced, never changed in place. Messages that didn't change keep their objects.

## Errors

A `ChatError` has a `code`, the HTTP `status` (0 when there was no answer), `retryAfter` in seconds when the chat said
when to try again, `partial` when an answer failed after storing part of it, and `retryable`, whether trying again may
work. `isChatError(e)` recognizes one even from another copy of the SDK.

Show your own words for the code:

| `code` | Suggested words |
|---|---|
| `unauthorized` | Sign in to chat. (Nobody is signed in and the chat takes no anonymous visitors, or the token isn't valid.) |
| `token_expired` | Your session has expired. Reload the page. |
| `session_expired` | Your session has ended. |
| `token_failed` | We couldn't check who you are. Try again. |
| `origin_not_allowed`, `origin_required` | The chat isn't available on this site. (The error's message names the site.) |
| `workspace_not_available`, `not_connected` | The chat isn't available right now. |
| `start_not_allowed` | (nothing: the chat isn't set to speak first) |
| `not_found` | This conversation is gone. |
| `busy` | Still answering your previous message. |
| `too_large` | That message is too long. |
| `rate_limited` | You're sending messages too fast. Try again in a moment. |
| `overloaded` | The chat is busy. Try again in a moment. (The chat's machine is short of memory.) |
| `model_busy` | The assistant is busy. Try again in a moment. |
| `interrupted`, `timeout`, `unavailable`, `no_answer` | The answer failed. Try again. |
| `network` | We couldn't reach the chat. |
| `aborted` | (nothing: your page cut the message short) |
| `bad_request`, `internal`, `protocol` | Something went wrong. Try again. |

Codes the client doesn't know may come: show a general error for those.

## What the client does by itself

- **Opening:** with a token, the browser's session resumes if it's this user's, or a new one starts. When the page says
  nobody is signed in, the client asks whether the browser holds a signed-in session, ends it if so, then opens.
- **Browsers that don't keep the chat's cookie** (Safari before 26.2, for one): the client notices after opening, then
  sends the token with every request, or, for an anonymous visitor, the session token the chat gives it.
- **An expired token:** with `tokenUrl` or `getToken`, it gets a new one and tries again, once.
- **An ended session:** it opens one again and sends the message once more. If the session it reopens is someone
  else's, it wipes what the page shows instead, the unsent message included.
- **Opening never gives up** while the chat can't be reached or isn't serving yet, as while it restarts after a
  settings change: it tries again briskly through the first minute, then every 15 to 30 s, until the chat answers or
  the page leaves. `waiting` says so meanwhile, so the page never needs a reload, and a `send` or `start` called
  meanwhile waits with it.
- **Waiting:** it waits as long as the chat says, up to a minute, when the visitor writes too fast or the chat's
  machine is short of memory, and up to two minutes when the user's previous answer is still running, in another tab
  perhaps. Past the answers the chat writes at once, an answer waits its turn on the open stream, so nothing is
  refused for it.
- **Nothing twice:** it tries a message again only when the chat refused it before storing it. When the connection
  drops or the chat fails while sending, it looks for the message in the conversation before saying it failed. A
  start that fails with `network` may have begun, so calling it again can have the assistant speak twice.
- **A lost stream:** the answer runs on and is stored. The client asks for the conversation every few seconds, for up
  to ten minutes, until the answer ends, as it does when it opens on an answer a previous page left running. An answer
  still waiting its turn when its stream closed was dropped: that's `no_answer`, and sending again stores the message
  a second time.

## Frameworks

React:

```jsx
const chat = createChat({ url, tokenUrl: "/chat_token" }); // once, outside components

function Chat() {
  const state = useSyncExternalStore(chat.subscribe, chat.getState, chat.getState);
  return <ChatPanel state={state} onOpen={chat.open} onSend={(text) => chat.send(text)} />;
}
```

A dashboard that wants the assistant to speak first calls `chat.start()` where it shows the chat, in an effect say.

Create the client at module scope or in a context, not in an effect that destroys it: React's development mode runs
effects twice. Vue: keep the state in a `shallowRef` set by `subscribe`. Svelte: the client is a store, so `$chat` is
the state.

## Markdown

```js
import { parseMarkdown, renderMarkdown } from "@meandr/chat-sdk/markdown";

bubble.replaceChildren(renderMarkdown(message.text)); // DOM nodes, never HTML
const tree = parseMarkdown(message.text);             // plain objects, for React and friends
```

Paragraphs, headings, emphasis, code, lists, quotes, tables and links. Raw HTML stays text. Only `https:`, `http:` and
`mailto:` links become links, opening in a new tab with `rel="noopener noreferrer"`, and never one carrying a user
name or password. Images show as links to them, so nothing loads without a click.

Model answers can carry a link planted in a tool's output, so every link shows where it goes:

- **An address on its own** shows its address: the host as the browser parses it, spaces and invisible characters
  left encoded, at most 200 characters.
- **A link with text of its own** has its host right before that text, as in "[nodejs.org] the docs", unless the
  text already is that address. Nothing in the text can push the host away.
- **A `mailto:` link** has its whole address before its text.

A link's text is kept to one line of at most 120 characters. Hosts in other scripts show in punycode, an address
whose host holds anything but letters, digits, dots and hyphens isn't a link, link titles are dropped, and the
controls that reorder text (embeddings, overrides and isolates) are removed. A link that has its destination before
it carries it as `dest`, so your renderer can style that string.

`parseMarkdown` returns strings for text and `{ tag, children }` for elements, with `href` on `a`, `start` on `ol`,
`language` on `pre`, and `align` on `th` and `td`. Every `tag` is one an HTML renderer may create as it is:

```jsx
function Md({ node }) {
  if (typeof node === "string") return node;
  const kids = node.children?.map((c, i) => <Md key={i} node={c} />);
  if (node.tag === "a") return <a href={node.href} target="_blank" rel="noopener noreferrer">{kids}</a>;
  if (node.tag === "pre") return <pre><code>{kids}</code></pre>;
  return createElement(node.tag, { start: node.start, style: node.align && { textAlign: node.align } }, kids);
}
```

## Behind your own server

Your server may forward `/chat/*` from your own domain to the workspace's URL, adding your user's token to each request
and dropping the browser's `Origin`. Then give `url` your own address and no token option. The browser holds nothing of
the chat's, and only signed-in users can chat: your server must answer for them.

## Content Security Policy

Allow `connect-src` for your workspace's URL and your token address.

## License

Apache-2.0. See [LICENSE](LICENSE).
