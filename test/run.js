'use strict';
const {load, email, INBOX, TRASH, setMode} = require('./harness');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra ? '\n       ' + extra : '')); }
}
const settle = async ctx => {
  for (let i = 0; i < 200 && ctx.check.running; i++) {
    await new Promise(r => setTimeout(r, 1));
  }
};
/* What the poll's Email/query filter should look like: unread means neither
   $seen nor $draft, matching how Mailbox.unreadEmails is defined. */
const unreadFilter = (...ids) => ({
  operator: 'AND',
  conditions: [
    ids.length === 1
      ? {inMailbox: ids[0]}
      : {operator: 'OR', conditions: ids.map(id => ({inMailbox: id}))},
    {notKeyword: '$seen'},
    {notKeyword: '$draft'}
  ]
});

function eq(name, a, b, extra) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + '\n       want ' + JSON.stringify(b) + (extra ? '\n       ' + extra : '')); }

(async () => {
for (const mode of ['chrome', 'firefox']) {
setMode(mode);
console.log('\n\x1b[1m========== simulating ' + mode.toUpperCase() + ' ==========\x1b[0m');

console.log('\n1. no token -> logged-out state, no network');
{
  const server = {token: 'good', unread: [], requests: [], sets: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.check.execute('test');
  eq('count is the unauthenticated sentinel', ctx.__api.storage.session._data.count, -1);
  ok('never hit the network', server.requests.length === 0);
  ok('amber "!" badge', calls.some(c => c[0] === 'badge' && c[1] === '!'));
}

console.log('\n2. bad token -> auth failure surfaces, session cache cleared');
{
  const server = {token: 'good', unread: [], requests: [], sets: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'WRONG'});
  await ctx.check.execute('test');
  eq('count is the unauthenticated sentinel', ctx.__api.storage.session._data.count, -1);
  ok('no stale session left behind', !ctx.__api.storage.session._data.session);
  ok('tooltip names the failure',
     calls.some(c => c[0] === 'title' && /rejected the API token \(401\)/.test(c[1])));
}

console.log('\n3. happy path: badge, ordering, backlog suppression');
{
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('E1', 'a@x.com', 'newest', 1), email('E2', 'b@x.com', 'middle', 30), email('E3', 'c@x.com', 'oldest', 400)]
  };
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('test');

  eq('badge shows the mailbox unread count', ctx.__api.storage.session._data.count, 3);
  eq('query order is re-imposed over Email/get',
     ctx.__api.storage.session._data.messages.map(m => m.id), ['E1', 'E2', 'E3']);
  eq('the default watch set is the inbox alone, unread and not a draft',
     server.lastFilter, unreadFilter(INBOX));
  eq('sender is flattened for the popup',
     ctx.__api.storage.session._data.messages[0].fromEmail, 'a@x.com');

  const notifies = calls.filter(c => c[0] === 'notify');
  ok('cold start does not notify about the 400-min-old backlog',
     notifies.length === 1 && /newest/.test(notifies[0][3]),
     'notifications: ' + JSON.stringify(notifies));

  const posts = server.requests.filter(r => r.opts.method === 'POST');
  eq('poll is a single round trip after bootstrap', posts.length, 2); // mailboxes + poll
}

console.log('\n4. second poll: no re-notify, new mail does notify');
{
  const server = {token: 'good', requests: [], sets: [], unread: [email('E1', 'a@x.com', 'first', 1)]};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('one');
  const after1 = calls.filter(c => c[0] === 'notify').length;

  server.unread = [email('E9', 'z@x.com', 'brand new', 0), email('E1', 'a@x.com', 'first', 1)];
  await ctx.check.execute('two');
  const notifies = calls.filter(c => c[0] === 'notify');

  eq('first poll notified once', after1, 1);
  eq('second poll notified once more', notifies.length, 2);
  ok('and it was about the new message', /brand new/.test(notifies[1][3]));
  eq('cached session means only one /jmap/session GET',
     server.requests.filter(r => !r.opts.method || r.opts.method === 'GET').length, 1);
}

console.log('\n5. VIP filter');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good', notifyVipOnly: true, vips: ['@work.com'], 'seen-ids': ['seed']});
  server.unread = [email('E1', 'noise@spam.com', 'ignore me', 0)];
  await ctx.check.execute('a');
  eq('non-VIP does not notify', calls.filter(c => c[0] === 'notify').length, 0);

  server.unread = [email('E2', 'boss@work.com', 'important', 0), email('E1', 'noise@spam.com', 'ignore me', 0)];
  await ctx.check.execute('b');
  const n = calls.filter(c => c[0] === 'notify');
  eq('VIP does notify', n.length, 1);
  ok('and it is the VIP message', /important/.test(n[0][3]));
}

console.log('\n6. silencing');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good', 'seen-ids': ['seed']});
  await ctx.state.setSilentUntil(Date.now() + 60000);
  server.unread = [email('E1', 'a@x.com', 'quiet please', 0)];
  await ctx.check.execute('test');
  eq('silenced: no notification', calls.filter(c => c[0] === 'notify').length, 0);
  eq('but the badge still updates', ctx.__api.storage.session._data.count, 1);
}

console.log('\n7. writes: mark read and trash send correct JMAP patches');
{
  const server = {token: 'good', requests: [], sets: [], unread: [email('E1', 'a@x.com', 's', 1)]};
  const ctx = load(server, []);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('seed');

  const session = await ctx.state.session();
  const boxes = await ctx.state.mailboxes();
  eq('mailboxes resolved by role, not name', [boxes.inbox, boxes.trash], [INBOX, TRASH]);

  await ctx.jmap.markRead('good', session, ['E1']);
  eq('mark read patches keywords/$seen', server.sets[0], {E1: {'keywords/$seen': true}});

  await ctx.jmap.trash('good', session, boxes, ['E1']);
  eq('trash replaces mailboxIds (recoverable, not destroyed)',
     server.sets[1], {E1: {mailboxIds: {[TRASH]: true}}});
}

