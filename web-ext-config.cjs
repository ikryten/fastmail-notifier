/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/* What goes into the Firefox package, stated once so a build is reproducible
   and a new top-level file cannot wander into a signed artifact unnoticed.
   The extension is the manifest, worker.js, core/ and data/, plus the license
   the MPL requires to travel with the source. Everything else here is
   development scaffolding. */
module.exports = {
  ignoreFiles: [
    'test', 'tools', 'docs', 'node_modules', 'web-ext-artifacts',
    'README.md', 'CLAUDE.md', 'updates.json',
    'package.json', 'package-lock.json', 'web-ext-config.cjs',
    '.amo-upload-uuid', '.gitignore'
  ]
};
