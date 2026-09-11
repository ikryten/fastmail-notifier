/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict';

/* The poll loop: fetch, diff against what we have already announced, update the
   button, and notify about genuinely new mail. */

const check = {
  /* Re-entrancy guard. Deliberately module scope: it only needs to hold for the
     life of one service-worker invocation, and a stale value after a teardown
     would be worse than no value. */
  running: false,

  /* On a cold start, anything older than this is backlog rather than new mail --
     otherwise installing the extension announces every unread message you already
     have. */
  FRESH_MS: 10 * 60 * 1000,

  /* Tolerance applied to the last-check timestamp, covering clock skew and a poll
     that ran late. */
  SKEW_MS: 60 * 1000,

  /* How stale an authenticated round trip may get while nothing is watched
     before we force one. See run(). */
  REAUTH_MS: 15 * 60 * 1000,

  /* Takes the caller's credential snapshot rather than re-reading the
     generation: recapturing it here is exactly how a run holding the old token
     acquires the new token's generation and then caches the wrong account
     under it. */
  async connection({token, gen}) {
    let session = await state.session();
    if (session && session.gen !== gen) {
      session = null;   // cached under a different token
    }
    if (!session) {
      session = Object.assign(await jmap.bootstrap(token), {gen});
      await state.setAuthAt(Date.now());
      // Re-read: the token may have changed while we were bootstrapping, and
      // publishing this session would then pin the new token to the old account.
      if (await state.tokenGen() === gen) {
        await state.setSession(session);
      }
    }

    let mailboxes = await state.mailboxes();
    if (mailboxes && mailboxes.gen !== gen) {
      mailboxes = null;
    }
    if (!mailboxes) {
      mailboxes = Object.assign(await jmap.mailboxes(token, session), {gen});
      await state.setAuthAt(Date.now());
      if (await state.tokenGen() === gen) {
        await state.setMailboxes(mailboxes);
      }
    }
    return {session, mailboxes};
  },

  /* Every mailbox being watched, in display order: the inbox first when it is
     ticked, then the user's folders in the order they saved them.

     The inbox is held in its own pref rather than by name because JMAP identifies
     it by `role` and mailbox names are localized -- see core/state.js. Here that
     difference disappears: it becomes an ordinary row like any other. */
  /* The part of preferences that is baked into the query, so a change to it
     invalidates a poll already in flight. */
  watchKey(prefs) {
    return JSON.stringify([prefs.watchInbox !== false, prefs.watchFolders || []]);
  },

  watchlist(mailboxes, prefs) {
    const out = [];
    if (prefs.watchInbox !== false) {
      const box = (mailboxes.all || []).find(m => m.id === mailboxes.inbox);
      out.push({id: mailboxes.inbox, name: (box && (box.path || box.name)) || 'Inbox', inbox: true});
    }
    for (const m of folders.resolve(mailboxes.all, prefs.watchFolders, mailboxes.inbox).matched) {
      out.push({id: m.id, name: m.path, inbox: false});
    }
    return out;
  },

  /* Set when a check is requested while one is already running. Module scope, so
     it does not survive worker teardown -- acceptable, because the alarm rearm is
     the durable backstop: losing a queued follow-up costs one poll period, not
     correctness. Dropping the request outright is what was not acceptable, since
     the reset fired by a token change is exactly such a request. */
  pending: false,

  /* The checks a person asked for and is watching happen: the popup's refresh
     button, the context menu item, and a middle click on the toolbar button.
     These hold the spinner; the poll loop and the re-polls that follow a write
     do not, since the popup already shows the result of those. */
  MANUAL: ['manual', 'menu', 'middle-click'],

  async execute(reason) {
    if (check.running) {
      check.pending = true;
      return console.log('[check] busy; queued follow-up for', reason);
    }
    check.running = true;
    try {
      do {
        check.pending = false;
        await check.run(reason);
      }
      while (check.pending);
    }
    catch (e) {
      // run() handles network and JMAP failures itself; anything reaching here is
      // a storage or toolbar failure. Contain it: the caller reschedules the next
      // poll, and letting this escape once stopped polling altogether.
      console.error('[check] unhandled failure', e);
    }
    finally {
      check.running = false;
    }
  },

  async run(reason) {
    console.log('[check] run:', reason);

    const cred = await state.credentials();
    const {token, gen} = cred;
    if (!token) {
      await state.clearResult();
      await button.loggedOut('No API token yet. Open options to add one.');
      return;
    }

    await button.checking(check.MANUAL.includes(reason));

    let prefs = await state.prefs();

    /* Connecting first was supposed to make a revoked token surface even when
       nothing is watched. It does not, once the cache is warm: connection()
       then issues no request, and jmap.poll returns locally for an empty watch
       list, so the token is never presented to Fastmail at all. A revocation
       would look like a healthy zero for as long as the browser session lives,
       and -- because `count` never becomes UNAUTHENTICATED -- the toolbar click
       would keep opening webmail instead of Options.

       So when nothing is watched, drop the cache periodically and make
       connection() re-bootstrap. One cheap GET every REAUTH_MS, against one
       POST a minute in normal operation. */
    if (!button.watching(prefs) &&
        Date.now() - (await state.authAt()) > check.REAUTH_MS) {
      console.log('[check] nothing watched; revalidating the token');
      await api.storage.session.remove(['session', 'mailboxes']);
    }

    let session, mailboxes, watchlist, result;
    try {
      ({session, mailboxes} = await check.connection(cred));
      watchlist = check.watchlist(mailboxes, prefs);
      result = await jmap.poll(token, session, watchlist.map(w => w.id));
      if (watchlist.length) {
        await state.setAuthAt(Date.now());   // poll() only calls out when it has ids
      }
    }
    catch (e) {
      return check.failed(e, gen);
    }

    /* The token can be replaced or removed while the poll is in flight. Publishing
       now would put a removed account's mail on the badge and in the popup, and
       could notify about it -- visible until the next scheduled check. Guarding the
       session cache (in connection()) is not enough on its own; the results have to
       be dropped too. */
    if (await state.tokenGen() !== gen) {
      console.log('[check] token changed mid-poll, discarding results for', reason);
      return;
    }

    /* Preferences can change while the poll is in flight. The watch set is baked
       into the query, so if it moved these results describe folders the user has
       just stopped watching -- publishing them would put withdrawn mail on the
       badge and could raise a notification that cannot be retracted. The storage
       listener has already queued a follow-up that will own those effects. */
    const current = await state.prefs();
    if (check.watchKey(current) !== check.watchKey(prefs)) {
      console.log('[check] watch set changed mid-poll, discarding results for', reason);
      return;
    }
    /* Notification settings are not part of the query, so they need no discard --
       just use the current values rather than the ones captured before the
       request, so switching notifications off takes effect at once rather than
       one poll late. */
    prefs = current;

    const seen = await state.seenIds();
    const seenSet = new Set(seen);
    const now = Date.now();

    /* Absence from seen-ids cannot mean "newly delivered": Email/query returns
       only the newest page, so once the unread count exceeds LIMIT, reading a
       recent message rotates an older one into view for the first time. Judging
       by delivery time as well is what stops that being announced as new mail.

       This is also what makes switching a folder on safe: a folder holding months
       of unread mail fails the timestamp test, so none of it is announced. */
    const lastCheck = await state.lastCheckAt();
    const floor = lastCheck ? lastCheck - check.SKEW_MS : now - check.FRESH_MS;

    const fresh = result.messages.filter(m =>
      !seenSet.has(m.id) && new Date(m.receivedAt).getTime() >= floor);

    /* Label the counts. A watched folder the server returned no row for -- deleted
       or renamed since the mailbox list was cached -- is simply absent, so it
       contributes nothing rather than a phantom zero. */
    const byId = new Map(watchlist.map(w => [w.id, w]));
    const breakdown = result.perBox.map(b => ({
      name: (byId.get(b.id) || {}).name || b.id,
      unread: b.unread,
      inbox: Boolean((byId.get(b.id) || {}).inbox)
    }));

    await state.setResult({count: result.count, messages: result.messages, breakdown});
    await state.setSeenIds(result.messages.map(m => m.id).concat(seen));
    /* Stamped even when nothing is watched. Skipping it would leave a stale floor
       behind, so re-enabling a folder after a quiet week would announce that whole
       week of backlog as new mail. */
    await state.setLastCheckAt(now);

    const paint = flash => button.render({
      count: result.count, breakdown, username: session.username, prefs, flash
    });
    await paint(fresh.length > 0);

    if (fresh.length) {
      /* Fence once more. Several awaited storage and toolbar operations separate
         this from the check above, and unlike a badge, a notification cannot be
         taken back once it is on screen. */
      if (await state.tokenGen() !== gen) {
        return console.log('[check] token changed before notifying; dropped', fresh.length);
      }
      await check.notify(fresh, prefs, mailboxes, watchlist.length > 1);
      // Settle back to the steady-state icon after the flash.
      setTimeout(() => paint(false), 2500);
    }

    // Wake any open popup.
    api.runtime.sendMessage({method: 'update'}).catch(() => {});
  },

  async failed(e, gen) {
    console.warn('[check] failed:', e.code, e.message);

    /* A failure belonging to a superseded token must not touch the
       replacement's state. Without this, a 401 arriving from the old token
       clears the results and shows the logged-out badge for a new token that is
       perfectly good. */
    if (gen !== undefined && await state.tokenGen() !== gen) {
      console.log('[check] failure belongs to a superseded token, ignoring');
      return;
    }

    if (e.code === 'auth' || e.code === 'scope') {
      // The token is dead or wrong-scoped. Drop cached session state so a
      // corrected token re-bootstraps cleanly, and say so plainly.
      await api.storage.session.remove(['session', 'mailboxes']);
      await state.clearResult();
      await button.loggedOut(e.message);
      api.runtime.sendMessage({method: 'update'}).catch(() => {});
      return;
    }
    /* A method-level error can mean a watched folder was deleted in Fastmail: its
       id is still in our cached mailbox list, and it now goes into the Email/query
       filter, where the server may reject it outright -- killing the whole poll,
       not just that folder's count. The cache lives for the browser session, so
       that could persist for days. Dropping it makes the next poll re-resolve, at
       which point the dead folder matches nothing and falls out of the filter.
       Self-terminating: one extra request per failing poll, and it stops as soon
       as the list is fresh again. */
    if (e.code === 'jmap') {
      await api.storage.session.remove(['mailboxes']);
    }

    // Transient: keep the last known good count on screen rather than
    // flapping the badge to zero, but say so in the tooltip.
    const count = await state.count();
    if (count === state.UNAUTHENTICATED) {
      await button.loggedOut(e.message);
      return;
    }
    // Restore the steady-state icon before the tooltip: run() switched it to the
    // spinner on the way in, and leaving it there makes a one-off network blip
    // look like a check that never finishes.
    const session = await state.session();
    await button.render({
      count,
      breakdown: await state.breakdown(),
      username: (session && session.username) || '',
      prefs: await state.prefs(),
      flash: false
    });
    await button.label(button.APP + '\nLast check failed: ' + e.message);
  },

  matchesVip(message, prefs) {
    if (!prefs.notifyVipOnly) {
      return true;
    }
    return prefs.vips.some(v => v && message.fromEmail.includes(v.toLowerCase()));
  },

  async notify(messages, prefs, mailboxes, showFolder) {
    if (!prefs.notifications) {
      return;
    }
    if (Date.now() < await state.silentUntil()) {
      return console.log('[check] silenced, skipping', messages.length, 'notifications');
    }
    const wanted = messages.filter(m => check.matchesVip(m, prefs));
    if (!wanted.length) {
      return;
    }

    // One notification for a single message; a digest for a burst, so a batch
    // delivery cannot produce a stack of twenty popups.
    if (wanted.length === 1) {
      const m = wanted[0];
      const preview = m.preview.slice(0, 120);
      /* Which folder, but only when more than one is being watched -- with just
         the inbox it says nothing the user does not already know. It goes in the
         title because Firefox accepts only type/title/message/iconUrl, so there
         is no contextMessage to put it in. */
      const where = showFolder ? folders.labelFor(mailboxes, m.mailboxIds) : '';
      // The preview goes in `message` rather than `contextMessage`: Firefox
      // supports neither contextMessage nor silent, and a single multi-line
      // message renders correctly in both browsers.
      return check.createNotification(m.id, {
        title: where ? m.fromName + ' \u00b7 ' + where : m.fromName,
        message: preview ? m.subject + '\n' + preview : m.subject
      });
    }
    /* A digest, so a batch delivery cannot produce a stack of twenty popups. Only
       four fit; say so rather than leaving the rest invisible, which matters more
       now that several folders can feed one notification. */
    const lines = wanted.slice(0, 4).map(m => m.fromName + ' - ' + m.subject);
    const rest = wanted.length - 4;
    if (rest > 0) {
      lines.push('+ ' + rest + ' more');
    }
    return check.createNotification(wanted[0].id, {
      title: wanted.length + ' new messages',
      message: lines.join('\n')
    });
  },

  async createNotification(emailId, opts) {
    const id = 'fmc:' + emailId;
    try {
      // Keep to the intersection both browsers accept: Firefox supports only
      // type, title, message and iconUrl, and only type 'basic'.
      await api.notifications.create(id, Object.assign({
        type: 'basic',
        iconUrl: api.runtime.getURL('/data/icons/red/128.png')
      }, opts));
    }
    catch (e) {
      console.warn('[check] notification failed', e);
    }
  }
};

self.check = check;