console.log('\n8. transient network failure keeps the last good count');
{
  const server = {token: 'good', requests: [], sets: [], unread: [email('E1', 'a@x.com', 's', 1)]};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('seed');
  eq('seeded', ctx.__api.storage.session._data.count, 1);

  ctx.fetch = async () => { throw new Error('offline'); };
  calls.length = 0;
  await ctx.check.execute('offline');
  eq('count is not flapped to zero', ctx.__api.storage.session._data.count, 1);
  ok('tooltip explains', calls.some(c => c[0] === 'title' && /Last check failed/.test(c[1])));
  ok('icon is not switched to logged-out', !calls.some(c => c[0] === 'badge' && c[1] === '!'));
}

console.log('\n9. badge formatting');
{
  const ctx = load({token: 'good', unread: [], requests: [], sets: []}, []);
  eq('small counts verbatim', ctx.button.format(17), '17');
  eq('large counts compacted', ctx.button.format(33855), '34K');
}

console.log('\n10. deep links into the Fastmail web app');
{
  const ctx = load({token: 'good', unread: [], requests: [], sets: []}, []);
  const session = {accountId: 'u1a2b3c4d'};
  const BASE = 'https://app.fastmail.com/mail/Inbox/';

  eq('no id -> plain inbox (what the Inbox button sends)',
     ctx.jmap.webUrl(session, null), BASE);
  eq('id -> deep link, ?u= key derived from the accountId',
     ctx.jmap.webUrl(session, 'Stmo9PwS3weB'), BASE + 'Stmo9PwS3weB?u=1a2b3c4d');
  eq('unexpected accountId shape -> omit ?u= rather than emit a wrong one',
     ctx.jmap.webUrl({accountId: 'A13824'}, 'Stmo9PwS3weB'), BASE + 'Stmo9PwS3weB');
  eq('a missing session is tolerated',
     ctx.jmap.webUrl(null, 'Stmo9PwS3weB'), BASE + 'Stmo9PwS3weB');
  eq('ids are percent-encoded',
     ctx.jmap.webUrl(session, 'a/b c'), BASE + 'a%2Fb%20c?u=1a2b3c4d');
}

console.log('\n11. image src normalisation');
{
  const ctx = load({token: 'good', unread: [], requests: [], sets: []}, []);
  const f = ctx.urls.safeSrc;

  eq('absolute https passes through', f('https://claude.ai/a.png'), 'https://claude.ai/a.png');
  eq('absolute http passes through', f('http://x.com/a.png'), 'http://x.com/a.png');
  eq('protocol-relative gets https, not the extension origin',
     f('//cdn.example.com/logo.png'), 'https://cdn.example.com/logo.png');
  eq('cid: passes through for the inline resolver', f('cid:abc@x'), 'cid:abc@x');
  eq('inline data image passes through',
     f('data:image/png;base64,iVBOR'), 'data:image/png;base64,iVBOR');
  eq('relative path is dropped (unresolvable in a srcdoc frame)', f('images/logo.png'), null);
  eq('root-relative path is dropped', f('/logo.png'), null);
  eq('javascript: is dropped', f('javascript:alert(1)'), null);
  eq('data:text/html is dropped', f('data:text/html,<script>'), null);
  eq('whitespace-obfuscated javascript: is dropped', f('  javascript:alert(1)'), null);
  eq('empty is dropped', f(''), null);
  eq('null is dropped', f(null), null);
}

console.log('\n12. extension API namespace resolution');
{
  const ctx = load({token: 'good', unread: [], requests: [], sets: []}, []);
  ok('api resolves to the namespace this browser exposes', ctx.api === ctx.__api);
  if (mode === 'firefox') {
    ok('only `browser` exists, as in Gecko',
       typeof ctx.browser === 'object' && typeof ctx.chrome === 'undefined');
    // The whole point: Firefox's chrome.* alias is callback-based, so awaiting
    // it yields undefined. Resolving to `browser` is what keeps promises working.
    ok('api is `browser`, not the callback-based chrome alias', ctx.api === ctx.browser);
  }
  else {
    ok('only `chrome` exists, as in older Chrome',
       typeof ctx.chrome === 'object' && typeof ctx.browser === 'undefined');
    ok('api is `chrome`', ctx.api === ctx.chrome);
  }
}

console.log('\n13. review #1: a failing toolbar call must not stop polling');
{
  const server = {token: 'good', requests: [], sets: [], unread: [email('E1', 'a@x.com', 's', 1)]};
  const calls = [];
  const ctx = load(server, calls, {worker: true});
  await ctx.__api.storage.local.set({token: 'good'});
  await settle(ctx);
  // The browser rejects an unparseable badge colour; that used to propagate out
  // of check.run() and abort the alarm rearm.
  ctx.__api.action._fail.add('badgeColor');
  ctx.__api.alarms._alarms = {};

  let escaped = null;
  try {
    await ctx.__api.alarms.onAlarm._fire({name: ctx.repeater.NAME});
  }
  catch (e) {
    escaped = e;   // unfixed code propagates the rejection out of the handler
  }
  ok('the failure did not escape the alarm handler', !escaped,
     escaped && String(escaped.message));
  ok('the poll still completed', (await ctx.state.count()) === 1);
  ok('the next alarm was still scheduled',
     Boolean(await ctx.__api.alarms.get(ctx.repeater.NAME)),
     'alarms: ' + JSON.stringify(ctx.__api.alarms._alarms));
  ok('the count still reached the badge despite the colour failing',
     calls.some(c => c[0] === 'badge' && c[1] === '1'));
}

console.log('\n14. review #2: immediate rechecks do not rely on sub-30s alarms');
{
  const server = {token: 'good', requests: [], sets: [], unread: [email('E1', 'a@x.com', 's', 1)]};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});
  calls.length = 0;

  await ctx.repeater.reset('mark-read');

  // Chrome clamps alarms to 30s in packaged extensions, so "check shortly"
  // cannot be an alarm; it has to have happened in-process by now.
  ok('the check ran in-process, not via a short alarm', (await ctx.state.count()) === 1);
  const scheduled = calls.filter(c => c[0] === 'alarm').map(c => c[2]);
  ok('no alarm was scheduled inside Chrome’s 30s clamp',
     scheduled.every(sec => sec >= 30), 'scheduled at (s): ' + JSON.stringify(scheduled));
  ok('the periodic schedule was re-established', scheduled.length > 0);
}

