'use strict';

/* Turning the folder names a user typed into mailbox ids.

   Pure data-in/data-out, so it is testable without a browser or a network.

   Names rather than ids are what gets persisted, deliberately. Mailbox ids are
   opaque and account-scoped: stored ids would silently stop matching the moment
   the token pointed at a different account, and there would be nothing in the
   options page to show why. Names survive that, read correctly in storage, and
   are the same thing the user types in the fallback text field -- so both entry
   paths write the identical format. */

const folders = {
  /* Case- and whitespace-insensitive, and tolerant of the separator being typed
     with spaces around it ("Receipts / Family"). */
  norm(s) {
    return String(s == null ? '' : s)
      .trim().toLowerCase()
      .split('/').map(p => p.trim()).filter(Boolean).join('/');
  },

  /* Resolve `wanted` (an array of names or paths) against the account's mailboxes.

     A full path always wins over a leaf name. A leaf name matches only when it is
     unique across the account -- two folders both called "Receipts" under
     different parents are genuinely ambiguous, and quietly picking one would put
     a wrong number on the badge with nothing to explain it. Such a name is
     reported as missing so the options page can say so.

     The inbox is dropped rather than reported: it is always counted, so listing
     it would double it. */
  resolve(all, wanted, inboxId) {
    const list = Array.isArray(all) ? all : [];
    const byPath = new Map();
    const byName = new Map();

    for (const m of list) {
      byPath.set(folders.norm(m.path || m.name), m);
      const key = folders.norm(m.name);
      // null marks "seen more than once", which is not the same as "never seen".
      byName.set(key, byName.has(key) ? null : m);
    }

    const matched = [];
    const missing = [];
    const seen = new Set();

    for (const raw of (Array.isArray(wanted) ? wanted : [])) {
      const key = folders.norm(raw);
      if (!key) {
        continue;
      }
      const hit = byPath.get(key) || byName.get(key) || null;
      if (!hit) {
        missing.push(String(raw).trim());
        continue;
      }
      if (hit.id === inboxId || seen.has(hit.id)) {
        continue;
      }
      seen.add(hit.id);
      matched.push({id: hit.id, name: hit.name, path: hit.path || hit.name});
    }
    return {matched, missing, ids: matched.map(m => m.id)};
  }
};

self.folders = folders;
