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

- **`open()`**, when the visitor shows interest: opens the chat, or starts typing. It loads their latest conversation
  they haven't ended, its last 20 messages.
- **`send(text)`** opens by itself.
- **`start()`** has the assistant speak first, such as a greeting or a summary of what needs the visitor's attention.
  What it does is the chat's own start instructions, its **Intro prompt** setting (`CHAT_START_PROMPT`), so a page or a visitor
  can't supply them; the visitor sees only the answer. Without them, it's refused (`start_not_allowed`). With no
  conversation shown, after `newConversation()` say, it speaks in a new one.

## Who the user is

Give the client one way to get your user's token. A token is a JWT your backend signs with the chat's **Session
secret key**. See the help center's "Sign your users in to Meandr Chat".

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
| `context` | `() => PageContext \| undefined \| Promise<PageContext \| undefined>`: what your page tells the model of itself, read at each `send()` and `start()`: see [Page context](#page-context) |

An option the client doesn't know, or a token option set to `undefined`, is an error, so a typo or a missing value
can't silently resume someone's session.

## The client

| Member | |
|---|---|
| `getState()` | the current state, below |
| `subscribe(listener)` | calls `listener(state)` now and on every change; returns the function that unsubscribes |
| `open()` | opens the session: call it when the visitor shows interest. Calling it again while open does nothing. Resolves with the state once it opened, or failed for a reason waiting won't fix: see `status` and `error` |
| `send(text, { files })` | sends the message and streams the answer into the state. `files` are those `attach` gave, as ChatFiles or ids; with any, `text` may be `""`. Resolves with `{ ok: true, message, stop }`, the stored answer, or `{ ok: false, error }` |
| `attach(file, { name, onProgress, signal })` | uploads a `File` or `Blob` for a message of the visitor's within the hour, opening the session if need be: see [Files](#files). `name` is the file's own unless given, else `"file"`; `onProgress(sent, total)` follows its bytes; `signal` cancels it. Resolves with `{ ok: true, file }`, a ChatFile, or `{ ok: false, error }`, and changes nothing in the state |
| `readFile(file, { signal })` | fetches a file the visitor attached, by its ChatFile or id, with the session's credentials, opening the session if need be. Resolves with `{ ok: true, blob }` or `{ ok: false, error }` |
| `start()` | has the assistant speak first, as the chat's start instructions say, and streams the answer: in the user's latest conversation they haven't ended, usually the one shown, or a new one when none is shown. Resolves as `send` does |
| `endConversation()` | ends the conversation shown and forgets it at once, so no page shows it again by itself: see [Conversations](#conversations). Resolves once the chat has it, or after about a minute of trying; never rejects |
| `newConversation()` | ends the conversation shown, as `endConversation()` does: the next message, or `start()`, starts a new one |
| `listConversations({ before, signal })` | lists the user's conversations, 20 at a time, most recently active first, opening the session if need be: see [Conversations](#conversations). `before`, a Conversation or its id, goes on after that one; `signal` cancels it. Resolves with `{ ok: true, conversations, hasMore }`, each with its `title`, or `{ ok: false, error }`, and changes nothing in the state |
| `openConversation(conversation)` | shows that conversation, a Conversation or its id, in place of the current one once it's read: its last 20 messages. It ends nothing, and the next message goes there. Resolves with `{ ok: true, conversation }`, or `{ ok: false, error }` with the current one still shown |
| `deleteConversation(conversation)` | deletes that conversation, a Conversation or its id, with its messages and files, opening the session if need be. One already gone counts as deleted; the one shown is forgotten. Resolves with `{ ok: true }` or `{ ok: false, error }`, and is refused as `busy` while an answer is being written in it |
| `loadOlder()` | adds the 20 messages before the oldest shown to the front of `messages`, while `hasOlder`. Resolves with `{ ok: true, messages }`, those it added, or `{ ok: false, error }` |
| `respondToAction(action, { action, content })` | sends the user's response to an action in the conversation shown, an Action or its id, while the answer waiting on it streams: see [Actions](#actions). `action` is `"accept"`, `"decline"` or `"cancel"`; `content`, a form's fields, goes only with a form's accept. Resolves with `{ ok: true }` or `{ ok: false, error }` |
| `openActionLink(action, url)` | opens one of a URL ask's pages in a new tab, never in a frame: call it from the user's click. Without `done`, opening is the response: it also sends the accept and returns `respondToAction`'s promise; with `done`, it returns `null`, and Done responds |
| `reopen({ token })` | the user changed without a page load: signed in, signed out or switched team. Forgets everything shown and, if the chat was open, opens it again. Pass `token` when you give `token` |
| `signOut()` | ends the session and forgets the user, even if the page never showed the chat. Call it from your sign-out and await it before you navigate: it settles within three seconds, and never rejects |
| `destroy()` | stops everything this client does; it sends nothing more |

No member rejects for a chat failure: the result and the state carry it. Members work passed around on their own, as
in `onClick={chat.endConversation}` or `onFocus={chat.open}`; `send`, `attach`, `readFile`, `listConversations`,
`openConversation`, `deleteConversation`, `respondToAction`, `openActionLink` and `reopen` take arguments, so call
those yourself rather than handing them an event.

## The state

| Field | |
|---|---|
| `status` | `"idle"` before opening, `"opening"`, `"ready"`, or `"error"` when opening failed (`error` says why) |
| `anonymous` | whether the session is an anonymous visitor's; `null` before opening |
| `conversation` | `{ id, createdAt, updatedAt, endedAt }`, or `null` before the first message. `endedAt` is when the user ended it, `null` while they haven't; their next message there reopens it |
| `messages` | the conversation's stored messages, oldest first: its last 20 when it's shown, and older ones as `loadOlder()` adds them. Each is `{ id, role, text, tools?, toolTitles?, files?, actions?, createdAt }`. `tools` names the tools the answer used, and `toolTitles`, with it, gives each one's title by name, its name where the chat knows none; `files` are the ChatFiles the visitor attached; `actions`, on an answer, what its tool calls waited on (see [Actions](#actions)) |
| `hasOlder` | the conversation shown has messages older than those in `messages`: `loadOlder()` adds them |
| `outgoing` | the text of the message being sent, `""` with files alone, until the page shows it stored. With `error` set, it may not have reached the chat: offer to send it again, with its files, which never stores it twice |
| `answer` | the answer being written in this page: `{ text, tools: [{ name, status, title }], actions? }`, or `null`. Show a tool's `title`: its name when the chat knows none. A tool `"waiting"` waits on the user's response to an action, which `actions` carries |
| `answering` | an answer is being written in this conversation: in this page, or one the page lost or a previous page left running |
| `waiting` | `{ code, until }` while the client waits by itself, such as `rate_limited`, or `null`. `until` is a time in milliseconds, as from `Date.now()` |
| `stop` | why the last answer ended: `"end"`, `"max_tokens"` (cut short), `"refusal"` or `"paused"`; `null` when unknown |
| `error` | the last failure, until the next action |
| `files` | what the chat takes, as its session says: `{ types, maxBytes, perMessage }`, the media types, a file's most bytes and a message's most files. `null` before opening and while it takes no file: offer attaching only when it isn't `null` |
| `conversationList` | whether the chat lists the user's conversations, as its session says: offer the list, and opening and deleting conversations from it, only while it's `true`. `null` before opening |

Show `messages`, then `outgoing`, then `answer`. Disable sending while `answering` or `status` is `"opening"`. An
assistant's `text` is Markdown from a model: render it with `@meandr/chat-sdk/markdown`, or another renderer that
never passes raw HTML through. A user's text is plain text.

The state is replaced, never changed in place. Messages that didn't change keep their objects, and so does `files`.

## Conversations

A conversation goes on, through reloads and a closed chat, until the user ends it. Then no page shows it again by
itself, and the next message, or `start()`, begins a new one. Offer ending always. Messages come 20 at a time: a
conversation shows its last 20, and `loadOlder()` adds the 20 before the oldest shown while `hasOlder`. Where the
chat's **Conversation list** setting is on (`CHAT_CONVERSATION_LIST`), a page may also offer the user's conversations,
ended ones included, to open or delete:

```js
endButton.onclick = () => {
  chat.endConversation();                         // shows none at once; the end outlives the page
  panel.hidden = true;
};
newButton.onclick = chat.newConversation;         // ends it too: the next message begins another
listButton.hidden = !state.conversationList;      // the list, opening and deleting: only while the chat lists them

const page = await chat.listConversations();      // the 20 most recently active, and page.hasMore
if (page.ok) rows = page.conversations;           // { id, title, createdAt, updatedAt, endedAt }
const next = await chat.listConversations({ before: rows[rows.length - 1] }); // the 20 after those

await chat.openConversation(rows[2]);             // shows it, ending none: the next message goes there
await chat.deleteConversation(rows[3]);           // with its messages and files

scroller.onscroll = () => {
  if (scroller.scrollTop === 0 && chat.getState().hasOlder) chat.loadOlder(); // then keep the visitor's place
};
```

- **Ending** forgets the conversation shown at once, and tells the chat with `keepalive`, so the end goes through
  when the page navigates away right after. It's tried again through about a minute while the chat can't be reached
  or asks to wait. `endConversation()` resolves once the chat has it, and never rejects. A first message or `start()`
  still on its way, its new conversation not named yet, resolves `aborted` at once but goes on unseen until the chat
  names that conversation, which is then ended. Called before the session opens, it ends the conversation the session
  opens on, which the page then never shows; with no opening under way, it resolves at once. `newConversation()` does
  the same, for a "New conversation" that begins the next one at once.
- **The list** comes most recently active first, 20 at a time: pass the last one shown as `before` for the next 20,
  while `hasMore`. A conversation that gets a message meanwhile moves to the top, so the walk may miss it or show it
  twice: read the first page again to see what's new. A `title` is the start of the conversation's first message, `""`
  while it has none, as after a `start()` alone; only the list carries it. `endedAt` says which ones the user ended.
- **Opening** one reads it, then shows its last 20 messages in place of the current one, following an answer still
  being written in it. The current one isn't ended, and stays shown when the read fails. One the user ended shows with
  its `endedAt`, and their next message there reopens it. A `newConversation()`, a later `openConversation()`, or a
  message or `start()` before it's shown wins, and it resolves `aborted`. A conversation that isn't the user's is
  `not_found`.
- **Deleting** one takes its messages and files with it. One already gone counts as deleted, and the one shown is
  forgotten. While an answer is being written in it, it's refused as `busy`.
- **Older messages** go to the front of `messages`; `loadOlder()` resolves with them, `[]` when none remain, and calls
  while one runs share it. A conversation read again, as when the client follows a lost stream, keeps those it loaded.
- **Where the chat lists none** (`conversationList` is `false`), `listConversations()` and `deleteConversation()` are
  refused without a request (`conversation_list_off`), and a conversation the user ended is gone for them. Opening the
  others and loading older messages work either way.
- **Gone elsewhere:** a conversation shown that another tab deleted, or ended where the chat lists none, reads as
  missing. The client forgets it at its next read or message, which says `not_found`.
- **`start()`** speaks in the user's latest conversation they haven't ended, which may not be the one shown: the page
  then shows that conversation, with the answer alone. With none shown, after `endConversation()` say, it speaks in a
  new one.

## Actions

A tool call may need the user before it can go on: a confirmation, a few fields, or a page of its own, such as one for
a key. The workspace holds the call while the model waits on it, and the chat shows the action in the answer being
written, at the tool that waits. Once the user responds, the tool's result reaches the model and the answer goes on,
in the same turn, on the same stream.

```js
for (const a of state.answer?.actions || message.actions || []) {
  if (a.status !== "pending") showStatus(a); // allow, deny, cancel, expired or aborted
  else if (a.kind === "form") showForm(a);   // a.message, then a.fields; {} is a confirmation
  else showLinks(a);                         // a.links: [{ url, message }]
}

confirm.onclick = () => chat.respondToAction(a, { action: "accept", content: values }); // a form's fields
decline.onclick = () => chat.respondToAction(a, { action: "decline" });
link.onclick = () => chat.openActionLink(a, link.dataset.url); // from the click; without done, the response
done.onclick = () => chat.respondToAction(a, { action: "accept" }); // shown only when a.done
```

- **An Action** is `{ id, initiator, kind, server, tool, title, message, fields, links, done, status, expiresAt }`. Show
  who asks, the server's name and the tool's title, beside it. `initiator` is `"upstream"`, a server's ask, or
  `"policy"`, the workspace's approval of the call.
- **While the answer is written** `answer.actions` holds them, each as it comes and again as its status changes; the
  stored answer keeps them as `message.actions`. A page opened meanwhile shows them while it follows the answer.
- **A form** shows `message` as plain text, making no link in it clickable, then each field of `fields`, a JSON
  Schema's flat object of strings, numbers, integers, booleans and single or multiple choices, each with its `title`,
  `description` and `default`, filled in for the user to review. `required` names those that must be filled. With no
  fields it's a confirmation: Confirm and Decline alone. The fields go to the tool alone, never the model.
- **A URL ask** shows each link's `message` and its whole URL, the host prominent, never fetched or previewed, with
  Open. `openActionLink` opens the page in a new tab with `noopener`, from the user's click so no popup blocker
  stops it. Without `done`, agreeing to open the page is the response: Open sends it. With `done`, the tool must be
  called again once the user has finished there, so offer Done once a page has been opened; Done responds. Warn of a
  host in Punycode (`xn--`).
- **Decline** declines; `cancel` says the user made no choice.
- **`respondToAction`** hands the response over and resolves `{ ok: true }`; what follows comes on the answer's own
  stream. The tool's result can come minutes after a URL ask's Open, while the user is on the page.
- **Closed:** `cancel` when the model stopped waiting, shown as "This has expired, please try again later"; `expired`
  past `expiresAt`. Either takes no response (`action_closed`).

## Files

Where the chat's **Attachments** setting is on (`CHAT_ATTACHMENTS`), a visitor may attach them to a message for the model to
read: images (PNG, JPEG, WebP, GIF), PDFs, and text (plain, Markdown, CSV). They never reach your workspace's tools.

```js
const { types } = state.files; // offer attaching only while state.files isn't null
input.accept = types.concat(types.includes("text/plain") ? [".txt", ".md", ".csv"] : []).join(",");

const files = []; // the message's, as the visitor picks them
const picked = await chat.attach(input.files[0], { onProgress: (sent, total) => (bar.value = sent / total) });
if (picked.ok) files.push(picked.file); // or picked.error, such as unsupported_type
await chat.send(text, { files });       // once every upload is in; text may be ""

const read = await chat.readFile(message.files[0]);
if (read.ok) img.src = URL.createObjectURL(read.blob);
```

- **Offer attaching only while the state's `files` isn't `null`.** Its `types` can be your `<input>`'s `accept`:
  browsers often give Markdown and CSV files no type, so add `.txt`, `.md` and `.csv` when it lists `text/plain`, which
  the chat takes with the other two. A message takes at most `perMessage` files.
- **Upload each file as it's picked**, showing its progress, and send the message once all are in. The chat deletes a
  file no message takes within an hour, and a message takes each file once.
- **A ChatFile** is `{ id, name, type, size, createdAt }`: its name as the chat keeps it, its media type as the chat
  reads it from its bytes, and its size in bytes.
- **Progress** comes from `XMLHttpRequest`, since `fetch` reports none: with `onProgress`, the upload doesn't go through
  a `fetch` you gave.
- **Refused before sending,** with status 0, since a browser may see a refusal that comes mid-upload as a network
  error: a file past `maxBytes` (`too_large`), and any file once a session says the chat takes none (`attachments_off`).
  Until a session says, or from a chat that doesn't, a file past 10 MiB, which no chat takes, is refused the same way.
- **Showing a file:** `readFile` fetches it with the session's cookie or token, so make an object URL of its blob: an
  `<img>` pointing at the chat can't carry the token. The blob keeps an image's type; anything else is
  `application/octet-stream`, a file to save rather than one the browser renders. Files already sent stay readable
  while the chat takes no new ones.

## Page context

Each message and start can tell the model what the visitor's page shows, so "this order" or "the drawer I have open"
means something to it. The `context` option is read at each `send()` and `start()`, so it's always the current view:

```js
const chat = createChat({
  url: "https://calm-otter.meandr.io",
  tokenUrl: "/chat_token",
  context: () => ({
    url: location.origin + location.pathname, // the query and hash can carry tokens
    title: document.title,
    view: { section: "Orders", drawer: { open: true, order: "A-1042", tab: "Refunds" } },
  }),
});
```

The chat gets, beside the message:

```json
{"timezone":"Europe/Tallinn","url":"https://console.shop.example/orders","title":"Orders · Console","view":{"section":"Orders","drawer":{"open":true,"order":"A-1042","tab":"Refunds"}}}
```

- **Known keys,** all optional: `url` (at most 2048 bytes), `title` (512) and `timezone` (an IANA name, 64). Any other
  key goes as you give it.
- **The browser's time zone** goes by default, under what the option gives, so the model knows the visitor's local
  time: give `timezone` to name another, or `timezone: undefined` to send none. Without the option, every message and
  start carries the time zone alone.
- **Send only what you mean to.** The model reads it as what the page reports, information rather than instructions,
  and the chat stores it with the message. URLs can carry tokens, such as a reset link's or a sign-in code:
  `location.origin + location.pathname` leaves out the query and the hash.
- **The visitor's browser sends it,** so a visitor can change it, fooling only their own conversation: never let it
  decide what a user may do. Facts your backend vouches for, such as the user's name, go in the token's `profile`
  claim instead.
- **Never at the message's cost:** past the chat's limit (8 KiB by default, as its session says), with a `url`,
  `title` or `timezone` the chat would refuse, or when the option throws, gives no object or takes over 5 s, the
  message goes without the page's part, keeping the time zone, and the console warns once for each reason. A chat
  older than page context, whose session says no limit, gets the time zone alone.

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
| `attachments_off` | This chat doesn't take files. |
| `unsupported_type` | That kind of file can't be attached. |
| `storage_full` | You can't attach more files for now. (The visitor's files, those in conversations included, fill the space the chat allows.) |
| `conversation_list_off` | (nothing: offer the list, opening and deleting only while `conversationList` is `true`) |
| `not_found` | This conversation is gone. (From `readFile`: That file is gone.) |
| `busy` | Still answering your previous message. (From `deleteConversation`: It's still answering there. Try again when it's done.) |
| `action_closed` | This has closed. (Decided, cancelled or expired: show its status.) |
| `workspace_unavailable` | We couldn't pass on your response. Try again in a moment. |
| `too_large` | That message is too long. (From `attach`: That file is too large.) |
| `rate_limited` | You're sending messages too fast. Try again in a moment. (Also when the workspace is past its plan's limit on requests.) |
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
- **Waiting:** it waits as long as the chat says, up to a minute, when the visitor writes too fast, the workspace is
  past its plan's limit on requests or the chat's machine is short of memory, and up to two minutes when the user's
  previous answer is still running, in another tab perhaps. Past the answers the chat writes at once, an answer waits
  its turn on the open stream, so nothing is refused for it.
- **Nothing twice:** it tries a message again only when the chat refused it before storing it. When the connection
  drops or the chat fails while sending, it looks for the message in the conversation before saying it failed. A
  start that fails with `network` may have begun, so calling it again can have the assistant speak twice.
- **Files:** an upload the chat refused before keeping it is tried again as a message is: an ended session is opened
  again once, and it waits up to a minute as the chat says. One whose answer was lost, such as with `network`, isn't,
  since the chat may have kept it: attach it again. An upload is given up on when it stops moving for 30 s, or, without
  `onProgress`, when no answer starts within 30 s plus its size's time at 32 KB/s.
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

Allow `connect-src` for your workspace's URL and your token address, and `img-src blob:` to show files through object
URLs.

## License

Apache-2.0. See [LICENSE](LICENSE).