console.log('\n15. review #3: changing the token mid-bootstrap cannot pin the old account');
{
  const server = {token: 'old', requests: [], sets: [], unread: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.state.setToken('old');

  // Hold the session bootstrap open, change the token, then let it finish.
  let release;
  const gate = new Promise(r => (release = r));
  const realFetch = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    if (url.includes('/jmap/session')) {
      await gate;
    }
    return realFetch(url, opts);
  };

  const inflight = ctx.check.execute('slow');
  await ctx.state.setToken('new');          // token replaced mid-bootstrap
  server.token = 'new';
  release();
  await inflight;

  const cached = await ctx.state.session();
  ok('the stale bootstrap did not publish its session',
     !cached || cached.gen === (await ctx.state.tokenGen()),
     'cached: ' + JSON.stringify(cached));

  // And the next check must recover on its own rather than stay wedged.
  await ctx.check.execute('after');
  const after = await ctx.state.session();
  eq('the next check bootstraps under the current generation',
     after.gen, await ctx.state.tokenGen());
}

console.log('\n16. review #4: a backlog rotating into view is not new mail');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});

  // A full page of old unread mail, plus older ones waiting behind it.
  const page = [];
  for (let i = 0; i < 50; i++) {
    page.push(email('N' + i, 'a@x.com', 'recent ' + i, 100 + i));
  }
  const behind = [email('OLD1', 'b@x.com', 'ancient', 5000),
                  email('OLD2', 'b@x.com', 'ancient too', 5001)];
  server.unread = page;
  await ctx.check.execute('first');
  const afterFirst = calls.filter(c => c[0] === 'notify').length;

  // Read the newest two: the two ancient ones rotate into the first page.
  server.unread = page.slice(2).concat(behind);
  await ctx.check.execute('second');
  const notifies = calls.filter(c => c[0] === 'notify');

  eq('cold start announced nothing (all backlog)', afterFirst, 0);
  eq('rotated-in old mail is not announced as new', notifies.length, 0,
     'notifications: ' + JSON.stringify(notifies));

  // ...while genuinely new mail still is.
  server.unread = [email('BRANDNEW', 'z@x.com', 'just arrived', 0)].concat(server.unread);
  await ctx.check.execute('third');
  const after3 = calls.filter(c => c[0] === 'notify');
  eq('genuinely new mail is still announced', after3.length, 1);
  ok('and it is the new one', /just arrived/.test(after3[0][3]));

  const seen = await ctx.state.seenIds();
  eq('seen-ids carry no duplicates', seen.length, new Set(seen).size);
}

console.log('\n17. review #5: a transient failure leaves a steady icon, not the spinner');
{
  const server = {token: 'good', requests: [], sets: [], unread: [email('E1', 'a@x.com', 's', 1)]};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('seed');

  calls.length = 0;
  ctx.fetch = async () => { throw new Error('offline'); };
  await ctx.check.execute('offline');

  const icons = calls.filter(c => c[0] === 'icon').map(c => c[1]);
  ok('an icon was set after the failure', icons.length > 0);
  ok('and it is not left on the loading spinner',
     !/\/load\//.test(icons[icons.length - 1]), 'icons: ' + JSON.stringify(icons));
  ok('the last known count survived', (await ctx.state.count()) === 1);
  ok('the tooltip explains', calls.some(c => c[0] === 'title' && /Last check failed/.test(c[1])));
}

console.log('\n18. review #1: results belonging to a superseded token are discarded');
{
  // Each token sees its own account's mail, so a stale publish is unmistakable.
  const server = {
    token: 'A', tokens: ['A', 'B'], requests: [], sets: [], unread: [],
    unreadByToken: {A: [], B: []}
  };
  const calls = [];
  const ctx = load(server, calls, {worker: true});
  await ctx.state.setToken('A');
  await settle(ctx);

  // Hold the next poll open midway.
  let release;
  const gate = new Promise(r => (release = r));
  let gated = false;
  const realFetch = ctx.fetch;
  ctx.fetch = async (url, opts) => {
    if (opts && opts.method === 'POST' && !gated) {
      gated = true;
      await gate;
    }
    return realFetch(url, opts);
  };

  server.unreadByToken.A = [email('SECRET', 'a@x.com', 'token A mail', 0)];
  const inflight = ctx.check.execute('poll-A');
  await new Promise(r => setTimeout(r, 5));      // let it reach the gate

  // Token replaced while that poll is in flight. Token A stays valid server-side,
  // so the old request will still succeed -- which is the dangerous case.
  server.unreadByToken.B = [email('BMAIL', 'b@x.com', 'token B mail', 0)];
  await ctx.state.setToken('B');
  release();
  await inflight;
  await settle(ctx);

  const subjects = (await ctx.state.messages()).map(m => m.subject);
  ok('the removed account’s mail was never published',
     !subjects.includes('token A mail'), 'published: ' + JSON.stringify(subjects));
  ok('no notification fired for the removed account',
     !calls.some(c => c[0] === 'notify' && /token A mail/.test(c[3])),
     'notifications: ' + JSON.stringify(calls.filter(c => c[0] === 'notify')));

  // The reset fired by the token change must not have been swallowed.
  ok('a follow-up check ran for the current token',
     server.requests.some(r => (r.opts.headers || {}).Authorization === 'Bearer B'));
  ok('and it published the current account’s mail',
     subjects.includes('token B mail'), 'published: ' + JSON.stringify(subjects));
}

console.log('\n19. review #2: every body part is selected, in order');
{
  const ctx = load({token: 'good', unread: [], requests: [], sets: []}, []);
  const sel = ctx.bodyparts.select;

  const email3 = {
    htmlBody: [{partId: '1', type: 'text/html'}, {partId: '2', type: 'text/html'},
               {partId: '3', type: 'text/html'}],
    bodyValues: {1: {value: '<p>one</p>'}, 2: {value: '<p>two</p>'}, 3: {value: '<p>three</p>'}}
  };
  eq('all HTML parts, in declared order',
     sel(email3).map(p => p.value), ['<p>one</p>', '<p>two</p>', '<p>three</p>']);

  eq('a part missing its bodyValues entry does not lose the ones after it',
     sel({htmlBody: [{partId: '1'}, {partId: 'gone'}, {partId: '3'}],
          bodyValues: {1: {value: 'a'}, 3: {value: 'c'}}}).map(p => p.value), ['a', 'c']);

  eq('each part carries its own type, not the list’s',
     sel({htmlBody: [{partId: '1', type: 'text/plain'}, {partId: '2', type: 'text/html'}],
          bodyValues: {1: {value: 'plain'}, 2: {value: '<b>rich</b>'}}}).map(p => p.mime),
     ['text/plain', 'text/html']);

  eq('falls back to every text part when no HTML part has a value',
     sel({htmlBody: [{partId: 'missing'}],
          textBody: [{partId: 't1'}, {partId: 't2'}],
          bodyValues: {t1: {value: 'first'}, t2: {value: 'second'}}}).map(p => p.value),
     ['first', 'second']);

  eq('nothing displayable yields nothing', sel({bodyValues: {}}), []);
  eq('a missing email is tolerated', sel(null), []);
}

console.log('\n20. a dead token must still lead to Options');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const calls = [];
  const ctx = load(server, calls, {worker: true});

  await ctx.__api.runtime.onInstalled._fire();
  const menu = ctx.__api.contextMenus._items['fmc-options'];

  if (mode === 'firefox') {
    ok('Firefox: an Options item is added, since Gecko provides none', Boolean(menu),
       'items: ' + JSON.stringify(Object.keys(ctx.__api.contextMenus._items)));
    eq('on the action context, the MV3 spelling Firefox accepts',
       menu && menu.contexts, ['action']);

    calls.length = 0;
    await ctx.__api.contextMenus.onClicked._fire({menuItemId: 'fmc-options'});
    ok('choosing it opens the options page', calls.some(c => c[0] === 'options'));

    // Chrome persists menus across worker restarts and rejects a duplicate id;
    // a Firefox event page loses them each session. removeAll-then-create suits both.
    await ctx.__api.runtime.onStartup._fire();
    eq('rebuilding leaves exactly one item',
       Object.keys(ctx.__api.contextMenus._items), ['fmc-options']);
  }
  else {
    // Chrome adds its own Options entry for any extension declaring options_ui.
    ok('Chrome: no item is added, so Options is not duplicated', !menu,
       'items: ' + JSON.stringify(Object.keys(ctx.__api.contextMenus._items)));
  }

  // A token Fastmail has rejected is still *stored*, so the old guard passed it
  // through to webmail and stranded the user.
  await ctx.__api.storage.local.set({token: 'revoked'});
  await ctx.state.clearResult();
  await settle(ctx);
  calls.length = 0;
  await ctx.__api.action.onClicked._fire();
  ok('clicking a dead-token button opens Options', calls.some(c => c[0] === 'options'),
     'calls: ' + JSON.stringify(calls));
  ok('and does not open webmail instead',
     !calls.some(c => c[0] === 'tab' && /app\.fastmail\.com/.test(c[1])),
     'calls: ' + JSON.stringify(calls));
}

