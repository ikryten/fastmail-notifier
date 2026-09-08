'use strict';

/* Entry point.

   Chrome loads this as an MV3 service worker and we pull the modules in with
   importScripts. Firefox MV3 uses a non-persistent event page instead, and its
   manifest `background.scripts` array has already loaded the same files by the
   time this runs -- hence the guard. One codebase, both browsers. */
if (typeof importScripts !== 'undefined') {
  self.importScripts(
    '/core/api.js',
    '/core/state.js',
    '/core/jmap.js',
    '/core/button.js',
    '/core/check.js',
    '/core/repeater.js'
  );
}

/* The popup only exists when it has something to show. With nothing unread,
   detaching it makes a click open the webmail instead of an empty window --
   the same trick ignotifier uses, and it is a genuinely nice bit of UX. */
async function syncPopup(count) {
  const popup = count > 0 ? '/data/popup/index.html' : '';
  try {
    await api.action.setPopup({popup});
  }
  catch (e) {
    console.warn('[worker] setPopup failed', e);
  }
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.count) {
    syncPopup(changes.count.newValue);
  }
});

async function openWebmail(emailId) {
  const session = await state.session();
  const url = jmap.webUrl(session, emailId);
  const prefs = await state.prefs();
  if (prefs.openInNewTab) {
    await api.tabs.create({url});
  }
  else {
    const [tab] = await api.tabs.query({active: true, currentWindow: true});
    await api.tabs.update(tab.id, {url});
  }
}

/* Only fires when the popup is detached, i.e. nothing unread or not connected. */
api.action.onClicked.addListener(async () => {
  const token = await state.token();
  if (!token) {
    return api.runtime.openOptionsPage();
  }
  await openWebmail();
});

api.notifications.onClicked.addListener(async id => {
  if (!id.startsWith('fmc:')) {
    return;
  }
  api.notifications.clear(id);
  await openWebmail(id.slice(4));
});

api.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== repeater.NAME) {
    return;
  }
  try {
    await check.execute('alarm');
  }
  finally {
    // Rearming must survive a failed check: this is the only path that keeps the
    // periodic schedule alive, so losing it once stops polling until some other
    // event happens to recreate an alarm.
    await repeater.build('after-check');
  }
});

api.runtime.onStartup.addListener(() => repeater.reset('startup'));
api.runtime.onInstalled.addListener(() => repeater.reset('installed'));

/* Coming back to the machine is a good moment to refresh. */
api.idle.setDetectionInterval(300);
api.idle.onStateChanged.addListener(s => {
  if (s === 'active') {
    repeater.reset('idle-exit');
  }
});

/* A changed token or period should take effect immediately, not next tick. */
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.period)) {
    repeater.reset('prefs-changed');
  }
});

/* --- message router (popup + options talk to us through this) --- */

const handlers = {
  async check() {
    await check.execute('manual');
    return {ok: true};
  },

  /* Used by the options page to validate a token before saving it.
     Returns the account it belongs to so the user gets confirmation. */
  async verify({token}) {
    const session = await jmap.bootstrap(token);
    return {ok: true, username: session.username, accountId: session.accountId};
  },

  /* The worker may have been torn down and restarted since the popup opened, so
     never assume the cached session survived -- check.connection re-bootstraps
     it if needed. */
  async connected() {
    const token = await state.token();
    if (!token) {
      throw jmap.err('auth', 'No API token set');
    }
    const {session, mailboxes} = await check.connection(token);
    return {token, session, mailboxes};
  },

  async body({id}) {
    const {token, session} = await handlers.connected();
    return {ok: true, email: await jmap.body(token, session, id)};
  },

  async markRead({ids}) {
    const {token, session} = await handlers.connected();
    await jmap.markRead(token, session, ids);
    await repeater.reset('mark-read');
    return {ok: true};
  },

  async trash({ids}) {
    const {token, session, mailboxes} = await handlers.connected();
    await jmap.trash(token, session, mailboxes, ids);
    await repeater.reset('trash');
    return {ok: true};
  },

  async silence({minutes}) {
    await state.setSilentUntil(Date.now() + minutes * 60 * 1000);
    return {ok: true};
  },

  async open({id}) {
    await openWebmail(id);
    return {ok: true};
  },

  async openUrl({url}) {
    // Links clicked inside the message iframe come through here, so the
    // sandboxed frame never gets to call api.tabs itself.
    if (/^https?:\/\//i.test(url)) {
      await api.tabs.create({url});
    }
    return {ok: true};
  }
};

api.runtime.onMessage.addListener((request, sender, respond) => {
  const method = request && request.method;
  // `connected` is an internal helper that happens to live on this object.
  const handler = method && method !== 'connected' ? handlers[method] : null;
  if (!handler) {
    return false;
  }
  handler(request)
    .then(respond)
    .catch(e => respond({ok: false, code: e.code || 'error', error: e.message}));
  return true; // keep the channel open for the async reply
});

/* Restore the visible state from storage on every worker start.

   The new-mail flash is undone by a setTimeout, which an MV3 service worker is
   free to kill before it runs; without this, a stranded flash icon would persist
   until the next successful poll. Rendering from persisted state on each wake
   makes that self-healing. A sub-30s alarm is not an option here -- Chrome clamps
   those in packaged extensions. */
(async () => {
  const count = await state.count();
  await syncPopup(count === state.UNAUTHENTICATED ? 0 : count);
  if (count === state.UNAUTHENTICATED) {
    return;   // leave the logged-out badge alone
  }
  const session = await state.session();
  await button.render({
    count,
    username: (session && session.username) || '',
    prefs: await state.prefs(),
    flash: false
  });
})();
repeater.build('worker-start');
