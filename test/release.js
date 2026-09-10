/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict';
/* Release wiring.

   This file used to check the self-distribution chain: manifest, updates.json,
   release asset and hash all agreeing, because nothing on a server kept them in
   step and a mistake broke updates silently. From 1.0.3 the Firefox build is
   listed on addons.mozilla.org and Mozilla delivers updates, so most of that
   chain is gone.

   What replaced it is a smaller rule with sharper teeth. `update_url` must not
   come back. The add-on linter raises MANIFEST_UPDATE_URL as an error rather
   than a warning, so a listed submission carrying it is rejected outright --
   and the obvious way for it to reappear is someone reading updates.json, still
   sitting in this repository, and concluding the key belongs with it. */

const fs = require('fs');
const path = require('path');
const {execFileSync} = require('child_process');

const ROOT = path.join(__dirname, '..');
const json = f => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra ? '\n       ' + extra : '')); }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
  'got ' + JSON.stringify(a) + '\n       want ' + JSON.stringify(b));

const manifest = json('manifest.json');
const pkg = json('package.json');
const gecko = manifest.browser_specific_settings.gecko;

console.log('\n1. the version is the same number everywhere');
eq('package.json matches manifest.json', pkg.version, manifest.version);

console.log('\n2. nothing submitted to AMO may carry update_url');
{
  /* An error, not a warning: AMO rejects the submission rather than flagging it,
     so this is the difference between a release and a bounced upload. */
  ok('the manifest does not declare one', !('update_url' in gecko),
     JSON.stringify(gecko));
  ok('and it appears nowhere else in the manifest',
     !JSON.stringify(manifest).includes('update_url'));
}

console.log('\n3. the add-on still identifies itself to Firefox');
{
  /* The id is what ties this build to the AMO listing and to every profile that
     already has it installed. Losing it would publish a different add-on under
     the same name and strand every existing install. */
  eq('the gecko id is unchanged', gecko.id, 'fastmail-notifier@ikryten.com');
  ok('and it names the Firefox it needs',
     Boolean(gecko.strict_min_version), JSON.stringify(gecko));
  /* AMO requires the declaration outright from Firefox 142, which is what
     strict_min_version is pinned to. */
  ok('and declares its data collection',
     Boolean(gecko.data_collection_permissions &&
             gecko.data_collection_permissions.required),
     JSON.stringify(gecko.data_collection_permissions));
}

console.log('\n4. updates.json is frozen, not maintained');
{
  /* Kept, not deleted: installs from before the move still read it on Firefox's
     schedule, and removing it would turn their update check into a 404. It
     describes the self-distributed past and must not grow, because nothing
     reads it that this repository can still serve. */
  const updates = json('updates.json');
  const entries = updates.addons[gecko.id].updates;
  const versions = entries.map(e => e.version);
  eq('it lists exactly the self-distributed versions',
     versions, ['1.0.0', '1.0.1', '1.0.2']);
  ok('and does not offer anything this build ships',
     !versions.includes(manifest.version),
     'an entry for ' + manifest.version + ' would point at a release that ' +
     'does not exist; AMO delivers this version');
}

console.log('\n5. the Chrome package is still Chrome-only');
{
  let chrome = null;
  try {
    chrome = JSON.parse(execFileSync('python3', ['-c',
      'import json,pathlib,importlib.util as u;' +
      's=u.spec_from_file_location("p","tools/package-chrome.py");' +
      'm=u.module_from_spec(s);s.loader.exec_module(m);' +
      'print(json.dumps(m.chrome_manifest()))'
    ], {cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
        // Running a test must not leave a tools/__pycache__ behind.
        env: Object.assign({}, process.env, {PYTHONDONTWRITEBYTECODE: '1'})}));
  }
  catch (e) {
    console.log('  \x1b[33mSKIP\x1b[0m python3 unavailable, cannot build the Chrome manifest');
  }
  if (chrome) {
    ok('no browser_specific_settings at all',
       !('browser_specific_settings' in chrome), JSON.stringify(Object.keys(chrome)));
    ok('and no Firefox event-page key to warn about',
       !('scripts' in chrome.background), JSON.stringify(chrome.background));
    eq('and it ships the same version', chrome.version, manifest.version);
  }
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail ? 1 : 0);
