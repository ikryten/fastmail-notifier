'use strict';

/* The poll loop: fetch, diff against what we have already announced, update the
   button, and notify about genuinely new mail. */

const check = {
  /* Re-entrancy guard. Deliberately module scope: it only needs to hold for the
     life of one service-worker invocation, and a stale value after a teardown
     would be worse than no value. */
  running: false,

  /* Anything older than this on first sight is treated as backlog, not new mail --
     otherwise installing the extension notifies you about every unread message
     you already have. */
  FRESH_MS: 10 * 60 * 1000,

  async connection(token) {
    let session = await state.session();
    if (!session) {
      session = await jmap.bootstrap(token);
      await state.setSession(session);
    }
    let mailboxes = await state.mailboxes();
    if (!mailboxes) {
      mailboxes = await jmap.mailboxes(token, session);
      await state.setMailboxes(mailboxes);
    }
    return {session, mailboxes};
  },

  async execute(reason) {
    if (check.running) {
      return console.log('[check] already running, ignoring', reason);
    }
    check.running = true;
    try {
      await check.run(reason);
    }
    finally {
      check.running = false;
    }
  },

  async run(reason) {
    console.log('[check] run:', reason);

    const token = await state.token();
    if (!token) {
      await state.clearResult();
      await button.loggedOut('No API token yet. Open options to add one.');
      return;
    }

    await button.checking();

    let session, mailboxes, result;
    try {
      ({session, mailboxes} = await check.connection(token));
      result = await jmap.poll(token, session, mailboxes);
    }
    catch (e) {
      return check.failed(e);
    }

    const prefs = await state.prefs();
    const seen = await state.seenIds();
    const seenSet = new Set(seen);
    const now = Date.now();

    const fresh = result.messages.filter(m => {
      if (seenSet.has(m.id)) {
        return false;
      }
      // On a cold start every unread message is "unseen"; only announce recent ones.
      return seen.length === 0
        ? (now - new Date(m.receivedAt).getTime()) < check.FRESH_MS
        : true;
    });

    await state.setResult(result);
    await state.setSeenIds(result.messages.map(m => m.id).concat(seen));

    await button.render({
      count: result.count,
      username: session.username,
      prefs,
      flash: fresh.length > 0
    });

    if (fresh.length) {
      await check.notify(fresh, prefs);
      // Settle back to the steady-state icon after the flash.
      setTimeout(() => button.render({
        count: result.count, username: session.username, prefs, flash: false
      }), 2500);
    }

    // Wake any open popup.
    api.runtime.sendMessage({method: 'update'}).catch(() => {});
  },

  async failed(e) {
    console.warn('[check] failed:', e.code, e.message);
    if (e.code === 'auth' || e.code === 'scope') {
      // The token is dead or wrong-scoped. Drop cached session state so a
      // corrected token re-bootstraps cleanly, and say so plainly.
      await api.storage.session.remove(['session', 'mailboxes']);
      await state.clearResult();
      await button.loggedOut(e.message);
      api.runtime.sendMessage({method: 'update'}).catch(() => {});
      return;
    }
    // Transient: keep the last known good count on screen rather than
    // flapping the badge to zero, but say so in the tooltip.
    const count = await state.count();
    if (count === state.UNAUTHENTICATED) {
      await button.loggedOut(e.message);
    }
    else {
      await button.label('Fastmail Checker\nLast check failed: ' + e.message);
    }
  },

  matchesVip(message, prefs) {
    if (!prefs.notifyVipOnly) {
      return true;
    }
    return prefs.vips.some(v => v && message.fromEmail.includes(v.toLowerCase()));
  },

  async notify(messages, prefs) {
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
      // The preview goes in `message` rather than `contextMessage`: Firefox
      // supports neither contextMessage nor silent, and a single multi-line
      // message renders correctly in both browsers.
      return check.createNotification(m.id, {
        title: m.fromName,
        message: preview ? m.subject + '\n' + preview : m.subject
      });
    }
    return check.createNotification(wanted[0].id, {
      title: wanted.length + ' new messages',
      message: wanted.slice(0, 4).map(m => m.fromName + ' - ' + m.subject).join('\n')
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
