'use strict';
/* DOM-level tests for the popup renderer and the options page.

   The core suite deliberately runs without dependencies; this one needs a real
   DOM (DOMParser, event dispatch), so it uses jsdom and lives in its own file.
   `node test/run.js` still works on a clean checkout with nothing installed. */

const fs = require('fs');
const path = require('path');
const {JSDOM} = require('jsdom');

const ROOT = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');

/* A page whose own listener rejects must not abort the run: Node exits on an
   unhandled rejection by default, which would take the remaining assertions with
   it and hide the very failure being tested. */
process.on('unhandledRejection', e => {
  console.log('  \x1b[33m(unhandled rejection from page: ' +
              ((e && e.message) || e) + ')\x1b[0m');
});

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra ? '\n       ' + extra : '')); }
}
const eq = (name, a, b) => ok(name, JSON.stringify(a) === JSON.stringify(b),
  'got ' + JSON.stringify(a) + '\n       want ' + JSON.stringify(b));

function storageArea() {
  const data = {};
  return {
    _data: data,
    async get(keys) {
      if (keys == null) return {...data};
      const out = {};
      for (const k of (Array.isArray(keys) ? keys : [keys])) if (k in data) out[k] = data[k];
      return out;
    },
    async set(o) { this._writes++; Object.assign(data, o); },
    _writes: 0,
    async remove(keys) { for (const k of (Array.isArray(keys) ? keys : [keys])) delete data[k]; }
  };
}

/* Builds a window with the extension's own scripts evaluated in order. The HTML
   references /core/*.js by absolute path, which jsdom cannot resolve, so the
   scripts are evaluated explicitly instead. */
function page(htmlFile, scripts, chromeStub) {
  /* Injected as real <script> elements rather than window.eval: these sources
     start with 'use strict', and a strict eval keeps its declarations to itself,
     so nothing would reach the window. Script elements do create the global
     bindings the tests need. The page's own <script src="/core/..."> tags are
     inert here, since jsdom fetches no external resources by default. */
  const dom = new JSDOM(read(htmlFile), {url: 'https://localhost/', runScripts: 'dangerously'});
  const w = dom.window;
  w.chrome = chromeStub;
  w.fetch = async () => { throw new Error('network disabled in DOM tests'); };
  for (const f of scripts) {
    const el = w.document.createElement('script');
    el.textContent = read(f);
    w.document.head.appendChild(el);
  }
  return w;
}

function chromeStub(overrides) {
  return Object.assign({
    storage: {local: storageArea(), session: storageArea(), onChanged: {addListener() {}}},
    runtime: {
      getURL: p => 'chrome-extension://test' + p,
      getManifest: () => JSON.parse(read('manifest.json')),
      sendMessage: async () => ({ok: true}),
      openOptionsPage() {},
      onMessage: {addListener() {}}
    },
    action: {async setIcon() {}, async setBadgeText() {}, async setTitle() {},
             async setBadgeBackgroundColor() {}, async setPopup() {}}
  }, overrides || {});
}

const CORE = ['core/api.js', 'core/state.js', 'core/folders.js',
              'core/urls.js', 'core/bodyparts.js'];

/* ---------------- popup body rendering ---------------- */

async function renderBody(email, prefs) {
  const stub = chromeStub();
  await stub.storage.local.set(prefs || {});
  stub.runtime.sendMessage = async req =>
    req.method === 'body' ? {ok: true, email} : {ok: true};
  const w = page('data/popup/index.html', CORE.concat(['data/popup/index.js']), stub);
  return w.buildBody('E1');
}

const htmlEmail = (parts, values, extra) => Object.assign({
  htmlBody: parts, bodyValues: values, attachments: []
}, extra || {});

