# Fastmail Notifier

An unread-mail notifier for Fastmail, in the spirit of
[ignotifier](https://github.com/inbasic/ignotifier): a toolbar badge with the
unread count, and a preview window you can flip through unread mail in.

*Not affiliated with or endorsed by Fastmail. It is an independent extension that
talks to Fastmail's public JMAP API with a token you create yourself.*

![The preview window: one unread message with its sender, subject, an Inbox folder
chip and a "24 of 24" counter, above the rendered message body, with Mark read,
Trash, Open and Inbox buttons along the bottom](docs/popup.png)

## Install

**Firefox.** Paste the `.xpi` link from
[Releases](https://github.com/ikryten/fastmail-notifier/releases) into the address bar on
any machine and Firefox installs it there and then — GitHub serves the asset as
`application/x-xpinstall`, so there is no download step and no file to copy around.
Mozilla countersigns it for self-distribution, so it installs permanently and survives
restarts.

From 1.0.1 onward it keeps itself current. AMO delivers updates only for the add-ons it
hosts, so a self-distributed one has to say where to look: the manifest's `update_url`
points at [`updates.json`](updates.json) in this repository, and Firefox reads it on its
own schedule. Nothing is sent in that request, and `test/release.js` fails the build if
that file and the manifest ever disagree about the current version.

Requires **Firefox 142+** (`strict_min_version`), the floor for
`data_collection_permissions` — the extension declares `"required": ["none"]`. It sends
nothing to any third party, and the only host it talks to itself is your own Fastmail
account.

**Chrome.** Not on the Chrome Web Store, so for now the only route is the unpacked
developer install described under [Running from source](#running-from-source).

Either way, you need a Fastmail API token:

1. **Create a token.** In Fastmail: Settings → Privacy & Security →
   [API tokens](https://app.fastmail.com/settings/security/tokens) → *New API
   token*, with the **Mail** scope. Read-only is enough for the badge; marking
   read and moving to Trash need read-write.
2. **Paste the token** into the extension's options page and hit *Verify & save*.
   It is checked against Fastmail before it is stored.

<details>
<summary>What the options page looks like</summary>

![The options page: connection with a masked token, check interval, badge color,
the folder picker with Inbox ticked, notification and VIP settings, the remote
images toggle, and the new-tab behavior switch](docs/options.png)

</details>

## Running from source

**For development, and currently the only way to run it in Chrome.** Both browsers load
this directory as it stands — there is no build step and nothing to compile.

**Chrome:** `chrome://extensions` → enable *Developer mode* → *Load unpacked* → select
this directory.

**Firefox:** `about:debugging` → **This Firefox** → **Load Temporary Add-on…** → pick
`manifest.json`. Or, for a throwaway profile: `npm install` then `npm start`.

A temporary add-on is removed when Firefox restarts, and you will need to paste the API
token again — a different profile means different storage. That is a property of the
development install only; the signed `.xpi` above does not behave this way. Firefox 127+
grants the declared host permissions at install; they can be revoked ad hoc from
`about:addons`, so if requests start failing there, check that first.

To build your own copy, `npm ci` then `npm run build`. The packaging tool is
pinned in `package.json` and reads its file list from `web-ext-config.cjs`, so the
result does not depend on what happens to be installed globally. `npm run sign`
does the same and submits it to Mozilla for signing, which needs an AMO API key.

## One manifest, two browsers

How the single manifest serves both:

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

## Replacing the token

Cached session data is stamped with a **token generation** — a random id, reissued on
every token change — and every poll carries the generation it started under. Results,
failures and notifications are all fenced against it, so a request still in flight when
you swap tokens cannot publish the old account's mail, cannot log out the new token with
the old one's 401, and cannot leave the old account's session cached under the new
token's identity.

The token and its generation are read in **one** storage operation. Reading them
separately is a real race: a swap landing between the two reads hands the poll one
account's token with the other's generation, after which every fence downstream believes
the stale results are current. The generation is a random id rather than a counter for a
related reason — read-increment-write is not a transaction, so two options tabs saving at
once would both write the same successor and give two different tokens one identity.
Nothing here needs ordering, only difference.

Replacing a token also clears the previous account's results immediately, rather than
waiting for a poll under the new token to succeed. Otherwise the old account's badge and
messages stayed on screen indefinitely if the new token never connected.

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
`alarms` to a 30 second floor, and `when` values nearer than that are honored silently
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

## Getting back to Options when the token dies

If Fastmail revokes or disables the token, the extension is authenticated no more but the
token is still *stored* — so a naive "have we got a token?" check passes and clicking the
toolbar button would open webmail, which is no help at all. The button now opens Options
whenever the last check came back unauthenticated.

Firefox additionally gets an **Options** item on the toolbar button's context menu.
Chrome adds one of those itself for any extension declaring `options_ui`; Firefox does
not, so the item is created only on Gecko — detected with `runtime.getBrowserInfo`, a
Firefox-only API, rather than by sniffing the user agent.

## Folders to watch

**Options → Folders to watch** lists your mailboxes. A ticked folder is counted on the
badge, its unread mail appears in the preview window, and it can raise a desktop
notification. The Inbox is ticked by default and is an ordinary row — **untick it** and
you hear only about the folders you chose, which is the point: an *Important* or VIP
folder can be the only thing that reaches you.

This costs no extra requests. A poll already issues a `Mailbox/get` for the Inbox's
`unreadEmails` and an `Email/query` for its unread mail; watching more folders just
lengthens the `ids` array and turns the query filter into an `OR`:

```js
{operator: 'AND', conditions: [
  {operator: 'OR', conditions: [{inMailbox: inboxId}, {inMailbox: folderId}]},
  {notKeyword: '$seen'}
]}
```

A single watched mailbox keeps the plain `{inMailbox, notKeyword}` condition it always
used, so the default configuration sends exactly the request it sent before. Either way
it is **one HTTP round trip per poll**, however many folders are ticked.

Because the list can now span folders, each message in the preview carries a small chip
naming the one it came from. A message in several mailboxes shows the Inbox in
preference, so inbox mail that is also filed elsewhere still reads as inbox mail.

Notifications are unchanged in kind: the global toggle and the VIP sender filter still
apply on top, several messages arriving in one poll still collapse into a single digest
(now saying `+ N more` when there are more than it can list), and a lone new message
names its folder when more than one is being watched.

### Watching nothing

Unticking everything is allowed — it is a reasonable way to mute the extension without
removing the token — but never silently. The poll then **skips the network entirely**
(there is nothing to ask for, and an `OR` with no conditions is not a valid filter), the
options page warns, and the tooltip says so. It deliberately does *not* use the amber `!`
badge, which means the token is dead; this is a working connection watching nothing.

The check still stamps its timestamp on that path. Skipping it would leave a stale
freshness floor behind, so re-enabling a folder after a quiet week would announce that
entire week of backlog as new mail.

Skipping the network entirely has one consequence worth naming: with a warm session cache
the token is never presented to Fastmail, so a **revocation would go unnoticed** and the
toolbar click would keep opening webmail instead of Options — the dead end this extension
already fixed once. So while nothing is watched, a poll re-bootstraps the session if the
last authenticated round trip is more than fifteen minutes old. That is one cheap GET per
quarter hour, against one POST a minute in normal operation, and it is tracked separately
from the freshness floor: an authentication timestamp must only move when the server
actually accepted us.

### How folders are stored

**Names, not mailbox ids.** Ids are opaque and account-scoped: stored ids would quietly
stop matching the moment the token pointed at a different account, with nothing on screen
to explain the wrong number. A full `Parent/Child` path always wins; a bare leaf name
matches only when it is unique across the account, since two folders both called `Notes`
are genuinely ambiguous and silently picking one would put a wrong number on the badge.
Names that match nothing — a renamed folder, a deleted one, an ambiguous leaf — are listed
as **not found** and left ticked, so a setting you made stays visible and is removed
deliberately rather than vanishing. They count as watching nothing, so a user whose only
saved folder was deleted gets the warning above rather than a silent zero.

The Inbox is the exception, held in its own `watchInbox` setting rather than by name. JMAP
identifies it by `role`, and mailbox names are localized — on a French account the role is
still `inbox` while the name is `Boîte de réception` — so a name is not a portable way to
refer to it. Keeping it separate also means an existing profile, which has no `watchInbox`
key at all, falls through to the default and keeps watching the Inbox exactly as before.

The picker is populated from the account's own mailbox list (`Mailbox/get` with
`ids: null`, which the session already fetches and caches). If that list cannot be reached
— no token yet, or Fastmail unreachable — it falls back to a comma-separated text field,
with the Inbox tick still on screen above it, since the Inbox cannot be named in that
field.

Deep links are unaffected by any of this. `/mail/Inbox/<emailId>` opens a message that
lives only in another folder just as well: the `/Inbox/` segment names the view to open,
not a constraint on the lookup, so no folder path has to be threaded into the URL.

A watched folder deleted in Fastmail is a sharper problem than it looks: its stale id now
goes into the `Email/query` **filter**, not just `Mailbox/get`'s ids, and a method-level
rejection there fails the whole poll rather than one count — for the rest of the browser
session, since the mailbox list is cached. So a JMAP-level failure drops that cache, and
the next poll re-resolves and recovers.

### What the badge counts, and one caveat

The badge counts **distinct messages**, taken from `Email/query`'s own `total`. Summing
each mailbox's `unreadEmails` would count a message filed in two watched folders twice
while the preview showed it once — easy to hit now that the Inbox is in the watch set.
`calculateTotal` was already being requested and discarded, so the correct number cost
nothing. The per-folder tooltip lines are still per-mailbox counters, and with overlapping
folders they will not add up to the header; that is the overlap being visible, not an
error.

"Unread" means what JMAP means by it: mail carrying **neither `$seen` nor `$draft`**
(RFC 8621's definition of `Mailbox.unreadEmails`). Filtering on `$seen` alone let an
unsent draft into the preview and into notifications while contributing nothing to the
count it was supposedly part of — reachable simply by watching Drafts, which the picker
offers like any other mailbox.

The one caveat left: the preview is one page of 50 messages shared across every watched
folder, so a chatty folder can push quieter mail off the end. That costs visibility in the
popup, not correctness — the badge is not the length of that page, and the freshness floor
means rotated-in mail is never announced as new.

That second point is subtler than it looks and is the reason the floor exists at all. Once
the unread count exceeds one page, reading any message pulls the next one into view **for
the first time** — absent from `seen-ids`, because we have genuinely never seen it. Judging
by delivery time as well as by `seen-ids` is the only thing that stops a months-old message
being announced as a new arrival every time you read something.

### Deliberately not done

Ticking a folder can announce a message that arrived shortly *before* you ticked it: it is
absent from `seen-ids` and newer than the freshness floor. This is not treated as a bug.
You have just asked to hear about that folder and there is recent mail in it; announcing
it is the useful behavior, and a burst collapses into one digest anyway. The alternative
— a per-mailbox "first snapshot" baseline — means persistent state that has to be pruned
as folders come and go, for a marginal gain. Don't "fix" this.

## Privacy: remote images

The full privacy policy is in [docs/PRIVACY.md](docs/PRIVACY.md); this section is
the engineering detail behind it.

Previews load remote images by default, so mail looks the way the sender intended. That
means opening one can fire a tracking pixel. **Options → Message preview → Load remote
images** turns it off, after which a preview makes no request to the sender.

That guarantee is enforced in two independent layers, because the obvious way to do it —
enumerate the attributes that fetch things and strip them — was found wrong twice.

**A Content-Security-Policy on the rendered document.** The generated `srcdoc` carries
`default-src 'none'`, with `img-src`/`media-src`/`font-src` limited to `data:` when remote
content is off. This closes the whole class at once, whatever the sanitizer missed, and
also rules out frames, plugins and form submission. A `srcdoc` frame otherwise inherits
only the MV3 default policy, which constrains scripts and says nothing about images.

**An allowlist in the sanitizer.** Every URL-bearing attribute — `src`, `poster`, `data`,
`background`, `xlink:href`, SVG `href` and the rest — is routed through `urls.safeSrc`,
which ends in `return null`: an attribute nobody anticipated is dropped, not kept. This
replaced a denylist that ran only `img[src]` through the allowlist and checked everything
else against a list of dangerous schemes, which meant `https:` sailed through on
`<video poster>`, `<audio src>`, `<source>`, `<track>` and SVG `<image>` — and `xlink:href`
matched no branch at all, so it was never even scheme-checked. A link's `href` is the one
exception: navigation is not a fetch, so links keep working with images off.

Media elements and remote images are **removed entirely** rather than stripped of their
sources — a src-less `<img>` still takes up layout as alt text or an empty box, and a
`<video>` keeps its controls. CSS is checked for `url()`, `image-set()`, `@import` and
backslash escapes, since a CSS escape can spell `url(` without containing it. A one-line
notice reports how many things were withheld, and everything blocked is now counted: the
worst part of the old behavior was that several of these were stripped silently, so the
reader was told nothing had been withheld while five pixels fired.

No probing is involved: with the setting off there is nothing to detect, because the
images are never requested in the first place.

Inline `cid:` attachments still display either way — those come from Fastmail over an
authenticated request, not from the sender's server.

## Design notes

- **One round trip per poll.** `Mailbox/get` + `Email/query` + `Email/get` go in a
  single JMAP request, chained with a `#ids` back-reference. Mailbox ids are
  resolved once and cached for the session, because a back-reference can only
  replace a whole argument — not a key nested inside `filter`.
- **Mailboxes are found by `role`, never by name.** Names are localized and users
  have custom folders.
- **American spelling throughout,** in comments and test names as much as in the
  interface. See [CLAUDE.md](CLAUDE.md) for the conventions a patch is expected
  to follow.
- **Never hardcode the API host.** The session object returns a region-specific
  `apiUrl` (e.g. `phl.api.fastmail.com`).
- **Body parts are rendered in order, each sanitized in isolation.** RFC 8621 defines
  `htmlBody`/`textBody` as ordered *lists* of parts to display in sequence, so taking only
  the first silently drops content. `core/bodyparts.js` selects them; the popup sanitizes
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
  recognize degrades to the folder view rather than erroring, so the link is always safe
  to attempt. The `?u=` account key is the JMAP `accountId` minus its leading `u`
  (`u1a2b3c4d` ↔ `?u=1a2b3c4d`), and is omitted when the accountId has some other shape.
- **Inline `cid:` images become `data:` URLs.** They live behind an authenticated
  `downloadUrl`, and a sandboxed `<img>` cannot send a Bearer header — while
  `blob:` URLs are origin-scoped and unreadable from an opaque origin.

## If you're thinking about multi-account support

Wanted, not done. Contributions welcome — but check which of two quite different features
you actually need first, because one is roughly a day's work and the other is the largest
change since the Firefox port.

**(a) Several JMAP accounts under one token** — a shared or delegated mailbox. RFC 8620's
session object already carries an `accounts` map, and another user's mailbox shows up in
it flagged `isPersonal: false`, usually `isReadOnly: true`. `jmap.bootstrap` reads
`primaryAccounts['urn:ietf:params:jmap:mail']` and **discards `j.accounts` entirely**, so
the data is already arriving and being thrown away.

**(b) Several Fastmail logins, one token each.** Much bigger.

Which one you are in is decided by your own session response, not by your plan — Duo and
Family look like billing and administration constructs, so being on one probably does not
by itself put the other members in your `accounts` map. One command settles it:

```
curl -s -H "Authorization: Bearer $TOKEN" https://api.fastmail.com/jmap/session \
  | python3 -c "import json,sys; print(json.dumps(json.load(sys.stdin)['accounts'], indent=2))"
```

More than one entry means (a). If so, three things make it cheap, and they are worth
knowing before you start:

- **One token means the token-generation fencing stays exactly as it is.** That machinery
  (see *Replacing the token*) is the subtlest code in the repo. Under (a) there is still
  one token, one credential snapshot, one generation, and none of it has to generalise.
  Under (b) it must become per-account, which is where the real bugs will be.
- **`accountId` is an ordinary argument on every method call, and one request holds many**
  (Fastmail advertises `maxCallsInRequest: 32`). So N accounts is still **one HTTP round
  trip per poll** — 3N method calls instead of 3. Do not reach for a request per account;
  the single round trip is the property this design is built around.
- `isReadOnly` is in the session, so the popup can disable **Mark read** and **Trash** for
  a shared mailbox rather than failing at write time; and `downloadUrl` already templates
  `{accountId}`, which `cid:` inline images already rely on.

Either way the remaining work is the same shape: carry an `accountId` on each summarized
message through to the `body`/`markRead`/`trash` handlers, group the folder picker by
account, add an account level above the folder level in the tooltip breakdown, and make
notification ids `fmc:<accountId>:<emailId>` so a click opens the right mailbox.

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
patches, folder-name resolution, multi-mailbox query shapes, the empty watch set, and
transient-failure behavior.

## Status

Working in both browsers from one codebase, with no build step and no dependencies.

| | Chrome 152 | Firefox 155 |
|---|---|---|
| Unread badge | verified | verified |
| Preview popup, prev/next | verified | verified |
| Preview reopens where you left off | verified | verified |
| HTML bodies with images | verified | verified |
| Mark read | verified | verified |
| Desktop notifications | verified | verified |
| Move to Trash, deep links | verified | verified |
| Watched folders: badge, preview, notifications | verified | verified |
| Deep link to non-inbox mail | verified | verified |
| Remote content fully blocked | verified | verified |
| Idle token revalidation | verified | verified |

**Polling is the intended design, not a placeholder.** JMAP push via `eventSourceUrl`
was considered and deliberately declined. It would cut badge latency to near zero, but a
poll costs one small request a minute and already works; push would need an `EventSource`
held in an MV3 offscreen document — racy to create, requiring a busy flag and queue,
self-terminating on idle — and Firefox has no `offscreen` API at all, so it would need a
hidden-iframe shim as well. Alarms would still be required as a fallback. Not worth it
for a minute of latency. Don't "finish" this.

## License

[Mozilla Public License 2.0](LICENSE).
