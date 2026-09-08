# Fastmail Checker

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

## Where the token lives

In `chrome.storage.local`, which is **unencrypted on disk** in your browser
profile — the same as any extension setting. Anyone who can read that profile
directory can read the token, and a mail-scoped token can read and delete mail.
The options page never displays it back (only the last four characters), and if
the machine is ever compromised you can
[revoke it](https://app.fastmail.com/settings/security/tokens) with immediate
effect.

## Two things that look like problems but aren't

**Chrome warns: `'background.scripts' requires manifest version of 2 or lower`.**
Expected, and the manifest is correct. Firefox does not support
`background.service_worker` at all ([bug 1573659](https://bugzil.la/1573659)), so
`background.scripts` is the only way it can run an MV3 background script. Chrome 121+
ignores the key rather than refusing to load, and specifying both is MDN's documented
cross-browser MV3 pattern. Leave it: removing it would silence the warning at the cost of
breaking the Firefox port before it starts.

**Changes don't appear after editing a file.** Chrome does not hot-reload unpacked
extensions. Hit the reload arrow on the extension's card in `chrome://extensions` after
any edit. Nothing in the UI indicates it is running stale code, so this is easy to lose
time to. Reloading also clears `chrome.storage.session`, so the badge may flash an amber
`!` while it re-bootstraps the session from the token; the token is in `storage.local` and
survives.

## Design notes

- **One round trip per poll.** `Mailbox/get` + `Email/query` + `Email/get` go in a
  single JMAP request, chained with a `#ids` back-reference. Mailbox ids are
  resolved once and cached for the session, because a back-reference can only
  replace a whole argument — not a key nested inside `filter`.
- **Mailboxes are found by `role`, never by name.** Names are localised and users
  have custom folders.
- **Never hardcode the API host.** The session object returns a region-specific
  `apiUrl` (e.g. `phl.api.fastmail.com`).
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
node test/run.js
```

Runs the real `core/` modules against a mocked `chrome.*` and a mocked Fastmail —
no token, no network. Covers the logged-out and bad-token paths, badge counts,
query ordering, backlog suppression, the VIP filter, silencing, the JMAP write
patches, and transient-failure behaviour.

## Status

Chrome MV3, working. The manifest already carries a Firefox `background.scripts`
key and `browser_specific_settings`, so the Firefox port should be small.
Not yet done: EventSource push (`eventSourceUrl`) instead of polling.