console.log('\n21. folder names resolve to mailbox ids');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const ctx = load(server, []);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('test');
  const all = ctx.__api.storage.session._data.mailboxes.all;

  const path = name => (all.find(m => m.id === name) || {}).path;
  eq('a nested mailbox carries its full path', path('MB-family'), 'Receipts/Family');
  eq('a top-level one is just its name', path('MB-important'), 'Important');

  const r = n => ctx.folders.resolve(all, n, 'MB-inbox');

  eq('a full path matches', r(['Receipts/Family']).ids, ['MB-family']);
  eq('an unambiguous leaf name matches', r(['Important']).ids, ['MB-important']);
  eq('case and stray spaces do not matter',
     r(['  receipts / family ']).ids, ['MB-family']);

  /* Two folders are called "Notes". Picking one would put a silently wrong number
     on the badge, so the bare name is reported unresolved and the path still works. */
  eq('an ambiguous leaf name resolves to nothing', r(['Notes']).ids, []);
  eq('and is reported so the options page can say why', r(['Notes']).missing, ['Notes']);
  eq('the path disambiguates it', r(['Receipts/Notes']).ids, ['MB-rnotes']);

  eq('an unknown name is reported, not silently dropped', r(['Nope']).missing, ['Nope']);
  eq('the inbox is dropped rather than double-counted', r(['Inbox']).ids, []);
  eq('and is not reported as missing either', r(['Inbox']).missing, []);
  eq('a name repeated in another case counts once', r(['Important', 'important']).ids, ['MB-important']);
  eq('empty input is fine', r([]).ids, []);
  eq('so is a blank entry', r(['', '  ']).ids, []);

  // A cyclic parentId would otherwise recurse until the stack gave out.
  const cyclic = ctx.jmap.paths([{id: 'a', name: 'A', parentId: 'b'}, {id: 'b', name: 'B', parentId: 'a'}]);
  ok('a parent cycle terminates instead of blowing the stack', cyclic.size === 2);
}

console.log('\n22. watched folders feed the badge, the preview and notifications');
{
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('E1', 'a@x.com', 'newest', 1),
             email('X1', 'shop@x.com', 'important charge', 2, ['MB-important']),
             email('E2', 'b@x.com', 'mid', 3),
             email('Z1', 'orders@x.com', 'dispatched', 4, ['MB-family']),
             email('E3', 'c@x.com', 'old', 5)],
    folderUnread: {'MB-important': 1, 'MB-family': 1}
  };
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({
    token: 'good', watchFolders: ['Important', 'Receipts/Family'], notifications: false
  });
  await ctx.check.execute('test');
  const sess = ctx.__api.storage.session._data;

  eq('the badge covers every watched folder', sess.count, 5);
  eq('the breakdown leads with the inbox, then the folders in saved order',
     sess.breakdown, [{name: 'Inbox', unread: 3, inbox: true},
                      {name: 'Important', unread: 1, inbox: false},
                      {name: 'Receipts/Family', unread: 1, inbox: false}]);

  // The point of riding along in the Mailbox/get that already runs.
  eq('every watched folder rides the existing Mailbox/get',
     server.lastBoxIds, ['MB-inbox', 'MB-important', 'MB-family']);

  /* The mailbox list is fetched once and cached, so a steady-state poll is still
     a single round trip no matter how many folders are watched. */
  const before = server.requests.length;
  await ctx.check.execute('again');
  eq('a steady-state poll is still one request', server.requests.length - before, 1);

  eq('the preview list spans the folders, newest first',
     sess.messages.map(m => m.id), ['E1', 'X1', 'E2', 'Z1', 'E3']);
  eq('and the query is an OR across all three mailboxes',
     server.lastFilter, unreadFilter(INBOX, 'MB-important', 'MB-family'));

  const title = calls.filter(c => c[0] === 'title').pop()[1];
  ok('the tooltip explains the total', /\n5 unread\n/.test(title), title);
  ok('naming the inbox share', /3 in Inbox/.test(title), title);
  ok('and each watched folder', /1 in Important/.test(title) && /1 in Receipts\/Family/.test(title), title);
}

