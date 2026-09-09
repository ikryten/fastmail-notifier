/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict';

const $ = id => document.getElementById(id);

const FIELDS = {
  period: 'value',
  badge: 'checked',
  badgeColor: 'value',
  notifications: 'checked',
  notifyVipOnly: 'checked',
  loadRemoteImages: 'checked',
  openInNewTab: 'checked'
};

// Guards against a second submission while the first is still in flight.
let verifying = false;

function say(el, text, cls) {
  el.textContent = text;
  el.className = 'status' + (cls ? ' ' + cls : '');
}

function flashSaved() {
  $('saved').textContent = 'Saved';
  clearTimeout(flashSaved.t);
  flashSaved.t = setTimeout(() => ($('saved').textContent = ''), 1400);
}

/* The token is never rendered back into an input. Showing the last four
   characters is enough to tell two tokens apart without putting the secret
   on screen where a screenshot or a shoulder would catch it. */
function mask(token) {
  return '•'.repeat(12) + token.slice(-4);
}

async function paintConnection() {
  const token = await state.token();
  const session = await state.session();

  $('token-entry').hidden = Boolean(token);
  $('token-set').hidden = !token;
  $('revoke-hint').hidden = !token;

  if (token) {
    $('token-mask').textContent = mask(token);
    $('token-who').textContent = session ? session.username : '';
    if (session) {
      say($('conn-status'), 'Connected as ' + session.username, 'ok');
    }
    else {
      say($('conn-status'), '');
    }
  }
  else {
    say($('conn-status'), '');
  }
}


/* --- folders to watch ---

   Two entry paths, one stored format. The picker is what you get when the
   account's mailbox list can be fetched; the comma-separated field is the
   fallback for when it cannot -- no token yet, or Fastmail unreachable.

   Two keys, though: `watchInbox` is a boolean of its own because JMAP identifies
   the inbox by role and mailbox names are localized, so "Inbox" is not a portable
   way to name it in a list of names. The Inbox tick is therefore rendered in the
   picker but persisted separately, and it stays on screen even in the fallback
   branch -- otherwise a user whose token has died could not turn it back on. */

let folderMissing = [];   // saved names that matched nothing at the last render
let folderNote = '';      // why the picker is unavailable, if it is

function folderRow({path, label, checked, tag, bad, inbox, missing}) {
  // The checkbox lives inside its label, so the whole row is clickable without
  // having to mint an id for every folder.
  const row = document.createElement('label');
  row.className = 'check';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = Boolean(checked);
  cb.dataset.path = path;
  if (inbox) {
    cb.dataset.inbox = '1';
  }
  if (missing) {
    // Ticked, but resolving to no mailbox -- so it watches nothing.
    cb.dataset.missing = '1';
  }
  cb.addEventListener('change', persistFolders);
  row.appendChild(cb);

  const name = document.createElement('span');
  name.textContent = label;
  row.appendChild(name);

  if (tag) {
    const t = document.createElement('span');
    t.className = 'tag' + (bad ? ' bad' : '');
    t.textContent = tag;
    row.appendChild(t);
  }
  return row;
}

const folderBoxes = () =>
  Array.from($('folder-list').querySelectorAll('input[type=checkbox]'));

/* Watching nothing at all is allowed -- it is a legitimate way to mute the
   extension without removing the token -- but it must never be silent, because a
   gray icon and an empty badge look exactly like "you have no mail". */
function watchingNothing() {
  const boxes = folderBoxes();
  if (!boxes.length) {
    return false;
  }
  /* A ticked row that matches no mailbox contributes nothing, so it must not
     count as watching something -- otherwise a user whose only saved folder was
     deleted sees a silent zero badge and no warning. */
  if (boxes.some(cb => cb.checked && !cb.dataset.missing)) {
    return false;
  }
  // In the fallback branch the folders live in the text field, not in the picker.
  if (!$('folder-fallback').hidden) {
    return !typedFolders().length;
  }
  return true;
}

function paintFolderStatus() {
  const parts = [];
  if (folderNote) {
    parts.push(folderNote);
  }
  if (folderMissing.length) {
    parts.push(folderMissing.length +
      (folderMissing.length === 1 ? ' saved folder no longer matches' : ' saved folders no longer match') +
      ' anything in this account. Untick to remove.');
  }
  if (watchingNothing()) {
    parts.push('Nothing is being watched: the badge will stay empty and no ' +
               'notifications will arrive. Tick at least one folder.');
  }
  say($('folder-status'), parts.join(' '), parts.length ? 'bad' : '');
}

const typedFolders = () =>
  $('watchFolders').value.split(',').map(s => s.trim()).filter(Boolean);

async function persistFolders() {
  const boxes = folderBoxes();
  const inbox = boxes.find(cb => cb.dataset.inbox);
  /* In fallback mode the picker holds only the Inbox row and the folders live in
     the text field, so rebuilding the list from checkboxes would write an empty
     array -- silently deleting the saved folders while the field still showed
     them. The visible field is the source of truth there. */
  const inFallback = !$('folder-fallback').hidden;
  /* Both keys in a single set, so one storage change fires one re-poll. Two calls
     would fire two; check.execute would coalesce them, but there is no reason to
     lean on that. */
  await state.setPrefs({
    watchInbox: inbox ? inbox.checked : true,
    watchFolders: inFallback
      ? typedFolders()
      : boxes.filter(cb => cb.checked && !cb.dataset.inbox).map(cb => cb.dataset.path)
  });
  flashSaved();
  paintFolderStatus();
}

