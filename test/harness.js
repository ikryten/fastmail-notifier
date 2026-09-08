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
    async get(keys) {
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
      // browser rejects e.g. an unparseable badge colour.
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
    runtime: {
      getURL: p => 'chrome-extension://test' + p,
      // Read the real manifest rather than a literal, so the name the code shows
      // is the name the manifest actually declares.
      getManifest: () => JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8')),
      sendMessage: async () => {},
      openOptionsPage: async () => {},
      onMessage: mkEvent(),
      onStartup: mkEvent(),
      onInstalled: mkEvent()
    },
    idle: {setDetectionInterval() {}, onStateChanged: mkEvent()},
    tabs: {async create() {}, async query() { return [{id: 1}]; }, async update() {}}
  };
}

/* --- the fake Fastmail --- */

const INBOX = 'MB-inbox', TRASH = 'MB-trash';

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
        return ['Mailbox/get', {list: [
          {id: INBOX, name: 'Inbox', role: 'inbox'},
          {id: TRASH, name: 'Trash', role: 'trash'},
          {id: 'MB-important', name: 'Important', role: null}
        ]}, tag];
      }
      if (name === 'Mailbox/get') {
        return ['Mailbox/get', {list: [{id: INBOX, unreadEmails: unread.length, totalEmails: 33855}]}, tag];
      }
      if (name === 'Email/query') {
        server.lastFilter = args.filter;
        return ['Email/query', {ids: unread.map(e => e.id), total: unread.length}, tag];
      }
      if (name === 'Email/get') {
        // Deliberately return them out of order: the client must re-impose query order.
        return ['Email/get', {list: [...unread].reverse()}, tag];
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

function json(o) {
  return {ok: true, status: 200, async json() { return o; }, async text() { return JSON.stringify(o); }};
}

function email(id, from, subject, minsAgo) {
  return {
    id, threadId: 'T' + id, mailboxIds: {[INBOX]: true},
    from: [{name: from.split('@')[0], email: from}],
    subject, receivedAt: new Date(Date.now() - minsAgo * 60000).toISOString(),
    preview: 'preview of ' + subject, hasAttachment: false
  };
}

/* --- bootstrap a context --- */

function load(server, calls, opts) {
  const sandbox = {console, setTimeout, clearTimeout, AbortController, URL, Intl, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error};
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
  const files = ['core/api.js', 'core/state.js', 'core/urls.js', 'core/bodyparts.js', 'core/jmap.js',
                 'core/button.js', 'core/check.js', 'core/repeater.js'];
  if (opts && opts.worker) {
    files.push('worker.js');
  }
  for (const f of files) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, {filename: f});
  }
  return sandbox;
}

module.exports = {load, email, INBOX, TRASH, setMode};
