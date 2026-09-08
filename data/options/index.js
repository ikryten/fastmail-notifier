'use strict';

const $ = id => document.getElementById(id);

const FIELDS = {
  period: 'value',
  badge: 'checked',
  badgeColor: 'value',
  notifications: 'checked',
  notifyVipOnly: 'checked',
  openInNewTab: 'checked'
};

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

async function load() {
  const prefs = await state.prefs();
  for (const [id, prop] of Object.entries(FIELDS)) {
    $(id)[prop] = prefs[id];
  }
  $('vips').value = (prefs.vips || []).join('\n');
  await paintConnection();
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
  const token = $('token').value.trim();
  if (!token) {
    return say($('conn-status'), 'Paste a token first.', 'bad');
  }

  $('save').disabled = true;
  say($('conn-status'), 'Checking with Fastmail…');

  // Verified in the worker, which holds the host permissions, before we store it.
  // A token that does not work should never make it into storage.
  const res = await api.runtime.sendMessage({method: 'verify', token});

  $('save').disabled = false;

  if (!res || !res.ok) {
    return say($('conn-status'), (res && res.error) || 'Could not reach Fastmail.', 'bad');
  }

  await state.setToken(token);
  $('token').value = '';
  await paintConnection();
  say($('conn-status'), 'Connected as ' + res.username, 'ok');
  api.runtime.sendMessage({method: 'check'});
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
