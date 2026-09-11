/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

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
    '/core/folders.js',
    '/core/jmap.js',
    '/core/button.js',
    '/core/check.js',
    '/core/repeater.js'
  );
}

/* The popup only exists when it has something to show. With nothing unread,
   detaching it makes a click open the webmail instead of an empty window --
   the same trick ignotifier uses, and it is a genuinely nice bit of UX.

   Keyed on the message list rather than the badge count. The two now normally
   agree, since the preview covers every watched folder, but they can still part
   company: the badge sums per-mailbox counters, so a message filed in two watched
   folders counts twice, and the message list is one page deep while the counters
   are not. The list is what the popup can actually show, so the list decides. */
async function syncPopup() {
  const popup = (await state.messages()).length ? '/data/popup/index.html' : '';
  try {
    await api.action.setPopup({popup});
  }
  catch (e) {
    console.warn('[worker] setPopup failed', e);
  }
}

api.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.messages) {
    syncPopup();
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

/* The toolbar button's right-click menu.

   "Check now" is there because the periodic poll is the only thing that moves the
   count on its own, and waiting out the rest of a period is the wrong answer when
   you know mail has arrived. It reaches the menu in both browsers: neither one
   offers anything like it, and unlike Options it has no built-in equivalent to
   duplicate.

   "Options" is Firefox only. Chrome already adds its own entry for any extension
   declaring options_ui, so adding ours there would sit directly beneath it saying
   the same thing. Firefox adds none, and this is the route to Options that still
   works when the popup is detached -- exactly the state a revoked token leaves you
   in.

   Rebuilt rather than created blind: Chrome persists menus across worker restarts
   and rejects a duplicate id, while a Firefox event page loses them each browser
   session. removeAll-then-create is idempotent in both. `contexts: ['action']` is
   the MV3 spelling and is supported by Firefox too ('browser_action' was the MV2
   name). */
async function buildMenu() {
  if (!api.contextMenus) {
    return;
  }
  try {
    await api.contextMenus.removeAll();
    await api.contextMenus.create({
      id: 'fmc-check',
      title: 'Check now',
      contexts: ['action']
    });
    if (IS_GECKO) {
      await api.contextMenus.create({
        id: 'fmc-options',
        title: 'Options',
        contexts: ['action']
      });
    }
  }
  catch (e) {
    console.warn('[worker] could not build the context menu', e);
  }
}

/* Guarded, because a build without the contextMenus permission has no such
   namespace at all, and an unguarded addListener here would throw at worker
   startup and take the whole extension down with it -- silently, since nothing
   after it would get to run. */
if (api.contextMenus) {
  api.contextMenus.onClicked.addListener(info => {
    if (info.menuItemId === 'fmc-check') {
      /* No re-entrancy worry: execute() coalesces, so clicking this during a poll
         queues one follow-up rather than starting a second. */
      check.execute('menu');
    }
    else if (info.menuItemId === 'fmc-options') {
      api.runtime.openOptionsPage();
    }
  });
}

/* Clicks on the toolbar button that the popup does not swallow.

   A left click reaches here only when the popup is detached -- nothing unread,
   or not connected -- because an attached popup consumes it.

   A middle click reaches here either way, and checks now. Firefox fires
   onClicked for it regardless of the popup, and reports which button was used,
   precisely so an extension can answer the two differently; that has been the
   behavior since Firefox 72, long before the 142 this add-on requires.

   Firefox only, like the Options entry above, and for a firmer reason: Chrome's
   onClicked carries no click data at all, so there is nothing to test, and it
   stays silent while a popup is attached -- which here is whenever there is
   unread mail, the very moment the shortcut is worth having. `info` is
   undefined there, so every Chrome click falls through to the left-click path
   below, exactly as before. */
api.action.onClicked.addListener(async (tab, info) => {
  if (info && info.button === 1) {
    /* No re-entrancy worry, for the same reason as the menu entry: execute()
       coalesces. The spinner on the button is the acknowledgement. */
    return check.execute('middle-click');
  }
  const token = await state.token();
  const count = await state.count();
  /* A stored token that Fastmail has since rejected is worse than no token at
     all: the popup is detached, so without this the click opens webmail and
     leaves no route back to Options short of the extensions page. */
  if (!token || count === state.UNAUTHENTICATED) {
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

api.runtime.onStartup.addListener(() => { buildMenu(); return repeater.reset('startup'); });
api.runtime.onInstalled.addListener(() => { buildMenu(); return repeater.reset('installed'); });

/* Coming back to the machine is a good moment to refresh. */
api.idle.setDetectionInterval(300);
api.idle.onStateChanged.addListener(s => {
  if (s === 'active') {
    repeater.reset('idle-exit');
  }
});

/* A changed token, period or watch set should take effect immediately, not next
   tick. Both folder keys are listened for: watchInbox moves on its own when the
   inbox row alone is toggled, and missing it would leave the change invisible
   until the next scheduled poll. Ticking several folders in a row is safe --
   check.execute coalesces, so a burst collapses into one extra poll. */
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.token || changes.period ||
                           changes.watchFolders || changes.watchInbox)) {
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
    const cred = await state.credentials();
    if (!cred.token) {
      throw jmap.err('auth', 'No API token set');
    }
    const {session, mailboxes} = await check.connection(cred);
    return {token: cred.token, session, mailboxes};
  },

  /* The account's mailboxes, so the options page can offer a folder picker
     instead of making the user type names. */
  async folders() {
    const {mailboxes} = await handlers.connected();
    return {ok: true, folders: mailboxes.all, inbox: mailboxes.inbox};
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
  await syncPopup();
  if (count === state.UNAUTHENTICATED) {
    return;   // leave the error badge alone
  }
  const session = await state.session();
  /* No session means nothing has been fetched since the browser started, so
     there is no state to restore and the button says so rather than claiming a
     connection it has not made yet. Session storage dying with the browser is
     what makes this the startup test; a worker torn down and restarted mid-
     session still finds one and repaints the real answer below. */
  if (!session) {
    return button.idle();
  }
  await button.render({
    count,
    breakdown: await state.breakdown(),
    username: (session && session.username) || '',
    prefs: await state.prefs(),
    flash: false
  });
})();
repeater.build('worker-start');