async function renderFolders() {
  const prefs = await state.prefs();
  const wanted = prefs.watchFolders || [];
  const list = $('folder-list');
  const inboxRow = () => folderRow({
    path: '', label: 'Inbox', checked: prefs.watchInbox !== false, inbox: true
  });

  let res;
  try {
    res = await api.runtime.sendMessage({method: 'folders'});
  }
  catch (e) {
    res = {ok: false, error: (e && e.message) || 'could not reach the extension'};
  }

  list.textContent = '';

  if (!res || !res.ok || !Array.isArray(res.folders)) {
    folderMissing = [];
    folderNote = res && res.error
      ? 'Could not load your folder list (' + res.error + '). Type folder names instead.'
      : 'Add a token above to load your folder list.';
    // The Inbox tick is not in the text field, so it has to stay on screen here.
    list.appendChild(inboxRow());
    list.hidden = false;
    $('folder-fallback').hidden = false;
    $('watchFolders').value = wanted.join(', ');
    paintFolderStatus();
    return;
  }

  const {matched, missing} = folders.resolve(res.folders, wanted, res.inbox);
  const chosen = new Set(matched.map(m => m.id));
  const label = f => f.path || f.name;

  const inbox = res.folders.find(f => f.id === res.inbox);
  list.appendChild(folderRow({
    path: '', label: (inbox && inbox.name) || 'Inbox',
    checked: prefs.watchInbox !== false, inbox: true
  }));

  const rest = res.folders.filter(f => f.id !== res.inbox)
    .sort((a, b) => label(a).localeCompare(label(b), undefined, {sensitivity: 'base'}));
  for (const f of rest) {
    list.appendChild(folderRow({path: label(f), label: label(f), checked: chosen.has(f.id)}));
  }

  /* Saved names that match nothing any more: a folder renamed or deleted in
     Fastmail, or a leaf name that has become ambiguous. Shown ticked rather than
     quietly dropped, so a setting the user made stays visible and is removed
     deliberately. */
  for (const name of missing) {
    list.appendChild(folderRow({
      path: name, label: name, checked: true, tag: 'not found', bad: true, missing: true
    }));
  }

  folderMissing = missing;
  folderNote = '';
  list.hidden = false;
  $('folder-fallback').hidden = true;
  paintFolderStatus();
}

$('watchFolders').addEventListener('change', async () => {
  await state.setPrefs({watchFolders: typedFolders()});
  flashSaved();
  paintFolderStatus();
});

async function load() {
  const prefs = await state.prefs();
  for (const [id, prop] of Object.entries(FIELDS)) {
    $(id)[prop] = prefs[id];
  }
  $('vips').value = (prefs.vips || []).join('\n');
  await paintConnection();
  await renderFolders();
}

async function persist() {
  const o = {};
  for (const [id, prop] of Object.entries(FIELDS)) {
    o[id] = $(id)[prop];
  }
  o.period = Math.max(30, Math.min(3600, Number(o.period) || 60));
  $('period').value = o.period;

  // An unusable color is rejected by the browser, and that rejection used to
  // propagate out of the poll and stop it rescheduling. Never store one.
  if (!/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(String(o.badgeColor).trim())) {
    o.badgeColor = state.DEFAULTS.badgeColor;
  }
  else {
    o.badgeColor = String(o.badgeColor).trim();
  }
  $('badgeColor').value = o.badgeColor;
  o.vips = $('vips').value.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean);
  await state.setPrefs(o);
  flashSaved();
}

$('save').addEventListener('click', async () => {
  if (verifying) {
    return;
  }
  const token = $('token').value.trim();
  if (!token) {
    return say($('conn-status'), 'Paste a token first.', 'bad');
  }

  verifying = true;
  $('save').disabled = true;
  say($('conn-status'), 'Checking with Fastmail…');

  /* The button is re-enabled in `finally`. sendMessage can reject outright -- no
     receiver, worker torn down mid-flight -- which is distinct from a well-formed
     {ok: false} reply, and used to leave the button disabled for good with nothing
     on screen to explain why. */
  try {
    // Verified in the worker, which holds the host permissions, before we store it.
    // A token that does not work should never make it into storage.
    const res = await api.runtime.sendMessage({method: 'verify', token});

    if (!res || !res.ok) {
      return say($('conn-status'), (res && res.error) || 'Could not reach Fastmail.', 'bad');
    }

    await state.setToken(token);
    $('token').value = '';
    await paintConnection();
    say($('conn-status'), 'Connected as ' + res.username, 'ok');
    api.runtime.sendMessage({method: 'check'});
    // A working token is what the folder picker was waiting for.
    await renderFolders();
  }
  catch (e) {
    say($('conn-status'), 'Could not reach the extension: ' +
        ((e && e.message) || 'unknown error'), 'bad');
  }
  finally {
    verifying = false;
    $('save').disabled = false;
  }
});

$('replace').addEventListener('click', async () => {
  await state.setToken('');
  await paintConnection();
  $('token').focus();
});

$('token').addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    $('save').click();
  }
});

for (const id of Object.keys(FIELDS)) {
  $(id).addEventListener('change', persist);
}
$('vips').addEventListener('change', persist);

// The worker writes the session once it has bootstrapped, so reflect that.
api.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.session) {
    paintConnection();
  }
});

load();
