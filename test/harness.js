/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict';
/* Runs the real core/ modules against a mocked chrome.* and a mocked Fastmail.
   No token and no network: this checks the shape of what we send and the logic
   of what we do with what comes back. */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let MODE = 'chrome';
const setMode = m => { MODE = m; };

function makeStorageArea(name, globalListeners) {
  const data = {};
  const listeners = [];
  return {
    _data: data,
    _listeners: listeners,
    /* Lets a test run code *between* two reads, which is the only way to
       reproduce a torn read of values that must be fetched together. */
    _beforeGet: null,
    async get(keys) {
      if (this._beforeGet) await this._beforeGet(Array.isArray(keys) ? keys : [keys]);
      if (keys === null || keys === undefined) return {...data};
      const list = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of list) if (k in data) out[k] = data[k];
      return out;
    },
    async set(o) {
      const changes = {};
      for (const [k, v] of Object.entries(o)) {
        changes[k] = {oldValue: data[k], newValue: v};
        data[k] = v;
      }
      listeners.forEach(fn => fn(changes));
      globalListeners.forEach(fn => fn(changes, name));
    },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete data[k];
    },
    onChanged: {addListener: fn => listeners.push(fn)}
  };
}

/* Firefox accepts only these NotificationOptions, and only type 'basic'.
   Simulating that here is the point of the Firefox mode: it turns a silent
   cross-browser breakage into a failing test. */
const FIREFOX_NOTIFICATION_KEYS = ['type', 'title', 'message', 'iconUrl'];

function mkEvent() {
  const listeners = [];
  return {
    addListener: fn => listeners.push(fn),
    async _fire(...args) {
      for (const fn of listeners) {
        await fn(...args);
      }
    },
    _count: () => listeners.length
  };
}

function buildChrome(calls) {
  const globalListeners = [];
  return {
    storage: {
      local: makeStorageArea('local', globalListeners),
      session: makeStorageArea('session', globalListeners),
      onChanged: {addListener: fn => globalListeners.push(fn)}
    },
    action: {
      // Tests add names here to make a specific setter reject, the way the
      // browser rejects e.g. an unparseable badge color.
      _fail: new Set(),
      async setIcon(o) {
        if (this._fail.has('icon')) throw new Error('bad icon');
        calls.push(['icon', o.path[16]]);
      },
      async setBadgeText(o) {
        if (this._fail.has('badgeText')) throw new Error('bad badge text');
        calls.push(['badge', o.text]);
      },
      async setBadgeBackgroundColor(o) {
        if (this._fail.has('badgeColor')) throw new Error('Invalid color: ' + o.color);
        calls.push(['badgeColor', o.color]);
      },
      async setTitle(o) {
        if (this._fail.has('title')) throw new Error('bad title');
        calls.push(['title', o.title]);
      },
      async setPopup(o) { calls.push(['popup', o.popup]); },
      onClicked: mkEvent()
    },
    notifications: {
      async clear() {},
      async create(id, o) {
        if (MODE === 'firefox') {
          const bad = Object.keys(o).filter(k => !FIREFOX_NOTIFICATION_KEYS.includes(k));
          if (bad.length) {
            throw new Error('Firefox rejects NotificationOptions: ' + bad.join(', '));
          }
          if (o.type !== 'basic') {
            throw new Error('Firefox supports only type "basic", got ' + o.type);
          }
        }
        calls.push(['notify', id, o.title, o.message]);
      },
      onClicked: {addListener() {}}
    },
    alarms: {
      _alarms: {},
      async get(n) { return this._alarms[n] || null; },
      async create(n, o) {
        this._alarms[n] = {name: n, scheduledTime: o.when};
        calls.push(['alarm', n, Math.round((o.when - Date.now()) / 1000)]);
      },
      async clear(n) { delete this._alarms[n]; },
      async getAll() { return Object.values(this._alarms); },
      onAlarm: mkEvent()
    },
    contextMenus: {
      _items: {},
      async removeAll() { this._items = {}; },
      async create(o) { this._items[o.id] = o; calls.push(['menu', o.id, o.title]); },
      onClicked: mkEvent()
    },
    runtime: {
      getURL: p => 'chrome-extension://test' + p,
      // Read the real manifest rather than a literal, so the name the code shows
      // is the name the manifest actually declares.
      getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')),
      sendMessage: async () => {},
      openOptionsPage: async () => { calls.push(['options']); },
      // Firefox-only API; its presence is how the code detects Gecko.
      ...(MODE === 'firefox' ? {getBrowserInfo: async () => ({name: 'Firefox'})} : {}),
      onMessage: mkEvent(),
      onStartup: mkEvent(),
      onInstalled: mkEvent()
    },
    idle: {setDetectionInterval() {}, onStateChanged: mkEvent()},
    tabs: {
      async create(o) { calls.push(['tab', o.url]); },
      async query() { return [{id: 1}]; },
      async update(id, o) { calls.push(['tab', o.url]); }
    }
  };
}

