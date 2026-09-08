'use strict';

/* Entry point.

   Chrome loads this as an MV3 service worker and we pull the modules in with
   importScripts. Firefox MV3 uses a non-persistent event page instead, and its
   manifest `background.scripts` array has already loaded the same files by the
   time this runs -- hence the guard. One codebase, both browsers. */
if (typeof importScripts !== 'undefined') {
  self.importScripts(
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
    await chrome.action.setPopup({popup});
  }
  catch (e) {
    console.warn('[worker] setPopup failed', e);
  }
}

chrome.storage.session.onChanged.addListener(changes => {
  if (changes.count) {
    syncPopup(changes.count.newValue);
  }
});

async function openWebmail(emailId) {
  const session = await state.session();
  const url = jmap.webUrl(session, emailId);
  const prefs = await state.prefs();
  if (prefs.openInNewTab) {
    await chrome.tabs.create({url});
  }
  else {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    await chrome.tabs.update(tab.id, {url});
  }
}

/* Only fires when the popup is detached, i.e. nothing unread or not connected. */
chrome.action.onClicked.addListener(async () => {
  const token = await state.token();
  if (!token) {
    return chrome.runtime.openOptionsPage();
  }
  await openWebmail();
});

chrome.notifications.onClicked.addListener(async id => {
  if (!id.startsWith('fmc:')) {
    return;
  }
  chrome.notifications.clear(id);
  await openWebmail(id.slice(4));
});

chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== repeater.NAME) {
    return;
  }
  await check.execute('alarm');
  await repeater.build('after-check');
});

chrome.runtime.onStartup.addListener(() => repeater.reset('startup', 2000));
chrome.runtime.onInstalled.addListener(() => repeater.reset('installed', 1000));

/* Coming back to the machine is a good moment to refresh. */
chrome.idle.setDetectionInterval(300);
chrome.idle.onStateChanged.addListener(s => {
  if (s === 'active') {
    repeater.reset('idle-exit', 1000);
  }
});

/* A changed token or period should take effect immediately, not next tick. */
chrome.storage.local.onChanged.addListener(changes => {
  if (changes.token || changes.period) {
    repeater.reset('prefs-changed', 300);
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
    await repeater.reset('mark-read', 400);
    return {ok: true};
  },

  async trash({ids}) {
    const {token, session, mailboxes} = await handlers.connected();
    await jmap.trash(token, session, mailboxes, ids);
    await repeater.reset('trash', 400);
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
    // sandboxed frame never gets to call chrome.tabs itself.
    if (/^https?:\/\//i.test(url)) {
      await chrome.tabs.create({url});
    }
    return {ok: true};
  }
};

chrome.runtime.onMessage.addListener((request, sender, respond) => {
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

// The worker may have been woken for something unrelated, so restore the
// popup from the last known count rather than assuming zero.
state.count().then(c => syncPopup(c === state.UNAUTHENTICATED ? 0 : c));
repeater.build('worker-start');
