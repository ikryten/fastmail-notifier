'use strict';

/* The only module that touches api.storage directly.
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
    const stored = await api.storage.local.get(Object.keys(self.state.DEFAULTS));
    return Object.assign({}, self.state.DEFAULTS, stored);
  },

  async setPrefs(o) {
    return api.storage.local.set(o);
  },

  async token() {
    const {token} = await api.storage.local.get('token');
    return token || '';
  },

  /* Bumped on every token change. Cached session/mailbox data is stamped with the
     generation it was built under, so a bootstrap still in flight when the token
     changes cannot publish the old account's apiUrl/accountId over the new one --
     a mismatch that JMAP reports as an ordinary method error, which check.failed
     treats as transient and would therefore never clear. */
  async tokenGen() {
    const {'token-gen': gen} = await api.storage.local.get('token-gen');
    return gen || 0;
  },

  async setToken(token) {
    const gen = (await state.tokenGen()) + 1;
    // Drop the old cache before publishing the new token, so no reader can pair
    // the new token with stale session data.
    await api.storage.session.remove(['session', 'mailboxes']);
    await api.storage.local.set({token, 'token-gen': gen});
  },

  /* --- session-scoped (dies with the browser, which is what we want) --- */

  async session() {
    const {session} = await api.storage.session.get('session');
    return session || null;
  },
  async setSession(session) {
    return api.storage.session.set({session});
  },

  async mailboxes() {
    const {mailboxes} = await api.storage.session.get('mailboxes');
    return mailboxes || null;
  },
  async setMailboxes(mailboxes) {
    return api.storage.session.set({mailboxes});
  },

  async count() {
    const {count} = await api.storage.session.get('count');
    return typeof count === 'number' ? count : 0;
  },

  async messages() {
    const {messages} = await api.storage.session.get('messages');
    return messages || [];
  },

  async setResult({count, messages}) {
    return api.storage.session.set({count, messages});
  },

  async clearResult() {
    return api.storage.session.set({count: self.state.UNAUTHENTICATED, messages: []});
  },

  /* Ids we have already told the user about, so a restart does not
     re-notify for mail they have already seen. Capped so it cannot grow forever. */
  async seenIds() {
    const {'seen-ids': ids} = await api.storage.local.get('seen-ids');
    return Array.isArray(ids) ? ids : [];
  },
  /* Deduplicated before the cap: the caller prepends the current page every poll,
     so without this the same ids repeat until they evict the genuinely old ones
     the list exists to remember. */
  async setSeenIds(ids) {
    return api.storage.local.set({'seen-ids': [...new Set(ids)].slice(0, 500)});
  },

  /* When the last poll completed. Used to decide what counts as newly delivered,
     which "not in seen-ids" cannot answer once the unread count exceeds one page. */
  async lastCheckAt() {
    const {'last-check-at': t} = await api.storage.local.get('last-check-at');
    return t || 0;
  },
  async setLastCheckAt(t) {
    return api.storage.local.set({'last-check-at': t});
  },

  /* Notification silencing: an absolute epoch-ms deadline. */
  async silentUntil() {
    const {'silent-until': t} = await api.storage.session.get('silent-until');
    return t || 0;
  },
  async setSilentUntil(t) {
    return api.storage.session.set({'silent-until': t});
  }
};
