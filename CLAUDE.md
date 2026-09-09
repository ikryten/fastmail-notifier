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
defense, labeled, gray.

## Structure

- **No build step and no runtime dependencies.** The unpacked directory is the
  extension. `node test/run.js` must work on a clean checkout with nothing
  installed; only the jsdom suite in `test/dom.js` needs `npm install`.
- **One codebase, both browsers.** `manifest.json` carries both a
  `background.service_worker` (Chrome) and `background.scripts` (Firefox); adding
  a file to one means adding it to the other and to `importScripts` in
  `worker.js`. `tools/package-chrome.py` produces the Chrome Web Store zip.
- **Nothing mutable in module scope.** An MV3 service worker is torn down
  constantly. State goes through `core/state.js`, which is the only module that
  touches `api.storage`.

## Releasing

The Firefox build is self-distributed, which means nothing on a server keeps the
pieces in step. Order matters, because the update manifest records a hash of the
signed file and Mozilla's signature is applied after the version is fixed:

1. Bump `version` in `manifest.json` and `package.json` (they must match).
2. `npx web-ext lint --self-hosted` — zero errors. One
   `BACKGROUND_SERVICE_WORKER_IGNORED` warning is expected and correct: the key
   is there for Chrome.
3. `npx web-ext sign --channel=unlisted`, with `WEB_EXT_API_KEY` and
   `WEB_EXT_API_SECRET` set from the AMO credentials. This uploads, waits for
   Mozilla to countersign, and downloads the result.
4. Rename the signed file to `fastmail_notifier-<version>.xpi` and attach it to a
   GitHub release tagged `v<version>`.
5. Add an entry to `updates.json` with that release's download URL and the
   `sha256:` digest of the signed file. Firefox verifies the download against it.
6. `npm test`. `test/release.js` checks the whole chain and fails if any link is
   missing — it exists because a forgotten step here breaks updates silently,
   with no error anywhere for anyone to see.
7. `python3 tools/package-chrome.py` for the Web Store zip.

`update_url` must never appear in anything submitted to AMO for listing: the
add-on linter raises `MANIFEST_UPDATE_URL` as an error, not a warning. It is safe
in the unlisted channel, which is how this add-on is distributed, and the Chrome
packaging script strips `browser_specific_settings` entirely.
