'use strict';

/* The only module that touches chrome.storage directly.
   Keeping it in one place is what makes the Firefox port cheap, and it is also
   the single source of truth for what "state" means in an MV3 world where the
   service worker is torn down constantly. Nothing mutable lives in module scope. */

self.state = {
  /* Persisted across browser restarts. */
  DEFAULTS: {
    period: 60,               // seconds between polls
    badge: true,
    badgeColor: '#d93025',
    notifications: true,
    notifyVipOnly: false,
    vips: [],                 // lowercase substrings matched against the From address
    openInNewTab: true
  },

  /* count === -1 is the sentinel for "we have no working token".
     Borrowed from ignotifier; it lets every consumer distinguish
     "zero unread" from "not authenticated" without a second flag. */
  UNAUTHENTICATED: -1,

  async prefs() {
    const stored = await chrome.storage.local.get(Object.keys(self.state.DEFAULTS));
    return Object.assign({}, self.state.DEFAULTS, stored);
  },

  async setPrefs(o) {
    return chrome.storage.local.set(o);
  },

  async token() {
    const {token} = await chrome.storage.local.get('token');
    return token || '';
  },

  async setToken(token) {
    await chrome.storage.local.set({token});
    // A new token invalidates everything we cached about the old one.
    await chrome.storage.session.remove(['session', 'mailboxes']);
  },

  /* --- session-scoped (dies with the browser, which is what we want) --- */

  async session() {
    const {session} = await chrome.storage.session.get('session');
    return session || null;
  },
  async setSession(session) {
    return chrome.storage.session.set({session});
  },

  async mailboxes() {
    const {mailboxes} = await chrome.storage.session.get('mailboxes');
    return mailboxes || null;
  },
  async setMailboxes(mailboxes) {
    return chrome.storage.session.set({mailboxes});
  },

  async count() {
    const {count} = await chrome.storage.session.get('count');
    return typeof count === 'number' ? count : 0;
  },

  async messages() {
    const {messages} = await chrome.storage.session.get('messages');
    return messages || [];
  },

  async setResult({count, messages}) {
    return chrome.storage.session.set({count, messages});
  },

  async clearResult() {
    return chrome.storage.session.set({count: self.state.UNAUTHENTICATED, messages: []});
  },

  /* Ids we have already told the user about, so a restart does not
     re-notify for mail they have already seen. Capped so it cannot grow forever. */
  async seenIds() {
    const {'seen-ids': ids} = await chrome.storage.local.get('seen-ids');
    return Array.isArray(ids) ? ids : [];
  },
  async setSeenIds(ids) {
    return chrome.storage.local.set({'seen-ids': ids.slice(0, 500)});
  },

  /* Notification silencing: an absolute epoch-ms deadline. */
  async silentUntil() {
    const {'silent-until': t} = await chrome.storage.session.get('silent-until');
    return t || 0;
  },
  async setSilentUntil(t) {
    return chrome.storage.session.set({'silent-until': t});
  }
};
