/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict';
/* Release wiring.

   Firefox self-distribution has no server keeping anything in step: the browser
   reads `updates.json` out of this repository, believes whatever it says, and
   fails silently if it is wrong. Bumping the version in manifest.json and
   forgetting this file leaves every install frozen with nothing to notice --
   which is precisely the failure the update manifest exists to prevent, so it
   gets a test rather than a checklist item. */

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
const updates = json('updates.json');
const gecko = manifest.browser_specific_settings.gecko;
const REPO = 'ikryten/fastmail-notifier';

console.log('\n1. the version is the same number everywhere');
eq('package.json matches manifest.json', pkg.version, manifest.version);

console.log('\n2. the manifest points at this repository\'s update file');
{
  const want = 'https://raw.githubusercontent.com/' + REPO + '/master/updates.json';
  eq('update_url', gecko.update_url, want);
  // Firefox refuses a plain-http update URL outright, so this is not style.
  ok('served over https', /^https:/.test(gecko.update_url || ''));
}

console.log('\n3. updates.json describes this add-on');
{
  const ids = Object.keys(updates.addons || {});
  eq('exactly one add-on, keyed by the gecko id', ids, [gecko.id]);
}

const entries = updates.addons[gecko.id].updates;

console.log('\n4. every published version is well formed');
for (const e of entries) {
  const tag = 'v' + e.version;
  const file = 'fastmail_notifier-' + e.version + '.xpi';
  const want = 'https://github.com/' + REPO + '/releases/download/' + tag + '/' + file;
  eq(e.version + ': update_link is the release asset for its own version', e.update_link, want);
  /* An update_link is only as trustworthy as the host serving it. The hash makes
     the browser verify the bytes it downloaded against something committed here,
     signed history, rather than trusting the download alone. */
  ok(e.version + ': update_hash is a sha256 digest',
     /^sha256:[0-9a-f]{64}$/.test(e.update_hash || ''), String(e.update_hash));
  ok(e.version + ': names the Firefox it needs',
     Boolean(e.applications && e.applications.gecko &&
             e.applications.gecko.strict_min_version), JSON.stringify(e.applications));
}

console.log('\n5. the version being shipped is actually offered');
{
  const here = entries.find(e => e.version === manifest.version);
  ok('updates.json has an entry for ' + manifest.version, Boolean(here),
     'versions listed: ' + entries.map(e => e.version).join(', '));
  if (here) {
    /* Mismatched floors are the quiet kind of broken: Firefox trusts the update
       manifest when deciding whether an update applies, so a lower number here
       offers the build to a browser too old to run it. */
    eq('and its minimum Firefox matches the manifest',
       here.applications.gecko.strict_min_version, gecko.strict_min_version);
  }
}

console.log('\n6. the Chrome package cannot carry update_url');
{
  /* AMO rejects a listed submission containing update_url outright -- the
     add-on linter raises MANIFEST_UPDATE_URL as an error, not a warning -- and
     the Chrome Web Store has no use for any of this. The packaging script drops
     browser_specific_settings wholesale; this proves it still does. */
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
    ok('so no update_url reaches the Web Store',
       !JSON.stringify(chrome).includes('update_url'));
    eq('and it ships the same version', chrome.version, manifest.version);
  }
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail ? 1 : 0);