console.log('\n23. folder counting degrades safely');
{
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('E1', 'a@x.com', 'hi', 1)],
    folderUnread: {}    // Trash resolves to an id, but the server returns no row for it
  };
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good', watchFolders: ['Trash', 'Ghost']});
  await ctx.check.execute('test');
  const sess = ctx.__api.storage.session._data;

  eq('a folder the server did not return contributes nothing', sess.count, 1);
  eq('and is absent from the breakdown rather than a phantom zero',
     sess.breakdown, [{name: 'Inbox', unread: 1, inbox: true}]);
  ok('an unresolvable name is not sent to the server',
     !(server.lastBoxIds || []).includes('Ghost'));

  const title = calls.filter(c => c[0] === 'title').pop()[1];
  ok('a lone watched inbox reads exactly as it always has',
     /\n1 unread$/.test(title), title);
}

console.log('\n24. mail in a watched folder reaches the preview window');
{
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('A1', 'important@x.com', 'statement', 1, ['MB-important']),
             email('A2', 'important@x.com', 'payment due', 2, ['MB-important'])],
    folderUnread: {'MB-important': 2}
  };
  const calls = [];
  const ctx = load(server, calls, {worker: true});
  await ctx.__api.storage.local.set({token: 'good', watchFolders: ['Important']});
  await ctx.check.execute('test');
  await settle(ctx);

  eq('the badge counts it', ctx.__api.storage.session._data.count, 2);
  eq('and the preview can show it', ctx.__api.storage.session._data.messages.map(m => m.id),
     ['A1', 'A2']);
  /* This used to be the opposite assertion: the preview was inbox-only, so folder
     mail deliberately left the popup detached. It now has something to show. */
  eq('so the popup is attached', calls.filter(c => c[0] === 'popup').pop(),
     ['popup', '/data/popup/index.html']);
}
{
  // Nothing unread anywhere still detaches it, so a click opens webmail.
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const calls = [];
  const ctx = load(server, calls, {worker: true});
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('test');
  await settle(ctx);
  eq('with nothing unread the popup stays detached',
     calls.filter(c => c[0] === 'popup').pop(), ['popup', '']);
}

console.log('\n25. the options page can ask for the folder list');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const ctx = load(server, [], {worker: true});
  await ctx.__api.storage.local.set({token: 'good'});
  await settle(ctx);

  const reply = await new Promise(res =>
    ctx.__api.runtime.onMessage._fire({method: 'folders'}, {}, res));

  ok('the handler answers', reply && reply.ok, JSON.stringify(reply));
  ok('with every mailbox, paths included',
     reply.folders.some(f => f.path === 'Receipts/Family'),
     JSON.stringify(reply.folders));
  eq('and the inbox id, so the picker can mark it always-counted',
     reply.inbox, INBOX);

  // Ticking folders must take effect now, not at the next scheduled poll.
  const before = server.requests.length;
  await ctx.__api.storage.local.set({watchFolders: ['Important']});
  await settle(ctx);
  ok('a changed folder set triggers an immediate re-poll',
     server.requests.length > before);
}

console.log('\n26. the query filter is built to shape');
{
  const ctx = load({token: 'good', requests: [], sets: [], unread: []}, []);
  const f = ctx.jmap.unreadIn;

  eq('no mailbox yields no filter at all', f([]), null);
  eq('one mailbox needs no OR', f(['a']), unreadFilter('a'));
  eq('several become an OR of inMailbox, ANDed with unread',
     f(['a', 'b', 'c']), unreadFilter('a', 'b', 'c'));
  /* Mailbox.unreadEmails counts mail with neither keyword, so a query that
     excluded only $seen would describe a different set from the counter it is
     shown beside -- and would let an unsent draft into the preview. */
  ok('and both unread keywords are always excluded',
     JSON.stringify(f(['a'])).includes('$seen') && JSON.stringify(f(['a'])).includes('$draft'));
  ok('an OR is never emitted with no conditions',
     !JSON.stringify(f(['a'])).includes('"conditions":[]'));
}

console.log('\n27. the inbox can be switched off');
{
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('I1', 'boss@x.com', 'inbox mail', 1),
             email('V1', 'vip@x.com', 'important mail', 2, ['MB-important'])],
    folderUnread: {'MB-important': 1}
  };
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({
    token: 'good', watchInbox: false, watchFolders: ['Important']
  });
  await ctx.check.execute('test');
  const sess = ctx.__api.storage.session._data;

  eq('the inbox is not asked for', server.lastBoxIds, ['MB-important']);
  /* One mailbox again, so the simple condition comes back -- not an OR of one. */
  eq('and one watched folder needs no OR',
     server.lastFilter, unreadFilter('MB-important'));
  eq('the badge counts the folder alone', sess.count, 1);
  eq('inbox mail stays out of the preview', sess.messages.map(m => m.id), ['V1']);
  ok('no notification mentions the inbox message',
     !calls.some(c => c[0] === 'notify' && /inbox mail/.test(String(c[3]))),
     JSON.stringify(calls.filter(c => c[0] === 'notify')));
  ok('but the folder message does notify',
     calls.some(c => c[0] === 'notify' && /important mail/.test(String(c[3]))),
     JSON.stringify(calls.filter(c => c[0] === 'notify')));

  const title = calls.filter(c => c[0] === 'title').pop()[1];
  ok('a single non-inbox folder names itself in the tooltip',
     /1 unread in Important/.test(title), title);
}

