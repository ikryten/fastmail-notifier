'use strict';

const $ = id => document.getElementById(id);

const view = {
  messages: [],
  index: 0,
  session: null,
  bodies: new Map(),   // emailId -> sanitized srcdoc, for the life of this popup
  busy: false
};

/* ---------- rendering ---------- */

function relative(iso) {
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then.getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + ' min ago';
  if (mins < 60 * 24) return Math.round(mins / 60) + ' h ago';
  return then.toLocaleDateString(undefined, {month: 'short', day: 'numeric'});
}

function overlay(text, bad) {
  const el = $('overlay');
  el.textContent = text || '';
  el.classList.toggle('bad', Boolean(bad));
  if (text) {
    el.setAttribute('data-show', '');
  }
  else {
    el.removeAttribute('data-show');
  }
}

function paintChrome() {
  const n = view.messages.length;
  $('counter').textContent = n ? (view.index + 1) + ' of ' + n : '';
  $('prev').disabled = view.index <= 0;
  $('next').disabled = view.index >= n - 1;
  for (const id of ['read', 'trash']) {
    $(id).disabled = !n;
  }
}

async function paint() {
  const m = view.messages[view.index];
  paintChrome();

  if (!m) {
    $('subject').textContent = 'No unread mail';
    $('from').textContent = '';
    $('date').textContent = '';
    $('body').removeAttribute('srcdoc');
    overlay('Inbox zero.');
    return;
  }

  $('subject').textContent = m.subject;
  $('from').textContent = m.fromEmail ? m.fromName + ' <' + m.fromEmail + '>' : m.fromName;
  $('date').textContent = relative(m.receivedAt);

  // Show the JMAP preview immediately, then swap in the real body when it lands.
  if (view.bodies.has(m.id)) {
    $('body').srcdoc = view.bodies.get(m.id);
    overlay('');
    return;
  }

  $('body').removeAttribute('srcdoc');
  overlay(m.preview || 'Loading…');

  const wanted = m.id;
  try {
    const doc = await buildBody(m.id);
    if (view.messages[view.index] && view.messages[view.index].id === wanted) {
      view.bodies.set(wanted, doc);
      $('body').srcdoc = doc;
      overlay('');
    }
  }
  catch (e) {
    if (view.messages[view.index] && view.messages[view.index].id === wanted) {
      overlay(e.message || 'Could not load this message.', true);
    }
  }
}

/* ---------- message body ---------- */

function pickBody(email) {
  const bv = email.bodyValues || {};
  const html = (email.htmlBody || []).find(p => bv[p.partId]);
  if (html) {
    return {type: 'html', value: bv[html.partId].value};
  }
  const text = (email.textBody || []).find(p => bv[p.partId]);
  if (text) {
    return {type: 'text', value: bv[text.partId].value};
  }
  return {type: 'text', value: '(no readable body)'};
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
}

/* The iframe is already unscriptable (no allow-scripts), so this is defence in
   depth rather than the only line: strip active content and javascript: URLs so
   nothing dangerous survives even if the sandbox attribute is ever loosened. */
function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');

  doc.querySelectorAll(
    'script, iframe, object, embed, form, input, button, textarea, select, base, meta, link'
  ).forEach(n => n.remove());

  for (const el of doc.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      }
      else if (/^(href|src|action|background|formaction)$/.test(name) &&
               /^\s*(javascript|vbscript|data:text\/html)/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return doc;
}

function downloadUrl(session, part) {
  return session.downloadUrl
    .replace('{accountId}', encodeURIComponent(session.accountId))
    .replace('{blobId}', encodeURIComponent(part.blobId))
    .replace('{name}', encodeURIComponent(part.name || 'inline'))
    .replace('{type}', encodeURIComponent(part.type || 'application/octet-stream'));
}

const MAX_INLINE = 2 * 1024 * 1024;

/* cid: images live behind Fastmail's downloadUrl, which needs the Bearer header.
   An <img> inside the sandboxed frame cannot send one, and blob: URLs are
   origin-scoped so the opaque-origin frame cannot read ours either -- which
   leaves data: URLs as the way to get inline images in front of the user. */
