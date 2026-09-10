# Chrome Web Store submission notes

Fields the console asks for, drafted. Package built by `tools/package-chrome.py`.

## Single purpose

> Show the number of unread Fastmail messages on the toolbar, and let the user
> read, mark read, delete or open those messages without leaving the page they
> are on.

Everything the extension does serves that one purpose: the badge is the count,
the popup is the reading surface, and notifications announce arrivals.

## Store description (user-facing)

See how much unread mail is waiting, and read it, without opening a tab.

- **Unread count on your toolbar.** A badge shows how many messages are waiting,
  kept up to date in the background.
- **Read without switching tabs.** Click the icon for a preview window and flip
  through your unread mail — full HTML, images and all. Close it and it reopens
  where you left off.
- **Act on a message there and then.** Mark it read, send it to Trash, or open it
  in Fastmail.
- **Check whenever you like.** Right-click the toolbar icon and choose *Check
  now* rather than waiting for the next scheduled poll.
- **Watch the folders you care about,** not just the Inbox. Have an *Important*
  folder? Tick it, untick the Inbox, and hear about nothing else.
- **Desktop notifications on your terms.** Optional, and can be limited to
  specific senders so only the people who matter interrupt you.
- **Block tracking pixels.** Turn remote images off and opening a message sends
  nothing to the sender — no pixel, no IP address, no read receipt. Images
  attached to the message still display, because those come from Fastmail.
- **Your mail stays yours.** Nothing is collected, and nothing is sent anywhere
  except your own Fastmail account.

Requires a Fastmail account and an API token, which is free to create and takes
about a minute in Settings → Privacy & Security → API tokens.

Not affiliated with or endorsed by Fastmail.

## Permission justifications

**storage** — Stores the user's Fastmail API token, their settings (poll
interval, badge color, which folders to watch, notification preferences), and
the most recent poll's results so the popup can open instantly. All of it stays
in the browser profile; none is sent anywhere but Fastmail.

**alarms** — Schedules the periodic check for new mail. An MV3 service worker is
torn down when idle, so `setTimeout` cannot carry a recurring poll; alarms are
the only mechanism that survives teardown. One alarm, re-armed after each check.

**idle** — Refreshes the unread count when the user returns to their machine, so
the badge is current rather than showing whatever it last saw before the machine
went to sleep. Used solely to trigger that refresh; no idle data is recorded.

**notifications** — Shows a desktop notification when new mail arrives, if the
user enables it. Off unless configured, and filterable to specific senders.

**contextMenus** — Adds a single *Check now* entry to the extension's own
toolbar button, so the user can poll for mail immediately instead of waiting out
the rest of the interval. One item, on the `action` context only: it appears on
this extension's button and nowhere else in the browser, and no page content is
read or modified.

**host permission: https://api.fastmail.com/** — Fastmail's JMAP session
endpoint. Every request begins here to discover the account's API URL.

**host permission: https://*.api.fastmail.com/** — The account's actual JMAP API
endpoint. Fastmail assigns each account a region-specific host (for example
`phl.api.fastmail.com`), returned by the session endpoint above and not knowable
in advance, so the subdomain cannot be narrowed further.

**host permission: https://*.fastmailusercontent.com/** — Serves inline image
attachments. Fetching these is what allows an embedded image to display in the
preview without the extension ever contacting the message's sender.

**remote code** — None. No code is fetched, evaluated or generated at runtime.
Everything that executes is in the package, unminified and unbundled.

## Privacy policy URL

https://github.com/ikryten/fastmail-notifier/blob/master/docs/PRIVACY.md

## Data usage disclosure

- **Authentication information** — the user's Fastmail API token. Stored in the
  browser profile and sent only to Fastmail, to authenticate their own requests.
- **Personal communications** — the subjects, senders and bodies of the user's
  own mail, fetched from Fastmail to display in the preview. Held only for as
  long as the popup needs them and never transmitted anywhere.

Not sold, not transferred to third parties, not used for advertising, not used
for creditworthiness or lending. No analytics, no telemetry, no remote endpoint
other than the user's own Fastmail account.

## Listing metadata

- **Category:** Workflow & Planning (alt: Communication)
- **Screenshots:** `docs/popup.png`, `docs/options.png`
- **Homepage / support:** https://github.com/ikryten/fastmail-notifier

## Differences from the repository manifest

`tools/package-chrome.py` removes two Firefox-only keys, so the reviewer sees
only what Chrome actually uses:

- `background.scripts` — Firefox MV3 uses event pages; Chrome warns about this key
- `browser_specific_settings` — the Gecko id, minimum version and data collection
  declaration. Firefox-only metadata, and nothing to do with updates: both builds
  are store-delivered now, the Web Store here and addons.mozilla.org there

The `contextMenus` permission was stripped here too until *Check now* was added.
Back then the only menu item was Options, which Chrome puts on the action button
itself, so the Chrome build never built a menu at all. It now does, and the
permission ships with it — the manifest the reviewer sees and the one in the
repository declare the same five permissions.

No other transformation: no bundling, no minification, no generated code.
