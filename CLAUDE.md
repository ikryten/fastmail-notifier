# Conventions

Notes for anyone — human or agent — writing code here.

## Spelling

**American English, everywhere.** Not just in the user interface: comments, test
names, commit messages and identifiers too. The repo was mixed until commit
`a0d72b3`, and a split where the label says "color" while the comment beside it
says "colour" is worse than either choice on its own.

The forms that were actually in this codebase, so they are the ones likely to
come back: color, behavior, honor, localized, normalized/normalizing,
recognize/unrecognized, sanitize/sanitized/sanitizer/sanitization, summarize,
defense, labeled, gray, license (the noun as well as the verb; never
"licence").

## Structure

- **No build step and no runtime dependencies.** The unpacked directory is the
  extension. `node test/run.js` must work on a clean checkout with nothing
  installed. Everything in `devDependencies` is for testing or releasing and
  never reaches a browser: jsdom for `test/dom.js`, web-ext for the Firefox
  package. `npm audit --omit=dev` is therefore the only audit that means
  anything here; advisories inside web-ext's own tree do not affect users.
- **One codebase, both browsers.** `manifest.json` carries both a
  `background.service_worker` (Chrome) and `background.scripts` (Firefox); adding
  a file to one means adding it to the other and to `importScripts` in
  `worker.js`. `tools/package-chrome.py` produces the Chrome Web Store zip.
- **Nothing mutable in module scope.** An MV3 service worker is torn down
  constantly. State goes through `core/state.js`, which is the only module that
  touches `api.storage`.

## Releasing

The Firefox build is listed on addons.mozilla.org from 1.0.3, so Mozilla reviews
each version and delivers updates. Before that it was self-distributed from GitHub
releases, with `update_url` pointing at `updates.json` here; that file is still in
the repository, frozen, and the reasons are below.

1. `npm ci`, then bump `version` in `manifest.json` and `package.json` (they must
   match). AMO refuses a version number it has already seen, on either channel, so
   a bounced submission still burns the number.
2. `npm run lint` — zero errors. One `BACKGROUND_SERVICE_WORKER_IGNORED` warning
   is expected and correct: the key is there for Chrome.
3. `npm test`. `test/release.js` is what stops `update_url` coming back and what
   keeps `updates.json` from being extended.
4. `npm run sign`, with `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` set from the
   AMO credentials. On the listed channel this submits the version for review
   rather than countersigning on the spot, so it can sit in the queue for days.
   `--approval-timeout=0` is why the command returns instead of waiting: the
   default is fifteen minutes, which a review queue overruns, and a timeout there
   looks like a failed submission when the upload in fact succeeded. Nothing is
   downloaded either, because a listed add-on is distributed by AMO rather than
   from here. Release notes and any listing changes go in through the Developer
   Hub.

   `--amo-metadata=tools/amo-metadata.json` supplies the license, which AMO
   requires on every listed version and rejects the submission for omitting. It
   lives under `tools/` because that directory is already excluded from the
   package by `web-ext-config.cjs`; a new top-level file would have to be added
   to that list by hand or it would ship. Only the license goes in it, because
   that is the part which never changes. Release notes are per-version and belong
   in the Hub, where a stale value cannot be committed by accident.
5. `python3 tools/package-chrome.py` for the Web Store zip.

There is no GitHub release step any more, and no hash to record anywhere. Tagging
`v<version>` is still worth doing to mark what was submitted.

Run the tool through `npm run`, never `npx web-ext`. web-ext is pinned to an
exact version in `package.json` rather than a caret range, because it is the only
dependency whose behavior is not checked by anything: a bad jsdom shows up as a
failing test, whereas a bad web-ext shows up in a signed artifact after the fact.
`npx` outside the project would fetch whatever is current instead.

What goes into the signed package is fixed by `web-ext-config.cjs`, not by
command-line flags, so a new top-level file cannot drift into a release.

`update_url` must never come back. The add-on linter raises `MANIFEST_UPDATE_URL`
as an error rather than a warning, so a listed submission carrying it is rejected
outright instead of flagged. `npm run lint` catches it now that the `--self-hosted`
flag is gone, and `test/release.js` catches it without running the linter at all.
The Chrome packaging script strips `browser_specific_settings` entirely, so nothing
in that area reaches the Web Store either way.

`updates.json` is kept rather than deleted, and must not be extended. Installs made
before the move still read it on Firefox's own schedule; deleting it would turn
their update check into a 404, which is invisible to the person running them. They
stay on 1.0.2 until someone installs from AMO by hand, which is the accepted cost
of the move. Adding an entry would be worse than useless: it would offer a release
asset that no longer gets published.