/* --- the fake Fastmail --- */

const INBOX = 'MB-inbox', TRASH = 'MB-trash';

/* Deliberately includes nesting and a duplicated leaf name ("Notes" under two
   different parents), because those are exactly the cases folder resolution has
   to get right. */
const MAILBOXES = [
  {id: INBOX, name: 'Inbox', role: 'inbox', parentId: null},
  {id: TRASH, name: 'Trash', role: 'trash', parentId: null},
  {id: 'MB-important', name: 'Important', role: null, parentId: null},
  {id: 'MB-receipts', name: 'Receipts', role: null, parentId: null},
  {id: 'MB-family', name: 'Family', role: null, parentId: 'MB-receipts'},
  {id: 'MB-rnotes', name: 'Notes', role: null, parentId: 'MB-receipts'},
  {id: 'MB-inotes', name: 'Notes', role: null, parentId: 'MB-important'}
];

function makeFetch(server) {
  return async function (url, opts) {
    server.requests.push({url, opts});

    const auth = (opts.headers || {}).Authorization;
    const accepted = server.tokens
      ? server.tokens.some(t => auth === 'Bearer ' + t)
      : auth === 'Bearer ' + server.token;
    if (!accepted) {
      return {ok: false, status: 401, async json() { return {}; }, async text() { return 'No Authorization header'; }};
    }

    if (url === 'https://api.fastmail.com/jmap/session') {
      return json({
        apiUrl: 'https://phl.api.fastmail.com/jmap/api/',
        downloadUrl: 'https://dl.fastmail.com/{accountId}/{blobId}/{name}?accept={type}',
        eventSourceUrl: 'https://phl.api.fastmail.com/jmap/event/',
        primaryAccounts: {'urn:ietf:params:jmap:mail': 'acct1'},
        username: 'me@fastmail.com'
      });
    }

    /* Lets a test hold a poll in flight while it changes something underneath:
       set server.gate to a promise and the answer waits on it. Only the API POST
       is gated, so a warm-up bootstrap still completes normally. */
    if (server.gate) {
      await server.gate;
    }

    const body = JSON.parse(opts.body);
    server.lastCall = body;

    /* Mail is resolved per token when `unreadByToken` is set, so a request issued
       under an old token keeps seeing that account's mail. Without this the fake
       server hands every in-flight request the newest data, and a test cannot tell
       a stale-account bug from a mere timing difference. */
    const bearer = String(auth || '').replace(/^Bearer /, '');
    const unread = server.unreadByToken
      ? (server.unreadByToken[bearer] || [])
      : server.unread;
    const responses = body.methodCalls.map(([name, args, tag]) => {
      if (name === 'Mailbox/get' && args.ids === null) {
        return ['Mailbox/get', {list: MAILBOXES.map(m => ({...m}))}, tag];
      }
      if (name === 'Mailbox/get') {
        server.lastBoxIds = args.ids;
        /* Per-folder unread comes from server.folderUnread. An id absent from that
           map returns no entry at all, which is how a real server answers for a
           mailbox that has since been deleted -- so `{'MB-x': 0}` and "no MB-x"
           are distinguishable, and both are worth testing. */
        const fu = server.folderUnread || {};
        const list = (args.ids || []).map(id => {
          if (id in fu) {
            return {id, unreadEmails: fu[id], totalEmails: fu[id]};
          }
          /* The inbox falls back to the fixture list, so the many tests that only
             ever set `server.unread` keep working untouched. */
          if (id === INBOX) {
            const n = unread.filter(e => (e.mailboxIds || {})[INBOX]).length;
            return {id: INBOX, unreadEmails: n, totalEmails: 33855};
          }
          return null;
        }).filter(Boolean);
        return ['Mailbox/get', {list}, tag];
      }
      if (name === 'Email/query') {
        server.lastFilter = args.filter;
        const boxes = filterMailboxes(args.filter);
        if (server.rejectUnknownMailbox && boxes.some(b => !MAILBOXES.some(m => m.id === b))) {
          return ['error', {type: 'invalidArguments'}, tag];
        }
        /* Actually apply the filter. Returning everything regardless would let a
           broken filter pass every assertion about which folders reach the
           preview -- the whole point of the multi-mailbox query. */
        const hits = unread
          .filter(e => !(e.keywords || {})['$draft'])
          .filter(e => boxes.some(b => (e.mailboxIds || {})[b]))
          .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
        /* Honor `limit`, and report the true total alongside a short page --
           which is what a real server does, and the only way a test can tell the
           badge apart from the length of the list the popup can show. */
        const page = typeof args.limit === 'number' ? hits.slice(0, args.limit) : hits;
        server.lastHits = page;
        const q = {ids: page.map(e => e.id)};
        // server.omitTotal models a server that ignores calculateTotal, so the
        // client's fallback to the per-mailbox sum is exercised.
        if (!server.omitTotal) {
          q.total = hits.length;
        }
        return ['Email/query', q, tag];
      }
      if (name === 'Email/get') {
        const hits = server.lastHits || unread;
        // Deliberately return them out of order: the client must re-impose query order.
        return ['Email/get', {list: [...hits].reverse()}, tag];
      }
      if (name === 'Email/set') {
        server.sets.push(args.update);
        const updated = {};
        for (const id of Object.keys(args.update)) updated[id] = null;
        return ['Email/set', {updated, notUpdated: {}}, tag];
      }
      return ['error', {type: 'unknownMethod'}, tag];
    });
    return json({methodResponses: responses});
  };
}

