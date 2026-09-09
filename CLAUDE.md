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
