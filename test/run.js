'use strict';
const {load, email, INBOX, TRASH} = require('./harness');

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  \x1b[32mPASS\x1b[0m ' + name); }
  else { fail++; console.log('  \x1b[31mFAIL\x1b[0m ' + name + (extra ? '\n       ' + extra : '')); }
}
function eq(name, a, b) { ok(name, JSON.stringify(a) === JSON.stringify(b), 'got ' + JSON.stringify(a) + '\n       want ' + JSON.stringify(b)); }

(async () => {

console.log('\n1. no token -> logged-out state, no network');
{
  const server = {token: 'good', unread: [], requests: [], sets: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.check.execute('test');
  eq('count is the unauthenticated sentinel', ctx.chrome.storage.session._data.count, -1);
  ok('never hit the network', server.requests.length === 0);
  ok('amber "!" badge', calls.some(c => c[0] === 'badge' && c[1] === '!'));
}

console.log('\n2. bad token -> auth failure surfaces, session cache cleared');
{
  const server = {token: 'good', unread: [], requests: [], sets: []};
  const calls = [];
  const ctx = load(server, calls);
  await ctx.chrome.storage.local.set({token: 'WRONG'});
  await ctx.check.execute('test');
  eq('count is the unauthenticated sentinel', ctx.chrome.storage.session._data.count, -1);
  ok('no stale session left behind', !ctx.chrome.storage.session._data.session);
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
  await ctx.chrome.storage.local.set({token: 'good'});
  await ctx.check.execute('test');

  eq('badge shows the mailbox unread count', ctx.chrome.storage.session._data.count, 3);
  eq('query order is re-imposed over Email/get',
     ctx.chrome.storage.session._data.messages.map(m => m.id), ['E1', 'E2', 'E3']);
  eq('filter targets the inbox and unseen only',
     server.lastFilter, {inMailbox: INBOX, notKeyword: '$seen'});
  eq('sender is flattened for the popup',
     ctx.chrome.storage.session._data.messages[0].fromEmail, 'a@x.com');

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
  await ctx.chrome.storage.local.set({token: 'good'});
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
  await ctx.chrome.storage.local.set({token: 'good', notifyVipOnly: true, vips: ['@work.com'], 'seen-ids': ['seed']});
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
  await ctx.chrome.storage.local.set({token: 'good', 'seen-ids': ['seed']});
  await ctx.state.setSilentUntil(Date.now() + 60000);
  server.unread = [email('E1', 'a@x.com', 'quiet please', 0)];
  await ctx.check.execute('test');
  eq('silenced: no notification', calls.filter(c => c[0] === 'notify').length, 0);
  eq('but the badge still updates', ctx.chrome.storage.session._data.count, 1);
}

console.log('\n7. writes: mark read and trash send correct JMAP patches');
{
  const server = {token: 'good', requests: [], sets: [], unread: [email('E1', 'a@x.com', 's', 1)]};
  const ctx = load(server, []);
  await ctx.chrome.storage.local.set({token: 'good'});
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
  await ctx.chrome.storage.local.set({token: 'good'});
  await ctx.check.execute('seed');
  eq('seeded', ctx.chrome.storage.session._data.count, 1);

  ctx.fetch = async () => { throw new Error('offline'); };
  calls.length = 0;
  await ctx.check.execute('offline');
  eq('count is not flapped to zero', ctx.chrome.storage.session._data.count, 1);
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

console.log('\n' + (fail ? '\x1b[31m' : '\x1b[32m') + pass + ' passed, ' + fail + ' failed\x1b[0m\n');
process.exit(fail ? 1 : 0);
})();
