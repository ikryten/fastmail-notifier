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
    async set(o) { Object.assign(data, o); },
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

const CORE = ['core/api.js', 'core/state.js', 'core/urls.js', 'core/bodyparts.js'];

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
  const body = '<img src="https://tracker.example/pixel.gif" alt="pix">' +
               '<img srcset="https://tracker.example/2x.gif 2x" alt="set">' +
               '<div style="background:url(https://tracker.example/bg.png)">d</div>' +
               '<style>.a{background:url(https://tracker.example/css.png)}</style>';

  const on = await renderBody(htmlEmail([{partId: '1', type: 'text/html'}], {1: {value: body}}),
                              {loadRemoteImages: true});
  ok('images on: the remote src is kept', /tracker\.example\/pixel\.gif/.test(on));

  const off = await renderBody(htmlEmail([{partId: '1', type: 'text/html'}], {1: {value: body}}),
                               {loadRemoteImages: false});
  ok('images off: no remote URL survives anywhere',
     !/tracker\.example/.test(off), off.slice(0, 500));
  ok('images off: srcset is gone', !/srcset/i.test(off));
  ok('images off: the CSS url() is gone', !/url\(/i.test(off));
  ok('images off: alt text is shown instead of a broken image',
     /alt="pix"/.test(off), off.slice(0, 400));
  ok('images off: the reader is told why', /Remote content blocked/.test(off));
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
                 ['core/api.js', 'core/state.js', 'data/options/index.js'], stub);
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

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail ? 1 : 0);
})();