/* Read the mailbox ids out of either filter shape the client may send. Anything
   else throws rather than matching loosely: a malformed filter should fail the
   test that built it, not quietly behave like "everything". */
function filterMailboxes(filter) {
  if (!filter || filter.operator !== 'AND' || !Array.isArray(filter.conditions)) {
    throw new Error('unrecognized Email/query filter: ' + JSON.stringify(filter));
  }
  /* Both exclusions are required: Mailbox.unreadEmails counts mail with neither
     $seen nor $draft, so a query that forgets $draft describes a different set
     from the counter it is paired with. */
  const excludes = k => filter.conditions.some(c => c.notKeyword === k);
  if (!excludes('$seen') || !excludes('$draft')) {
    throw new Error('Email/query must exclude both $seen and $draft: ' + JSON.stringify(filter));
  }
  const one = filter.conditions.find(c => c.inMailbox);
  if (one) {
    return [one.inMailbox];
  }
  const or = filter.conditions.find(c => c.operator === 'OR');
  if (or && or.conditions.length) {
    return or.conditions.map(c => c.inMailbox);
  }
  throw new Error('unrecognized Email/query filter: ' + JSON.stringify(filter));
}

function json(o) {
  return {ok: true, status: 200, async json() { return o; }, async text() { return JSON.stringify(o); }};
}

function email(id, from, subject, minsAgo, boxes) {
  return {
    id, threadId: 'T' + id,
    mailboxIds: Object.fromEntries((boxes || [INBOX]).map(b => [b, true])),
    from: [{name: from.split('@')[0], email: from}],
    subject, receivedAt: new Date(Date.now() - minsAgo * 60000).toISOString(),
    preview: 'preview of ' + subject, hasAttachment: false
  };
}

/* --- bootstrap a context --- */

function load(server, calls, opts) {
  const sandbox = {console, setTimeout, clearTimeout, AbortController, URL, Intl, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error, crypto};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;

  const apiObj = buildChrome(calls);
  // Expose exactly one namespace, as each browser really does: Firefox's
  // promise-based APIs live on `browser`, and older Chrome has only `chrome`.
  // core/api.js has to pick the right one with no other help.
  if (MODE === 'firefox') {
    sandbox.browser = apiObj;
  }
  else {
    sandbox.chrome = apiObj;
  }
  sandbox.__api = apiObj;   // stable handle for assertions, not visible to the code

  sandbox.fetch = makeFetch(server);
  vm.createContext(sandbox);
  const files = ['core/api.js', 'core/state.js', 'core/urls.js', 'core/bodyparts.js',
                 'core/folders.js', 'core/jmap.js',
                 'core/button.js', 'core/check.js', 'core/repeater.js'];
  /* Models the Chrome Web Store build, which drops the contextMenus permission
     -- at which point the namespace does not exist at all. */
  if (opts && opts.noContextMenus) {
    delete apiObj.contextMenus;
  }
  if (opts && opts.worker) {
    files.push('worker.js');
  }
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, {filename: f});
  }
  return sandbox;
}

module.exports = {load, email, INBOX, TRASH, MAILBOXES, setMode};