(async () => {

console.log('\n1. popup: every body part is rendered, in order');
{
  const doc = await renderBody(htmlEmail(
    [{partId: '1', type: 'text/html'}, {partId: '2', type: 'text/html'}],
    {1: {value: '<p>first part</p>'}, 2: {value: '<p>second part</p>'}}));
  ok('both parts present', /first part/.test(doc) && /second part/.test(doc), doc.slice(0, 300));
  ok('and in declared order', doc.indexOf('first part') < doc.indexOf('second part'));
}

console.log('\n2. popup: a part cannot leak markup into the next one');
{
  // An unclosed tag in part one must not swallow part two: each part is parsed
  // and sanitised on its own before the results are joined.
  const doc = await renderBody(htmlEmail(
    [{partId: '1', type: 'text/html'}, {partId: '2', type: 'text/html'}],
    {1: {value: '<div><span>unterminated'}, 2: {value: '<p>still here</p>'}}));
  ok('the later part survives', /still here/.test(doc), doc.slice(0, 300));
}

console.log('\n3. popup: text parts are escaped, not interpreted');
{
  const doc = await renderBody({
    textBody: [{partId: 't', type: 'text/plain'}],
    bodyValues: {t: {value: '<script>alert(1)</script> & <b>x</b>'}},
    attachments: []
  });
  ok('no live script tag', !/<script>alert/.test(doc), doc.slice(0, 300));
  ok('shown as text', /&lt;script&gt;/.test(doc));
}

console.log('\n4. popup: active content is stripped from HTML parts');
{
  const doc = await renderBody(htmlEmail([{partId: '1', type: 'text/html'}],
    {1: {value: '<p onclick="steal()">hi</p><script>bad()</script>' +
                '<a href="javascript:bad()">x</a><iframe src="https://e.com"></iframe>'}}));
  ok('no script element', !/<script/i.test(doc));
  ok('no inline handler', !/onclick/i.test(doc));
  ok('no javascript: href', !/javascript:/i.test(doc));
  ok('no nested iframe', !/<iframe/i.test(doc));
  ok('the text itself survives', /hi/.test(doc));
}

console.log('\n5. popup: remote content honours the preference');
{
  /* Every construct the audit found still calling home with images off. The
     sanitiser used to run only img[src] through an allowlist and leave the rest
     to a denylist that rejected javascript: but kept https:, so all of the
     media, SVG and image-set() cases below fired a request -- and none of them
     incremented the blocked counter, so the reader was told nothing was
     withheld. */
  const body =
    '<img src="https://tracker.example/pixel.gif" alt="pix">' +
    '<img srcset="https://tracker.example/2x.gif 2x" alt="set">' +
    '<img SRC="//tracker.example/protocol-relative.gif" alt="rel">' +
    '<video poster="https://tracker.example/poster.jpg" src="https://tracker.example/v.mp4"></video>' +
    '<audio src="https://tracker.example/a.mp3"></audio>' +
    '<video><source src="https://tracker.example/s.mp4"><track src="https://tracker.example/t.vtt" default></video>' +
    '<svg><image href="https://tracker.example/svg1.png"/>' +
    '<image xlink:href="https://tracker.example/svg2.png"/></svg>' +
    '<div style="background:url(https://tracker.example/bg.png)">d</div>' +
    '<div style="background-image:image-set(\'https://tracker.example/set.png\' 1x)">i</div>' +
    '<div STYLE="background:\\75 rl(https://tracker.example/esc.png)">e</div>' +
    '<div background="https://tracker.example/attr.png">b</div>' +
    '<style>.a{background:url(https://tracker.example/css.png)}</style>' +
    '<style>@import "https://tracker.example/import.css";</style>' +
    '<a href="https://example.com/real-link">a link</a>';

  const on = await renderBody(htmlEmail([{partId: '1', type: 'text/html'}], {1: {value: body}}),
                              {loadRemoteImages: true});
  ok('images on: the remote src is kept', /tracker\.example\/pixel\.gif/.test(on));

  const off = await renderBody(htmlEmail([{partId: '1', type: 'text/html'}], {1: {value: body}}),
                               {loadRemoteImages: false});

  ok('images off: no remote URL survives anywhere',
     !/tracker\.example/.test(off), off.slice(0, 900));
  ok('images off: srcset is gone', !/srcset/i.test(off));
  ok('images off: no CSS url() remains', !/url\(/i.test(off));
  ok('images off: no image-set() remains', !/image-set/i.test(off));
  ok('images off: media elements are removed outright',
     !/<video|<audio|<source|<track/i.test(off), off.slice(0, 900));
  ok('images off: the img elements are removed, not left empty',
     !/<img/i.test(off), off.slice(0, 400));
  ok('images off: xlink:href is gone too, not merely unchecked',
     !/xlink:href/i.test(off), off.slice(0, 900));

  /* The silent half of the failure: several of these were stripped without ever
     being counted, so the notice did not appear and the reader believed the
     message had rendered whole. */
  const n = Number((/Remote content blocked \((\d+)\)/.exec(off) || [])[1] || 0);
  ok('images off: everything withheld is counted', n >= 10, 'counted ' + n);

  // A link is navigation, not a fetch -- it costs nothing until it is clicked.
  ok('images off: ordinary links still work',
     /example\.com\/real-link/.test(off), off.slice(0, 900));
}
{
  // A scheme that executes must not survive however it is spelled.
  const body = '<a href="javascript:alert(1)">x</a>' +
               '<a href="JaVaScRiPt:alert(1)">y</a>' +
               '<a href="  vbscript:x">z</a>' +
               '<svg><a xlink:href="javascript:alert(1)">s</a></svg>';
  const out = await renderBody(htmlEmail([{partId: '1', type: 'text/html'}], {1: {value: body}}),
                               {loadRemoteImages: true});
  ok('executable schemes are stripped from links whatever the casing',
     !/javascript:|vbscript:/i.test(out), out.slice(0, 500));
}

console.log('\n5b. popup: the document carries its own CSP');
{
  const body = '<p>hello</p>';
  const off = await renderBody(htmlEmail([{partId: '1', type: 'text/html'}], {1: {value: body}}),
                               {loadRemoteImages: false});
  ok('blocking: nothing loads by default', /default-src 'none'/.test(off), off.slice(0, 400));
  ok('blocking: images only from data:, so no host is reachable',
     /img-src data:;/.test(off), off.slice(0, 400));
  ok('blocking: no https anywhere in the policy',
     !/(img|media|font)-src[^;]*https:/.test(off), off.slice(0, 400));

  const on = await renderBody(htmlEmail([{partId: '1', type: 'text/html'}], {1: {value: body}}),
                              {loadRemoteImages: true});
  ok('allowing: remote images are permitted', /img-src https: data:/.test(on), on.slice(0, 400));
  ok('allowing: but scripts and frames still are not',
     /default-src 'none'/.test(on), on.slice(0, 400));
  ok('inline CSS stays allowed, or nothing is styled at all',
     /style-src 'unsafe-inline'/.test(on));
}

console.log('\n5c. popup: a truncated body says so');
{
  const out = await renderBody(htmlEmail(
    [{partId: '1', type: 'text/html'}],
    {1: {value: '<p>the first half of a very large message</p>', isTruncated: true}}));
  ok('the content that did arrive is still shown',
     /the first half of a very large message/.test(out), out.slice(0, 400));
  ok('and the reader is told the rest is missing',
     /too large to show in full/.test(out), out.slice(0, 600));
}
{
  const out = await renderBody(htmlEmail(
    [{partId: '1', type: 'text/html'}], {1: {value: '<p>complete</p>'}}));
  ok('a complete body carries no notice', !/too large/.test(out));
}

console.log('\n6. popup: nothing displayable says so');
{
  const doc = await renderBody({htmlBody: [], textBody: [], bodyValues: {}, attachments: []});
  ok('shows the empty-body notice', /\(no readable body\)/.test(doc), doc.slice(0, 200));
}

/* ---------------- options page ---------------- */

async function optionsPage(sendMessage) {
  const stub = chromeStub();
  stub.runtime.sendMessage = sendMessage;
  const w = page('data/options/index.html',
                 ['core/api.js', 'core/state.js', 'core/folders.js', 'data/options/index.js'], stub);
  await new Promise(r => setTimeout(r, 0));   // let load() settle
  return w;
}

const click = async (w, id) => {
  w.document.getElementById(id).dispatchEvent(new w.MouseEvent('click'));
  await new Promise(r => setTimeout(r, 5));
};

console.log('\n7. options: the Save button always comes back');
{
  const w = await optionsPage(async () => ({ok: true, username: 'me@fastmail.com'}));
  w.document.getElementById('token').value = 'tok-123';
  await click(w, 'save');
  ok('success: button re-enabled', w.document.getElementById('save').disabled === false);
  ok('success: the token was stored',
     (await w.chrome.storage.local.get('token')).token === 'tok-123');
}
{
  const w = await optionsPage(async () => ({ok: false, error: 'Fastmail rejected the API token (401)'}));
  w.document.getElementById('token').value = 'bad';
  await click(w, 'save');
  ok('rejection reply: button re-enabled', w.document.getElementById('save').disabled === false);
  ok('rejection reply: the reason is shown',
     /401/.test(w.document.getElementById('conn-status').textContent));
  ok('rejection reply: nothing was stored',
     (await w.chrome.storage.local.get('token')).token === undefined);
}
{
  // The case that used to strand the button for good.
  const w = await optionsPage(async () => { throw new Error('Receiving end does not exist'); });
  w.document.getElementById('token').value = 'tok-123';
  await click(w, 'save');
  ok('thrown sendMessage: button re-enabled',
     w.document.getElementById('save').disabled === false);
  ok('thrown sendMessage: the failure is explained',
     /Receiving end does not exist/.test(w.document.getElementById('conn-status').textContent),
     w.document.getElementById('conn-status').textContent);
  ok('thrown sendMessage: nothing was stored',
     (await w.chrome.storage.local.get('token')).token === undefined);
}

console.log('\n8. options: the folder picker');

/* What the worker's `folders` handler returns: every mailbox, each with its full
   path, plus the inbox id. */
const FOLDERS = [
  {id: 'MB-inbox', name: 'Inbox', path: 'Inbox', role: 'inbox'},
  {id: 'MB-receipts', name: 'Receipts', path: 'Receipts', role: null},
  {id: 'MB-important', name: 'Important', path: 'Important', role: null},
  {id: 'MB-family', name: 'Family', path: 'Receipts/Family', role: null}
];

async function foldersPage(seed, reply) {
  const stub = chromeStub();
  Object.assign(stub.storage.local._data, seed || {});
  stub.runtime.sendMessage = async req =>
    req.method === 'folders' ? reply() : {ok: true, username: 'me@fastmail.com'};
  const w = page('data/options/index.html',
                 ['core/api.js', 'core/state.js', 'core/folders.js', 'data/options/index.js'], stub);
  await new Promise(r => setTimeout(r, 10));
  return w;
}

const boxes = w => Array.from(w.document.querySelectorAll('#folder-list input[type=checkbox]'));
const rowText = w => Array.from(w.document.querySelectorAll('#folder-list label'))
  .map(el => el.querySelector('span').textContent);

async function change(w, el) {
  el.dispatchEvent(new w.Event('change'));
  await new Promise(r => setTimeout(r, 5));
}

{
  const w = await foldersPage({watchFolders: ['Receipts/Family']},
                              () => ({ok: true, folders: FOLDERS, inbox: 'MB-inbox'}));

  ok('the picker is shown', w.document.getElementById('folder-list').hidden === false);
  ok('and the text fallback is not', w.document.getElementById('folder-fallback').hidden === true);
  eq('the inbox leads, then folders by path',
     rowText(w), ['Inbox', 'Important', 'Receipts', 'Receipts/Family']);

  const inbox = boxes(w)[0];
  /* It used to be disabled and labelled "always counted". It is now an ordinary
     tick, because unticking it is the whole point of watching a VIP folder only. */
  ok('the inbox row is ticked but no longer disabled', inbox.checked && !inbox.disabled);
  ok('and is marked as the inbox rather than carrying a path', Boolean(inbox.dataset.inbox));

  const ticked = boxes(w).filter(b => b.checked && !b.dataset.inbox).map(b => b.dataset.path);
  eq('the saved folder is ticked', ticked, ['Receipts/Family']);

  // Ticking another must save both, and must never save the inbox.
  const important = boxes(w).find(b => b.dataset.path === 'Important');
  important.checked = true;
  await change(w, important);
  eq('ticking a folder saves it alongside the existing one',
     (await w.chrome.storage.local.get('watchFolders')).watchFolders,
     ['Important', 'Receipts/Family']);

  const family = boxes(w).find(b => b.dataset.path === 'Receipts/Family');
  family.checked = false;
  await change(w, family);
  eq('unticking removes it',
     (await w.chrome.storage.local.get('watchFolders')).watchFolders, ['Important']);
}

{
  /* A folder renamed or deleted in Fastmail. Dropping it silently would lose a
     setting the user made with no way to tell that it had gone. */
  const w = await foldersPage({watchFolders: ['Gone', 'Important']},
                              () => ({ok: true, folders: FOLDERS, inbox: 'MB-inbox'}));

  ok('an unmatched name is still listed', rowText(w).includes('Gone'), rowText(w).join(', '));
  const gone = boxes(w).find(b => b.dataset.path === 'Gone');
  ok('ticked, so it can be removed deliberately', gone && gone.checked);
  ok('and flagged as not found',
     /not found/.test(w.document.getElementById('folder-list').textContent));
  ok('with the status saying so',
     /no longer matches/.test(w.document.getElementById('folder-status').textContent),
     w.document.getElementById('folder-status').textContent);

  gone.checked = false;
  await change(w, gone);
  eq('unticking it leaves the rest alone',
     (await w.chrome.storage.local.get('watchFolders')).watchFolders, ['Important']);
}

{
  // No token yet, or Fastmail unreachable: fall back to typing names.
  const w = await foldersPage({watchFolders: ['Important', 'Receipts/Family']},
                              () => { throw new Error('No API token set'); });

  /* The picker stays visible holding just the Inbox row: watchInbox is not
     expressible in the text field, so hiding it outright would leave a user with a
     dead token unable to turn the inbox back on. */
  ok('the inbox tick survives', boxes(w).length === 1 && Boolean(boxes(w)[0].dataset.inbox));
  ok('and the text field is shown for the rest',
     w.document.getElementById('folder-fallback').hidden === false);
  eq('prefilled with what is saved',
     w.document.getElementById('watchFolders').value, 'Important, Receipts/Family');
  ok('and the reason is explained',
     /No API token set/.test(w.document.getElementById('folder-status').textContent),
     w.document.getElementById('folder-status').textContent);

  const input = w.document.getElementById('watchFolders');
  input.value = ' Archive , Receipts/Family ,, ';
  await change(w, input);
  eq('typed names are trimmed and blanks dropped',
     (await w.chrome.storage.local.get('watchFolders')).watchFolders,
     ['Archive', 'Receipts/Family']);
}

console.log('\n9. options: the inbox tick and the empty-set warning');
{
  const w = await foldersPage({watchFolders: ['Important']},
                              () => ({ok: true, folders: FOLDERS, inbox: 'MB-inbox'}));
  const inbox = boxes(w)[0];

  // One write, not two: one storage change means one re-poll.
  const before = w.chrome.storage.local._writes;
  inbox.checked = false;
  await change(w, inbox);
  eq('unticking the inbox persists watchInbox',
     (await w.chrome.storage.local.get('watchInbox')).watchInbox, false);
  eq('and leaves the folder list alone',
     (await w.chrome.storage.local.get('watchFolders')).watchFolders, ['Important']);
  eq('written in a single storage set', w.chrome.storage.local._writes - before, 1);

  inbox.checked = true;
  await change(w, inbox);
  eq('re-ticking it persists too',
     (await w.chrome.storage.local.get('watchInbox')).watchInbox, true);
}
{
  const w = await foldersPage({watchInbox: false, watchFolders: []},
                              () => ({ok: true, folders: FOLDERS, inbox: 'MB-inbox'}));
  ok('watching nothing is warned about',
     /nothing is being watched/i.test(w.document.getElementById('folder-status').textContent),
     w.document.getElementById('folder-status').textContent);
  ok('and flagged', /\bbad\b/.test(w.document.getElementById('folder-status').className));

  // Ticking something must clear it without a reload.
  const important = boxes(w).find(b => b.dataset.path === 'Important');
  important.checked = true;
  await change(w, important);
  ok('and the warning clears as soon as something is ticked',
     !/nothing is being watched/i.test(w.document.getElementById('folder-status').textContent),
     w.document.getElementById('folder-status').textContent);
}
{
  // Both facts matter to a user whose only saved folder has been deleted.
  const w = await foldersPage({watchInbox: false, watchFolders: ['Gone']},
                              () => ({ok: true, folders: FOLDERS, inbox: 'MB-inbox'}));
  const txt = w.document.getElementById('folder-status').textContent;
  ok('an unmatched name is still reported', /no longer matches/.test(txt), txt);
  ok('alongside the nothing-watched warning', /nothing is being watched/i.test(txt), txt);
}

{
  /* Fallback mode: the picker holds only the Inbox row and the folders live in
     the text field, so rebuilding watchFolders from checkboxes wrote an empty
     array -- silently deleting the saved list while the field still showed it. */
  const w = await foldersPage({watchFolders: ['Important', 'Receipts/Family']},
                              () => { throw new Error('No API token set'); });
  const inbox = boxes(w)[0];
  ok('the fallback still offers the inbox tick', Boolean(inbox && inbox.dataset.inbox));

  inbox.checked = false;
  await change(w, inbox);
  eq('unticking it persists watchInbox',
     (await w.chrome.storage.local.get('watchInbox')).watchInbox, false);
  eq('without erasing the typed folders',
     (await w.chrome.storage.local.get('watchFolders')).watchFolders,
     ['Important', 'Receipts/Family']);
}

console.log('\n10. popup: the folder chip');

const MBOX = {
  gen: 3, inbox: 'MB-inbox',
  all: [{id: 'MB-inbox', name: 'Inbox', path: 'Inbox', role: 'inbox'},
        {id: 'MB-family', name: 'Family', path: 'Receipts/Family', role: null}]
};
const msg = (id, boxIds) => ({
  id, threadId: 'T' + id, mailboxIds: Object.fromEntries(boxIds.map(b => [b, true])),
  fromName: 'Sender', fromEmail: 's@x.com', subject: 'Subject ' + id,
  receivedAt: new Date().toISOString(), preview: 'preview', hasAttachment: false
});

async function popupPage(messages, mailboxes, gen) {
  const stub = chromeStub();
  Object.assign(stub.storage.session._data, {messages, mailboxes, session: {username: 'me@x.com'}});
  Object.assign(stub.storage.local._data, {'token-gen': typeof gen === 'number' ? gen : 3});
  stub.runtime.sendMessage = async () => ({ok: true, email: {htmlBody: [], bodyValues: {}}});
  const w = page('data/popup/index.html', CORE.concat(['data/popup/index.js']), stub);
  await new Promise(r => setTimeout(r, 10));
  return w;
}

{
  const w = await popupPage([msg('E1', ['MB-family'])], MBOX);
  const chip = w.document.getElementById('folder');
  ok('a watched folder is named', chip.hidden === false);
  eq('with its full path', chip.textContent, 'Receipts/Family');
}
{
  // In two mailboxes at once: the inbox wins, so inbox mail reads as inbox mail.
  const w = await popupPage([msg('E1', ['MB-family', 'MB-inbox'])], MBOX);
  eq('a message in two mailboxes prefers the inbox',
     w.document.getElementById('folder').textContent, 'Inbox');
}
{
  const w = await popupPage([msg('E1', ['MB-unknown'])], MBOX);
  const chip = w.document.getElementById('folder');
  ok('an unrecognised mailbox shows no chip', chip.hidden === true);
  ok('and never leaks a raw JMAP id into the page',
     !/MB-unknown/.test(w.document.body.textContent));
}
{
  const w = await popupPage([msg('E1', ['MB-family'])], null);
  ok('no mailbox list means no chip, not a broken render',
     w.document.getElementById('folder').hidden === true);
  eq('and the message still renders',
     w.document.getElementById('subject').textContent, 'Subject E1');
}
{
  /* Changing the token clears the cached mailbox list but leaves the old messages
     until the next poll, so a generation mismatch must suppress the chip rather
     than label mail with the previous account's folder names. */
  const w = await popupPage([msg('E1', ['MB-family'])], MBOX, 4);
  ok('a stale mailbox list is not used', w.document.getElementById('folder').hidden === true);
}
{
  const w = await popupPage([], MBOX);
  ok('an empty list hides the chip', w.document.getElementById('folder').hidden === true);
  ok('and no longer says "Inbox zero", which assumes the inbox is watched',
     !/Inbox zero/.test(w.document.getElementById('overlay').textContent),
     w.document.getElementById('overlay').textContent);
}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail ? 1 : 0);
})();
