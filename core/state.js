/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
    // Matches the rendering choice this extension was built around. Turning it off
    // stops previews making any sender-controlled request.
    loadRemoteImages: true,
    vips: [],                 // lowercase substrings matched against the From address
    /* The folders this extension watches: counted on the badge, shown in the
       preview, and notified about. Stored as names or "Parent/Child" paths rather
       than mailbox ids -- see core/folders.js for why.

       The inbox is held separately because it is identified by `role`, not by
       name: JMAP names are localized, so "Inbox" is not a portable way to refer to
       it. Keeping it out of the list also means an existing profile, which has no
       watchInbox key at all, falls through to the default and keeps watching the
       inbox exactly as before. */
    watchInbox: true,
    watchFolders: [],
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

  /* Token and generation together, in a single read.

     Reading them separately is a race with a genuine bite: a token change
     landing between the two gets hands the caller token A stamped with B's
     generation, after which every downstream fence believes A's results are
     current -- and A's session gets cached under B's generation, so B's own
     polls reuse it for as long as the browser session lives. setToken writes
     both keys in one set, so one get is atomic against it. */
  async credentials() {
    const got = await api.storage.local.get(['token', 'token-gen']);
    return {token: got.token || '', gen: got['token-gen'] || ''};
  },

  /* Bumped on every token change. Cached session/mailbox data is stamped with the
     generation it was built under, so a bootstrap still in flight when the token
     changes cannot publish the old account's apiUrl/accountId over the new one --
     a mismatch that JMAP reports as an ordinary method error, which check.failed
     treats as transient and would therefore never clear. */
  async tokenGen() {
    const {'token-gen': gen} = await api.storage.local.get('token-gen');
    // Same empty default as credentials(), or the two disagree for a profile
    // that has a token but no generation yet and every fence misfires.
    return gen || '';
  },

  async setToken(token) {
    /* A random id rather than a counter. Read-increment-write is not a
       transaction: two options tabs saving at once both read N and both write
       N+1, giving two different tokens the same generation. Nothing here needs
       ordering, only difference. */
    const gen = crypto.randomUUID();
    /* Drop the old account's cache *and* its results before publishing the new
       token, so no reader can pair the new token with stale session data and no
       stale mail stays on screen. Clearing only the cache left the previous
       account's badge, messages and breakdown visible until a poll under the new
       token succeeded -- indefinitely, if it never did. */
    await api.storage.session.remove(['session', 'mailboxes']);
    await state.clearResult();
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

  /* The badge number: unread across every watched folder. */
  async count() {
    const {count} = await api.storage.session.get('count');
    return typeof count === 'number' ? count : 0;
  },

  /* Per-folder unread, for the tooltip: [{name, unread}]. Includes the inbox when
     it is watched, since it is no longer a special case. */
  async breakdown() {
    const {breakdown} = await api.storage.session.get('breakdown');
    return Array.isArray(breakdown) ? breakdown : [];
  },

  async messages() {
    const {messages} = await api.storage.session.get('messages');
    return messages || [];
  },

  async setResult({count, messages, breakdown}) {
    return api.storage.session.set({count, messages, breakdown: breakdown || []});
  },

  async clearResult() {
    return api.storage.session.set({
      count: self.state.UNAUTHENTICATED, messages: [], breakdown: [], resume: null
    });
  },

  /* Where the reader had got to in the message list when the popup last closed.

     The popup is a page, not a persistent view: the browser destroys it on every
     close, so paging to the twelfth message and glancing away meant starting from
     the first one again. This is the one piece of popup state worth outliving it.

     Two message ids, never an index. The list is republished on every poll, so an
     index would come back silently pointing at a different message -- and `head`,
     the id that was at the top of the list when we left, is what decides whether
     to resume at all. See the popup for why arriving mail cancels the resume. */
  async resumeAt() {
    const {resume} = await api.storage.session.get('resume');
    return resume || null;
  },
  async setResumeAt(resume) {
    return api.storage.session.set({resume: resume || null});
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

  /* When Fastmail last accepted us. Deliberately separate from last-check-at:
     that one is the notification freshness floor and has to advance even on a
     poll that made no request, whereas this must only move when the token was
     actually presented to the server and worked. */
  async authAt() {
    const {'auth-at': t} = await api.storage.session.get('auth-at');
    return t || 0;
  },
  async setAuthAt(t) {
    return api.storage.session.set({'auth-at': t});
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