async function inlineImages(doc, email) {
  const byCid = new Map();
  for (const a of email.attachments || []) {
    if (a.cid && a.blobId) {
      byCid.set(a.cid, a);
    }
  }
  if (!byCid.size) {
    return;
  }

  const token = await state.token();
  const imgs = [...doc.querySelectorAll('img[src^="cid:"]')];

  await Promise.all(imgs.map(async img => {
    const cid = img.getAttribute('src').slice(4).replace(/^<|>$/g, '');
    const part = byCid.get(cid);
    if (!part) {
      return img.removeAttribute('src');
    }
    if (part.size > MAX_INLINE) {
      img.removeAttribute('src');
      img.setAttribute('alt', '[inline image too large to show]');
      return;
    }
    try {
      const r = await fetch(downloadUrl(view.session, part), {
        headers: {Authorization: 'Bearer ' + token}, cache: 'no-store'
      });
      if (!r.ok) {
        throw new Error('HTTP ' + r.status);
      }
      const blob = await r.blob();
      img.setAttribute('src', await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      }));
    }
    catch (e) {
      img.removeAttribute('src');
      img.setAttribute('alt', '[inline image unavailable]');
    }
  }));
}

const FRAME_CSS = `
  html { -webkit-text-size-adjust: 100%; }
  body { margin: 0; padding: 14px 16px; background: #fff; color: #1f1f1f;
         font: 13px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         overflow-wrap: break-word; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; overflow-wrap: break-word; }
  blockquote { margin: 0 0 0 12px; padding-left: 10px; border-left: 2px solid #dadce0; color: #5f6368; }
  a { color: #1a73e8; }
`;

async function buildBody(id) {
  const res = await chrome.runtime.sendMessage({method: 'body', id});
  if (!res || !res.ok) {
    throw new Error((res && res.error) || 'Could not load message');
  }
  const email = res.email;
  if (!email) {
    throw new Error('Message not found');
  }

  const picked = pickBody(email);
  let inner;

  if (picked.type === 'html') {
    const doc = sanitize(picked.value);
    await inlineImages(doc, email);
    inner = doc.body ? doc.body.innerHTML : '';
  }
  else {
    inner = '<pre>' + escapeHtml(picked.value) + '</pre>';
  }

  // base target=_blank plus allow-popups is what makes links work at all:
  // with no allow-scripts we cannot intercept clicks inside the frame.
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
         '<base target="_blank"><style>' + FRAME_CSS + '</style></head>' +
         '<body>' + inner + '</body></html>';
}

/* ---------- actions ---------- */

function move(delta) {
  const next = view.index + delta;
  if (next >= 0 && next < view.messages.length) {
    view.index = next;
    paint();
  }
}

/* Drop the message locally and move on, rather than waiting for the next poll.
   The worker re-polls straight after the write, so the badge follows within
   about half a second and reconciles anything we got wrong. */
function dropCurrent() {
  view.messages.splice(view.index, 1);
  if (view.index >= view.messages.length) {
    view.index = Math.max(0, view.messages.length - 1);
  }
  paint();
}

async function act(button, method) {
  const m = view.messages[view.index];
  if (!m || view.busy) {
    return;
  }
  view.busy = true;
  button.setAttribute('data-busy', '');
  try {
    const res = await chrome.runtime.sendMessage({method, ids: [m.id]});
    if (!res || !res.ok) {
      throw new Error((res && res.error) || 'Action failed');
    }
    view.bodies.delete(m.id);
    dropCurrent();
  }
  catch (e) {
    overlay(e.message, true);
  }
  finally {
    view.busy = false;
    button.removeAttribute('data-busy');
  }
}

$('prev').addEventListener('click', () => move(-1));
$('next').addEventListener('click', () => move(1));
$('read').addEventListener('click', e => act(e.currentTarget, 'markRead'));
$('trash').addEventListener('click', e => act(e.currentTarget, 'trash'));
$('open').addEventListener('click', () => {
  chrome.runtime.sendMessage({method: 'open'});
  window.close();
});
$('settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
  window.close();
});
$('refresh').addEventListener('click', () => chrome.runtime.sendMessage({method: 'check'}));

document.addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') return move(-1);
  if (e.key === 'ArrowRight') return move(1);
  if (e.key === 'I' && e.shiftKey) return $('read').click();
  if (e.key === '#' || e.key === 'Delete') return $('trash').click();
});

/* ---------- wiring ---------- */

async function load() {
  view.session = await state.session();
  const messages = await state.messages();

  // Keep our position if the poll simply refreshed the same head of the list.
  const current = view.messages[view.index];
  view.messages = messages;
  if (current) {
    const at = messages.findIndex(m => m.id === current.id);
    view.index = at === -1 ? 0 : at;
  }

  $('account').textContent = view.session ? view.session.username : '';
  $('account').title = $('account').textContent;
  await paint();
}

chrome.runtime.onMessage.addListener(request => {
  if (request && request.method === 'update') {
    load();
  }
});

load();
