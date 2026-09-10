# Privacy Policy — Fastmail Notifier

**Last updated: 8 September 2026**

Fastmail Notifier is a browser extension that shows your unread Fastmail count and
lets you read that mail. It has no servers. There is no account to create, no
analytics, and no telemetry. Everything it stores stays in your own browser
profile, and the only party it talks to is Fastmail — with one exception,
described under *Remote images* below, which you can switch off.

Not affiliated with or endorsed by Fastmail.

## What is stored, and where

Everything lives in your browser's own extension storage. Nothing is written
anywhere else.

**Kept until you remove it** (`storage.local` — survives restarts):

| Data | Why |
|---|---|
| Your Fastmail API token | To authenticate your own requests to Fastmail |
| Your settings | Check interval, badge color, which folders to watch, notification and VIP preferences, the remote-images toggle |
| Ids of messages already announced | So a restart does not re-notify you about mail you have already seen. Capped at 500 |
| Time of the last check | To tell newly arrived mail from mail that was already there |

**Cleared when you close the browser** (`storage.session`):

| Data | Why |
|---|---|
| Your Fastmail session details | The account's API address, so every poll does not have to rediscover it |
| Your mailbox list | To resolve the folder names you chose to watch |
| The current unread messages | Sender, subject, date, preview and folder, so the popup opens instantly |
| The unread count and per-folder breakdown | The badge and its tooltip |
| Notification-silencing deadline | If you have silenced notifications for a period |
| Which message the preview window was showing | So reopening it returns you to where you were reading |

The API token is stored unencrypted, like any browser extension setting. If your
machine is ever compromised, revoke the token in Fastmail's settings — it takes
effect immediately.

## What is sent, and to whom

**To Fastmail, and only about your own account:**

- `api.fastmail.com` — to look up your account's API address
- your account's regional API host, for example `phl.api.fastmail.com` — to fetch
  unread counts and messages, and to mark read or move to Trash when you ask
- `*.fastmailusercontent.com` — to fetch images attached to a message you open

Each request carries your API token so Fastmail knows it is you. Nothing else is
attached, and no request carrying it goes anywhere else. Two things reach a
different host, and both are described below.

**Remote images — the one exception.** Email often references images hosted on the
sender's own servers. When *Load remote images* is on, which is the default,
opening a message in the preview fetches those images, and the sender's server
learns your IP address and that you opened the message. This is how email works
everywhere, not something specific to this extension, but it is a real
third-party request and you should know about it.

Turn it off in **Options → Message preview → Load remote images** and opening a
message makes no request to the sender at all. Images actually attached to the
message still display, because those come from Fastmail rather than the sender.

**Links you click** in a message open in a new tab, as they would from any mail
client. That request goes wherever the link points, at your instruction.

**Update checks, made by the browser rather than by this extension.** From 1.0.3
the Firefox build is listed on addons.mozilla.org, so Firefox checks Mozilla for
updates the way it does for any add-on you install from there. Chrome does the
same through the Web Store. Those requests come from the browser itself, on its
own schedule, and carry no token and nothing about your mail.

Firefox builds up to 1.0.2 were distributed from GitHub instead, and an install
from that era still reads a small file from `raw.githubusercontent.com` on the same
schedule. That request tells GitHub only what fetching any public URL tells it:
your IP address and roughly when you checked. It stops once you install from
addons.mozilla.org.

## What this extension does not do

- No analytics, telemetry, crash reporting, or usage statistics
- No servers operated by the author — there is nowhere for data to go. The update
  check above reads a static file from GitHub and sends nothing
- Your data is never sold, rented, or transferred to anyone
- No advertising, no profiling, no tracking across sites
- No remote code: nothing is downloaded, evaluated, or generated at runtime.
  Everything that runs ships in the package, unminified

## Keeping and deleting your data

- Session data is discarded when you close your browser
- Settings and the token persist until you remove them
- **Replace** on the options page clears the stored token and the cached account
  data with it
- Uninstalling the extension removes everything it has stored
- Revoking the token in Fastmail's settings cuts off access immediately,
  regardless of what is stored locally

## Permissions

`storage` keeps your token and settings. `alarms` schedules the periodic check.
`idle` refreshes the count when you return to your machine — it is told only
whether you are active, never what you are doing. `notifications` shows new-mail
alerts, if you enable them. `contextMenus` puts a *Check now* entry on the
toolbar button's right-click menu, and on Firefox an *Options* entry beside it,
which Chrome already provides itself; the menu appears on this extension's own
button and nowhere else. The Fastmail host permissions are what let the extension
reach your account. None of these is used
for any other purpose.

## Changes

Material changes will be recorded in this file, and its history is public in the
repository, so you can see exactly what changed and when.

## Contact

Questions or concerns: https://github.com/ikryten/fastmail-notifier/issues
