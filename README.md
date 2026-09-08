# Fastmail Notifier

An unread-mail notifier for Fastmail, in the spirit of
[ignotifier](https://github.com/inbasic/ignotifier): a toolbar badge with the
unread count, and a preview window you can flip through unread mail in.

## Why it needs an API token

ignotifier rides your Gmail session cookie. **That approach does not work for
Fastmail.** Its JMAP API is Bearer-token only and ignores cookies entirely:

```
GET  https://api.fastmail.com/jmap/session   (with cookies)  -> 401 No Authorization header
POST https://<region>.api.fastmail.com/jmap/api/?u=...       -> 401 No Authorization header
```

So the extension asks for a Fastmail API token instead. This is the better trade:
a real token gives a clean `401` when it expires, and a stable write path for
marking read and trashing — both things ignotifier struggles with.

## Setup

1. **Create a token.** In Fastmail: Settings → Privacy & Security →
   [API tokens](https://app.fastmail.com/settings/security/tokens) → *New API
   token*, with the **Mail** scope. Read-only is enough for the badge; marking
   read and moving to Trash need read-write.
2. **Load the extension.** `chrome://extensions` → enable *Developer mode* →
   *Load unpacked* → select this directory.
3. **Paste the token** into the extension's options page and hit *Verify & save*.
   It is checked against Fastmail before it is stored.

## Firefox

One codebase, one manifest, no build step. Load it with:

`about:debugging` → **This Firefox** → **Load Temporary Add-on…** → pick `manifest.json`.

Or, for a throwaway profile: `npx web-ext run --source-dir .`

Requires Firefox 142+ (`strict_min_version`), which is the floor for
`data_collection_permissions`. The extension declares `"required": ["none"]`: it sends
nothing to any third party, and its only network peer is your own Fastmail account.

Temporary add-ons are removed when Firefox restarts, and you will need to paste the API
token again (a different profile means different storage). Firefox 127+ grants the
declared host permissions at install; they can be revoked ad hoc from `about:addons`, so
if requests start failing there, check that first.

How the one manifest serves both browsers:

- `background.service_worker` for Chrome, `background.scripts` for Firefox. Firefox MV3
  supports event pages *only* — it has never supported service workers
  ([bug 1573659](https://bugzil.la/1573659)) — so both keys are required. `worker.js`
  guards with `if (typeof importScripts !== 'undefined')`, since Firefox's manifest has
  already loaded those files by the time it runs.
- `core/api.js` picks the namespace: Firefox's promise-based APIs live on `browser`,
  while its `chrome` alias is callback-based and would silently `await` to `undefined`.
  Preferring `browser` and falling back to `chrome` lands on promises in both, with no
  polyfill.
- Notifications stay within the intersection both accept. Firefox supports only `type`,
  `title`, `message` and `iconUrl`, and only `type: 'basic'` — so the message preview goes
  into a multi-line `message` rather than `contextMessage`, and `silent` is not sent.
- Storage change events use the global `storage.onChanged` with an `areaName` check
  rather than the per-area variant.

## Where the token lives

In `chrome.storage.local`, which is **unencrypted on disk** in your browser
profile — the same as any extension setting. Anyone who can read that profile
directory can read the token, and a mail-scoped token can read and delete mail.
The options page never displays it back (only the last four characters), and if
the machine is ever compromised you can
[revoke it](https://app.fastmail.com/settings/security/tokens) with immediate
effect.

## Two things that look like problems but aren't

**Sub-30-second alarms do not exist in a packaged Chrome extension.** Chrome clamps
`alarms` to a 30 second floor, and `when` values nearer than that are honoured silently
late — but *unpacked extensions are exempt*, so a short alarm looks instant in
development and becomes a half-minute wait once packaged. Anything that must happen now
(re-checking after marking read, a token change, waking from idle) therefore runs
in-process via `check.execute()`; alarms carry only the durable periodic schedule. See
`core/repeater.js`.

**Each browser warns about the other's background key.** Chrome says
`'background.scripts' requires manifest version of 2 or lower`; Mozilla's `web-ext lint`
says `BACKGROUND_SERVICE_WORKER_IGNORED`. Both are expected and neither is a defect —
they are the two halves of the dual-key manifest seeing each other's half. Otherwise the
extension lints clean: 0 errors, 0 notices.

**Chrome warns: `'background.scripts' requires manifest version of 2 or lower`.**
Expected, and the manifest is correct. Firefox does not support
`background.service_worker` at all ([bug 1573659](https://bugzil.la/1573659)), so
`background.scripts` is the only way it can run an MV3 background script. Chrome 121+
ignores the key rather than refusing to load, and specifying both is MDN's documented
cross-browser MV3 pattern. Leave it: removing it would silence the warning at the cost of
breaking the Firefox port before it starts.

**Some senders' images show as broken icons.** Not a bug in the extension. A few
origins serve their images with `Cross-Origin-Resource-Policy: same-origin`, which
forbids *any* cross-origin document from loading them; Chrome reports
`net::ERR_BLOCKED_BY_RESPONSE.NotSameOrigin`. Anthropic's `claude.ai` email assets are
one such case. Fastmail's own web UI displays them only because webmail proxies remote
images server-side, where CORP does not apply. Nothing client-side can make a direct
load succeed.

**Changes don't appear after editing a file.** Chrome does not hot-reload unpacked
extensions. Hit the reload arrow on the extension's card in `chrome://extensions` after
any edit. Nothing in the UI indicates it is running stale code, so this is easy to lose
time to. Reloading also clears `chrome.storage.session`, so the badge may flash an amber
`!` while it re-bootstraps the session from the token; the token is in `storage.local` and
survives.

## Privacy: remote images

Previews load remote images by default, so mail looks the way the sender intended. That
means opening one can fire a tracking pixel. **Options → Message preview → Load remote
images** turns it off, after which a preview makes no request to the sender at all:
`src`, `srcset`, `<style>` blocks and inline `style` declarations containing `url()` are
all stripped, since CSS can fetch remote URLs just as readily as an `<img>`. Blocked
images are **removed entirely** rather than just losing their `src` — a src-less `<img>`
still takes up layout as alt text or an empty box sized by its `width`/`height`. A
one-line notice reports how many were withheld, so nothing disappears silently.

No probing is involved: with the setting off there is nothing to detect, because the
images are never requested in the first place.

Inline `cid:` attachments still display either way — those come from Fastmail over an
authenticated request, not from the sender's server.

## Design notes

- **One round trip per poll.** `Mailbox/get` + `Email/query` + `Email/get` go in a
  single JMAP request, chained with a `#ids` back-reference. Mailbox ids are
  resolved once and cached for the session, because a back-reference can only
  replace a whole argument — not a key nested inside `filter`.
- **Mailboxes are found by `role`, never by name.** Names are localised and users
  have custom folders.
- **Never hardcode the API host.** The session object returns a region-specific
  `apiUrl` (e.g. `phl.api.fastmail.com`).
- **Body parts are rendered in order, each sanitised in isolation.** RFC 8621 defines
  `htmlBody`/`textBody` as ordered *lists* of parts to display in sequence, so taking only
  the first silently drops content. `core/bodyparts.js` selects them; the popup sanitises
  each part separately, because joining raw values first would let one part's unclosed
  markup swallow the next.
- **A poll's results are discarded if the token changed while it was in flight.**
  Guarding the session cache is not enough on its own: without also re-checking the
  generation before publishing, a removed account's mail could reach the badge, the popup
  and a notification, and stay there until the next poll.
- **Cached session data is stamped with a token generation.** Changing the token bumps a
  counter; a bootstrap already in flight will not publish its result if the counter moved
  underneath it. Without this, replacing the token mid-poll could pair the new token with
  the old account's `apiUrl`/`accountId` — a mismatch JMAP reports as an ordinary method
  error, which is treated as transient and so would never clear itself.
- **"New mail" is judged by delivery time, not just by an unseen id.** `Email/query`
  returns only the newest page, so once the unread count exceeds `LIMIT`, reading a recent
  message rotates an older one into view for the first time. Comparing `receivedAt`
  against the last successful check is what stops that being announced as new.
- **Nothing mutable in module scope.** The MV3 service worker is torn down
  constantly; state lives in `chrome.storage.session` / `.local`, behind
  `core/state.js`.
- **The message body iframe cannot script.** `sandbox` omits both `allow-scripts`
  and `allow-same-origin`, so sender HTML gets an opaque origin and no reach into
  the token or `chrome.*`. Links work via `<base target="_blank">` + `allow-popups`.
- **Deep links need only the email id.** `/mail/Inbox/<emailId>` opens a message and
  Fastmail canonicalises the URL to `<threadId>.<emailId>` itself. An id it does not
  recognise degrades to the folder view rather than erroring, so the link is always safe
  to attempt. The `?u=` account key is the JMAP `accountId` minus its leading `u`
  (`u1a2b3c4d` ↔ `?u=1a2b3c4d`), and is omitted when the accountId has some other shape.
- **Inline `cid:` images become `data:` URLs.** They live behind an authenticated
  `downloadUrl`, and a sandboxed `<img>` cannot send a Bearer header — while
  `blob:` URLs are origin-scoped and unreadable from an opaque origin.

## Tests

```
node test/run.js     # core logic, no dependencies
node test/dom.js     # popup + options against a real DOM (needs: npm install)
npm test             # both
```

The core suite deliberately needs **nothing installed** — a clean checkout and `node` are
enough. Only the DOM suite depends on jsdom, and it is a dev dependency: the extension
itself still ships with no dependencies and no build step.

`test/run.js` runs the real `core/` modules against a mocked extension API and a mocked Fastmail —
no token, no network. **Every test runs twice**, once against a simulated Chrome and once
against a simulated Firefox that exposes only `browser` and rejects the
NotificationOptions Firefox does not implement. That is what makes the Firefox port
verifiable without launching Firefox: reintroducing `contextMessage` makes the Firefox
pass fail while Chrome still succeeds. Covers the logged-out and bad-token paths, badge counts,
query ordering, backlog suppression, the VIP filter, silencing, the JMAP write
patches, and transient-failure behaviour.

## Status

Working in both browsers from one codebase, with no build step and no dependencies.

| | Chrome 152 | Firefox 155 |
|---|---|---|
| Unread badge | verified | verified |
| Preview popup, prev/next | verified | verified |
| HTML bodies with images | verified | verified |
| Mark read | verified | verified |
| Desktop notifications | verified | verified |
| Move to Trash, deep links | verified | untested (same code path as mark read) |

**Polling is the intended design, not a placeholder.** JMAP push via `eventSourceUrl`
was considered and deliberately declined. It would cut badge latency to near zero, but a
poll costs one small request a minute and already works; push would need an `EventSource`
held in an MV3 offscreen document — racy to create, requiring a busy flag and queue,
self-terminating on idle — and Firefox has no `offscreen` API at all, so it would need a
hidden-iframe shim as well. Alarms would still be required as a fallback. Not worth it
for a minute of latency. Don't "finish" this.