console.log('\n28. watching nothing is allowed, but never silent');
{
  const server = {token: 'good', requests: [], sets: [], unread: [email('E1', 'a@x.com', 'hi', 1)]};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good', watchInbox: false, watchFolders: []});
  await ctx.check.execute('test');

  const after = server.requests.length;
  await ctx.check.execute('again');
  eq('a poll with nothing watched issues no request', server.requests.length, after);

  const sess = ctx.__api.storage.session._data;
  eq('the badge is zero', sess.count, 0);
  eq('with nothing to preview', sess.messages, []);
  eq('and nothing to break down', sess.breakdown, []);

  const badge = calls.filter(c => c[0] === 'badge').pop();
  eq('the badge text is cleared', badge, ['badge', '']);
  ok('and is not the amber "!", which means a dead token',
     !calls.some(c => c[0] === 'badge' && c[1] === '!'));
  const title = calls.filter(c => c[0] === 'title').pop()[1];
  ok('the tooltip says why', /no folders are being watched/i.test(title), title);

  /* The easiest bug to introduce here: skipping the timestamp on the empty path
     leaves a stale freshness floor, so re-enabling a folder after a quiet week
     would announce that whole week of backlog as new mail. */
  ok('the check still stamps its timestamp',
     ctx.__api.storage.local._data['last-check-at'] > 0);
}

console.log('\n29. a dead token still reads as a dead token when nothing is watched');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'WRONG', watchInbox: false, watchFolders: []});
  await ctx.check.execute('test');

  /* The connection is made before the empty-watchlist short circuit, so a revoked
     token surfaces as one instead of hiding behind "no folders selected". */
  ok('the amber "!" badge still appears', calls.some(c => c[0] === 'badge' && c[1] === '!'));
  eq('and the count is the unauthenticated sentinel',
     ctx.__api.storage.session._data.count, -1);
}

console.log('\n30. switching a folder on does not announce its backlog');
{
  const old = [];
  for (let i = 0; i < 30; i++) {
    old.push(email('O' + i, 'noise@x.com', 'old thing ' + i, 60 * 24 * 3, ['MB-important']));
  }
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('E1', 'a@x.com', 'inbox mail', 1)],
    folderUnread: {'MB-important': 30}
  };
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('first');          // establishes last-check-at

  server.unread = server.unread.concat(old);
  calls.length = 0;
  await ctx.__api.storage.local.set({watchFolders: ['Important']});
  await ctx.check.execute('folder-added');

  eq('the badge picks the backlog up', ctx.__api.storage.session._data.count, 31);
  eq('but none of it is announced', calls.filter(c => c[0] === 'notify').length, 0);

  // Something genuinely new in that folder still notifies.
  server.unread = server.unread.concat([email('N1', 'new@x.com', 'just arrived', 0, ['MB-important'])]);
  server.folderUnread = {'MB-important': 31};
  calls.length = 0;
  await ctx.check.execute('new-mail');
  const notes = calls.filter(c => c[0] === 'notify');
  eq('exactly one notification', notes.length, 1);
  ok('naming the new message', /just arrived/.test(String(notes[0][3])), JSON.stringify(notes));
  ok('and the folder it came from', /Important/.test(String(notes[0][2])), JSON.stringify(notes));
}

console.log('\n31. a digest says how many it left out');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  for (let i = 0; i < 7; i++) {
    server.unread.push(email('B' + i, 'sender' + i + '@x.com', 'burst ' + i, 0));
  }
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('test');

  const note = calls.filter(c => c[0] === 'notify').pop();
  eq('one digest, not seven popups', calls.filter(c => c[0] === 'notify').length, 1);
  eq('titled with the count', note[2], '7 new messages');
  ok('listing four', (String(note[3]).match(/burst /g) || []).length === 4, String(note[3]));
  ok('and accounting for the rest', /\+ 3 more/.test(String(note[3])), String(note[3]));
}

console.log('\n32. a folder deleted server-side heals itself');
{
  /* The stale id now goes into the Email/query filter, not just Mailbox/get's ids,
     so a server that rejects it kills the whole poll rather than one count. The
     cached mailbox list lives for the browser session, so this has to self-heal. */
  const server = {
    token: 'good', requests: [], sets: [], unread: [email('E1', 'a@x.com', 'hi', 1)],
    folderUnread: {'MB-important': 1}, rejectUnknownMailbox: true
  };
  const ctx = load(server, []);
  await ctx.__api.storage.local.set({token: 'good', watchFolders: ['Important']});
  await ctx.check.execute('warm');
  ok('the mailbox list is cached', Boolean(ctx.__api.storage.session._data.mailboxes));

  // Pretend Fastmail no longer knows MB-important, as it would after a deletion.
  ctx.__api.storage.session._data.mailboxes.all =
    ctx.__api.storage.session._data.mailboxes.all.concat([{id: 'MB-gone', name: 'Gone', path: 'Gone'}]);
  await ctx.__api.storage.local.set({watchFolders: ['Gone']});
  await ctx.check.execute('stale');

  ok('the poisoned cache is dropped so the next poll re-resolves',
     !ctx.__api.storage.session._data.mailboxes);
}

console.log('\n33. back-compatibility with a profile saved before this change');
{
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('E1', 'a@x.com', 'hi', 1)]
  };
  const ctx = load(server, []);
  // No watchInbox key at all, exactly as an existing install has it.
  await ctx.__api.storage.local.set({token: 'good', watchFolders: []});
  await ctx.check.execute('test');

  ok('the key really is absent', !('watchInbox' in ctx.__api.storage.local._data));
  eq('and the inbox is watched anyway', server.lastBoxIds, [INBOX]);
  eq('with the inbox-only filter', server.lastFilter, unreadFilter(INBOX));
  eq('and the inbox mail still arrives',
     ctx.__api.storage.session._data.messages.map(m => m.id), ['E1']);
}

