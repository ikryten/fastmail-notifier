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


/* --- folders counted on the badge ---

   Two entry paths, one stored format. The picker is what you get when the
   account's mailbox list can be fetched; the comma-separated field is the
   fallback for when it cannot -- no token yet, or Fastmail unreachable. Both
   write the same array of names, so moving between them loses nothing. */

function folderRow({path, label, checked, tag, bad, disabled}) {
  // The checkbox lives inside its label, so the whole row is clickable without
  // having to mint an id for every folder.
  const row = document.createElement('label');
  row.className = 'check';

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = Boolean(checked);
  cb.disabled = Boolean(disabled);
  cb.dataset.path = path;
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

async function persistFolders() {
  const boxes = Array.from($('folder-list').querySelectorAll('input[type=checkbox]'));
  // The Inbox row is disabled, and excluded here for the same reason it is shown
  // at all: it is always counted, so storing it would double it.
  await state.setPrefs({
    watchFolders: boxes.filter(cb => cb.checked && !cb.disabled).map(cb => cb.dataset.path)
  });
  flashSaved();
}

async function renderFolders() {
  const prefs = await state.prefs();
  const wanted = prefs.watchFolders || [];
  const list = $('folder-list');

  let res;
  try {
    res = await api.runtime.sendMessage({method: 'folders'});
  }
  catch (e) {
    res = {ok: false, error: (e && e.message) || 'could not reach the extension'};
  }

  if (!res || !res.ok || !Array.isArray(res.folders)) {
    list.hidden = true;
    list.textContent = '';
    $('folder-fallback').hidden = false;
    $('watchFolders').value = wanted.join(', ');
    say($('folder-status'),
        res && res.error
          ? 'Could not load your folder list (' + res.error + '). Type folder names instead.'
          : 'Add a token above to load your folder list.',
        res && res.error ? 'bad' : '');
    return;
  }

  const {matched, missing} = folders.resolve(res.folders, wanted, res.inbox);
  const chosen = new Set(matched.map(m => m.id));
  const label = f => f.path || f.name;

  list.textContent = '';
  const inbox = res.folders.find(f => f.id === res.inbox);
  list.appendChild(folderRow({
    path: '', label: (inbox && inbox.name) || 'Inbox',
    checked: true, disabled: true, tag: 'always counted'
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
    list.appendChild(folderRow({path: name, label: name, checked: true, tag: 'not found', bad: true}));
  }

  list.hidden = false;
  $('folder-fallback').hidden = true;
  say($('folder-status'), missing.length
    ? missing.length + (missing.length === 1 ? ' saved folder no longer matches' : ' saved folders no longer match') +
      ' anything in this account. Untick to remove.'
    : '', missing.length ? 'bad' : '');
}

$('watchFolders').addEventListener('change', async () => {
  await state.setPrefs({
    watchFolders: $('watchFolders').value.split(',').map(s => s.trim()).filter(Boolean)
  });
  flashSaved();
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

  // An unusable colour is rejected by the browser, and that rejection used to
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
