'use strict';
/* Runs the real core/ modules against a mocked chrome.* and a mocked Fastmail.
   No token and no network: this checks the shape of what we send and the logic
   of what we do with what comes back. */

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.join(__dirname, '..');

function makeStorageArea() {
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
    },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) delete data[k];
    },
    onChanged: {addListener: fn => listeners.push(fn)}
  };
}

function buildChrome(calls) {
  return {
    storage: {local: makeStorageArea(), session: makeStorageArea()},
    action: {
      async setIcon(o) { calls.push(['icon', o.path[16]]); },
      async setBadgeText(o) { calls.push(['badge', o.text]); },
      async setBadgeBackgroundColor(o) { calls.push(['badgeColor', o.color]); },
      async setTitle(o) { calls.push(['title', o.title]); },
      async setPopup(o) { calls.push(['popup', o.popup]); }
    },
    notifications: {
      async create(id, o) { calls.push(['notify', id, o.title, o.message]); },
      onClicked: {addListener() {}}
    },
    alarms: {
      async get() { return null; },
      async create(n, o) { calls.push(['alarm', n, Math.round((o.when - Date.now()) / 1000)]); },
      async clear() {},
      onAlarm: {addListener() {}}
    },
    runtime: {
      getURL: p => 'chrome-extension://test' + p,
      sendMessage: async () => {},
      onMessage: {addListener() {}},
      onStartup: {addListener() {}},
      onInstalled: {addListener() {}}
    },
    idle: {setDetectionInterval() {}, onStateChanged: {addListener() {}}},
    tabs: {async create() {}, async query() { return [{id: 1}]; }, async update() {}}
  };
}

/* --- the fake Fastmail --- */

const INBOX = 'MB-inbox', TRASH = 'MB-trash';

function makeFetch(server) {
  return async function (url, opts) {
    server.requests.push({url, opts});

    const auth = (opts.headers || {}).Authorization;
    if (auth !== 'Bearer ' + server.token) {
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
    const responses = body.methodCalls.map(([name, args, tag]) => {
      if (name === 'Mailbox/get' && args.ids === null) {
        return ['Mailbox/get', {list: [
          {id: INBOX, name: 'Inbox', role: 'inbox'},
          {id: TRASH, name: 'Trash', role: 'trash'},
          {id: 'MB-important', name: 'Important', role: null}
        ]}, tag];
      }
      if (name === 'Mailbox/get') {
        return ['Mailbox/get', {list: [{id: INBOX, unreadEmails: server.unread.length, totalEmails: 33855}]}, tag];
      }
      if (name === 'Email/query') {
        server.lastFilter = args.filter;
        return ['Email/query', {ids: server.unread.map(e => e.id), total: server.unread.length}, tag];
      }
      if (name === 'Email/get') {
        // Deliberately return them out of order: the client must re-impose query order.
        return ['Email/get', {list: [...server.unread].reverse()}, tag];
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

function load(server, calls) {
  const sandbox = {console, setTimeout, clearTimeout, AbortController, URL, Intl, Date, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Boolean, Error};
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.chrome = buildChrome(calls);
  sandbox.fetch = makeFetch(server);
  vm.createContext(sandbox);
  for (const f of ['core/state.js', 'core/jmap.js', 'core/button.js', 'core/check.js', 'core/repeater.js']) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, {filename: f});
  }
  return sandbox;
}

module.exports = {load, email, INBOX, TRASH, makeStorageArea};