console.log('\n34. a token swap mid-poll cannot publish the old account');
{
  const server = {
    tokens: ['A', 'B'], requests: [], sets: [],
    unreadByToken: {
      A: [email('A1', 'a@x.com', 'mail belonging to account A', 0)],
      B: []
    }
  };
  const calls = [];
  const ctx = load(server, calls);
  await ctx.state.setToken('A');
  await ctx.check.execute('warm');      // caches session and mailboxes under A
  calls.length = 0;                     // the warm run legitimately announced A1

  let release;
  server.gate = new Promise(r => { release = r; });
  const running = ctx.check.execute('slow');
  await new Promise(r => setTimeout(r, 5));
  await ctx.state.setToken('B');        // swap while the poll is in flight
  release();
  await running;
  await settle(ctx);

  const sess = ctx.__api.storage.session._data;
  eq('A\'s mail is not published under B', sess.messages, []);
  eq('nor is A\'s count', sess.count, -1);
  ok('and A\'s mail is never announced',
     !calls.some(c => c[0] === 'notify'), JSON.stringify(calls.filter(c => c[0] === 'notify')));
}

console.log('\n34b. the token and its generation are read together');
{
  const server = {tokens: ['A', 'B'], requests: [], sets: [], unreadByToken: {A: [], B: []}};
  const ctx = load(server, []);
  await ctx.state.setToken('A');

  /* Swap the token the instant anything reads `token` on its own. A torn
     implementation -- state.token() then state.tokenGen() -- takes the bait and
     ends up holding A's token with B's generation, after which every downstream
     fence believes A's results are current and A's session is cached under B. */
  let torn = false;
  ctx.__api.storage.local._beforeGet = async keys => {
    if (!torn && keys.length === 1 && keys[0] === 'token') {
      torn = true;
      await ctx.state.setToken('B');
    }
  };
  await ctx.check.execute('test');
  ctx.__api.storage.local._beforeGet = null;

  ok('no read of the token alone, so a swap has no window to land in', !torn,
     'something read `token` without `token-gen`, which is the race itself');
}

console.log('\n35. a failure from a superseded token leaves the replacement alone');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.state.setToken('A');
  const genA = await ctx.state.tokenGen();
  await ctx.state.setToken('B');
  await ctx.state.setResult({count: 3, messages: [], breakdown: []});

  calls.length = 0;
  await ctx.check.failed(ctx.jmap.err('auth', 'Fastmail rejected the API token (401)'), genA);
  eq('B\'s result survives A\'s 401', ctx.__api.storage.session._data.count, 3);
  ok('and B is not shown as logged out',
     !calls.some(c => c[0] === 'badge' && c[1] === '!'), JSON.stringify(calls));

  // Control: the same failure under the current generation must still log out.
  calls.length = 0;
  await ctx.check.failed(ctx.jmap.err('auth', 'nope'), await ctx.state.tokenGen());
  ok('a current 401 still does', calls.some(c => c[0] === 'badge' && c[1] === '!'));
}

console.log('\n36. replacing the token clears the old account at once');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  const ctx = load(server, []);
  await ctx.state.setToken('A');
  await ctx.state.setResult({count: 5, messages: [{id: 'X1'}], breakdown: [{name: 'Inbox', unread: 5}]});

  await ctx.state.setToken('B');
  const sess = ctx.__api.storage.session._data;
  /* Previously only session/mailboxes were dropped, so the old account's mail
     stayed on the badge and in the popup until a poll under the new token
     succeeded -- for ever, if it never did. */
  eq('the old messages are gone', sess.messages, []);
  eq('and the old count with them', sess.count, -1);
  eq('and the old breakdown', sess.breakdown, []);

  const gens = new Set();
  for (let i = 0; i < 5; i++) {
    await ctx.state.setToken('T' + i);
    gens.add(await ctx.state.tokenGen());
  }
  /* Generations are random ids, not a counter: read-increment-write is not a
     transaction, so two options tabs saving at once could both write the same
     successor and give two different tokens one identity. */
  eq('every token change gets its own generation', gens.size, 5);
}

console.log('\n37. a revoked token is noticed even while nothing is watched');
{
  const server = {tokens: ['good'], requests: [], sets: [], unread: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.state.setToken('good');
  await ctx.check.execute('warm');
  await ctx.__api.storage.local.set({watchInbox: false, watchFolders: []});

  const idle = server.requests.length;
  await ctx.check.execute('idle');
  eq('an idle poll stays off the network', server.requests.length, idle);

  /* ...but not for ever. With a warm cache nothing is ever presented to
     Fastmail, so a revocation would read as a healthy zero and the toolbar
     click would keep opening webmail instead of Options. */
  server.tokens = ['some-other-token'];
  await ctx.state.setAuthAt(Date.now() - 16 * 60 * 1000);
  calls.length = 0;
  await ctx.check.execute('idle-later');

  ok('a stale one revalidates', server.requests.length > idle);
  eq('and the revocation surfaces', ctx.__api.storage.session._data.count, -1);
  ok('with the amber badge that leads back to Options',
     calls.some(c => c[0] === 'badge' && c[1] === '!'), JSON.stringify(calls));
}

console.log('\n38. a preference change mid-poll cancels that poll\'s effects');
{
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('E1', 'a@x.com', 'inbox mail', 0),
             email('X1', 'b@x.com', 'important mail', 0, ['MB-important'])],
    folderUnread: {'MB-important': 1}
  };
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good', watchFolders: ['Important']});
  await ctx.check.execute('warm');

  // Untick the folder while the next poll is in flight.
  let release;
  server.gate = new Promise(r => { release = r; });
  const running = ctx.check.execute('slow');
  await new Promise(r => setTimeout(r, 5));
  await ctx.__api.storage.local.set({watchFolders: []});
  calls.length = 0;
  release();
  await running;
  await settle(ctx);

  /* The watch set is baked into the query, so these results describe a folder
     the user has just stopped watching. A badge can be corrected by the queued
     follow-up; a notification cannot be taken back. */
  ok('the superseded run publishes nothing',
     !calls.some(c => c[0] === 'badge'), JSON.stringify(calls));
  ok('and notifies nothing',
     !calls.some(c => c[0] === 'notify'), JSON.stringify(calls));
}
{
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('E1', 'a@x.com', 'brand new', 0)]
  };
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('warm');
  await ctx.__api.storage.local.set({'seen-ids': []});

  let release;
  server.gate = new Promise(r => { release = r; });
  const running = ctx.check.execute('slow');
  await new Promise(r => setTimeout(r, 5));
  await ctx.__api.storage.local.set({notifications: false});
  calls.length = 0;
  release();
  await running;
  await settle(ctx);

  /* Notification settings are not part of the query, so the run is not discarded
     -- it just has to read them as they are now, not as they were before the
     request went out. */
  ok('switching notifications off takes effect on the poll already running',
     !calls.some(c => c[0] === 'notify'), JSON.stringify(calls));
  ok('while the badge is still published',
     calls.some(c => c[0] === 'badge'), JSON.stringify(calls));
}

console.log('\n39. the badge counts messages, not mailbox memberships');
{
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [email('D1', 'a@x.com', 'filed in both', 1, [INBOX, 'MB-important'])],
    folderUnread: {'MB-important': 1}
  };
  const ctx = load(server, []);
  await ctx.__api.storage.local.set({token: 'good', watchFolders: ['Important']});
  await ctx.check.execute('test');
  const sess = ctx.__api.storage.session._data;

  /* Summing per-mailbox counters would say two; the preview shows one. The
     query's own total is the distinct size of the union, and calculateTotal was
     already being requested and discarded. */
  eq('one message in two watched mailboxes counts once', sess.count, 1);
  eq('and appears once', sess.messages.map(m => m.id), ['D1']);
  eq('while the breakdown still reports each mailbox',
     sess.breakdown, [{name: 'Inbox', unread: 1, inbox: true},
                      {name: 'Important', unread: 1, inbox: false}]);
}
{
  // A server that ignores calculateTotal falls back to the sum rather than zero.
  const server = {
    token: 'good', requests: [], sets: [], omitTotal: true,
    unread: [email('D1', 'a@x.com', 'filed in both', 1, [INBOX, 'MB-important'])],
    folderUnread: {'MB-important': 1}
  };
  const ctx = load(server, []);
  await ctx.__api.storage.local.set({token: 'good', watchFolders: ['Important']});
  await ctx.check.execute('test');
  eq('without a total, the per-mailbox sum is the fallback',
     ctx.__api.storage.session._data.count, 2);
}

console.log('\n40. an unsent draft is not unread mail');
{
  const draft = email('DR1', 'me@x.com', 'half-written', 1, ['MB-important']);
  draft.keywords = {'$draft': true};
  const server = {
    token: 'good', requests: [], sets: [],
    unread: [draft, email('R1', 'a@x.com', 'real mail', 1, ['MB-important'])],
    // RFC 8621: unreadEmails counts mail with neither $seen nor $draft.
    folderUnread: {'MB-important': 1}
  };
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({
    token: 'good', watchInbox: false, watchFolders: ['Important']
  });
  await ctx.check.execute('test');
  const sess = ctx.__api.storage.session._data;

  eq('the draft stays out of the preview', sess.messages.map(m => m.id), ['R1']);
  ok('and is never announced as new mail',
     !calls.some(c => c[0] === 'notify' && /half-written/.test(String(c[3]))),
     JSON.stringify(calls.filter(c => c[0] === 'notify')));
  eq('so the badge and the list agree', sess.count, sess.messages.length);
}

console.log('\n41. the badge counts past the page it can show');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  for (let i = 0; i < 60; i++) {
    server.unread.push(email('P' + i, 'sender@x.com', 'message ' + i, i + 1));
  }
  const ctx = load(server, []);
  await ctx.__api.storage.local.set({token: 'good', notifications: false});
  await ctx.check.execute('test');
  const sess = ctx.__api.storage.session._data;

  const query = server.lastCall.methodCalls.find(c => c[0] === 'Email/query');
  eq('the query asks for one page', query[1].limit, ctx.jmap.LIMIT);
  eq('so the preview holds a page', sess.messages.length, 50);
  eq('newest first', sess.messages[0].id, 'P0');

  /* The badge is not the length of the list. It comes from Email/query's own
     total, which counts the whole filtered union regardless of the page size --
     so a full inbox reads correctly even though only 50 can be flipped through. */
  eq('but the badge reports every unread message', sess.count, 60);
  ok('the badge exceeds what the popup can show', sess.count > sess.messages.length);
}

console.log('\n42. a message rotating into the page is not new mail');
{
  const server = {token: 'good', requests: [], sets: [], unread: []};
  for (let i = 0; i < 60; i++) {
    server.unread.push(email('P' + i, 'sender@x.com', 'message ' + i, 30 + i));
  }
  const calls = [];
  const ctx = load(server, calls);
  await ctx.__api.storage.local.set({token: 'good'});
  await ctx.check.execute('first');

  const seen = ctx.__api.storage.local._data['seen-ids'];
  eq('only the page is remembered', seen.length, 50);
  ok('so P50 has never been seen', !seen.includes('P50'));

  // Read the newest one; P50 rotates into the page for the very first time.
  server.unread = server.unread.filter(e => e.id !== 'P0');
  calls.length = 0;
  await ctx.check.execute('after-read');

  ok('it now appears in the preview',
     ctx.__api.storage.session._data.messages.some(m => m.id === 'P50'));
  /* Absent from seen-ids, and never announced -- but 80 minutes old. This is the
     case the freshness floor exists for: "not in seen-ids" cannot mean "newly
     delivered" once the unread count exceeds one page, because reading anything
     rotates an older message into view. */
  ok('but is not announced as new mail',
     !calls.some(c => c[0] === 'notify'),
     JSON.stringify(calls.filter(c => c[0] === 'notify')));

  // Control, so the assertion above cannot pass by suppressing everything.
  server.unread.unshift(email('NEW', 'new@x.com', 'just arrived', 0));
  calls.length = 0;
  await ctx.check.execute('new-mail');
  ok('while genuinely new mail in the same crowded inbox still is',
     calls.some(c => c[0] === 'notify' && /just arrived/.test(String(c[3]))),
     JSON.stringify(calls.filter(c => c[0] === 'notify')));
}

}

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail ? 1 : 0);
})();
