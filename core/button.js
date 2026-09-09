/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict';

/* Toolbar button. Every api.action call lives here so the Firefox port and
   any future polyfill have exactly one place to land.

   Icon states:
     gray  - authenticated, nothing unread
     red   - unread mail waiting
     new   - brief flash when mail arrives (alternates with red)
     load  - spinner while a check is in flight
   The logged-out case reuses `gray` plus an amber "!" badge rather than a fifth
   icon set: it reads as "something needs your attention" without another asset. */

const button = {
  AMBER: '#f9ab00',

  /* The manifest is the single source of truth for the name, so renaming the
     extension is a one-line change there rather than a hunt through tooltips. */
  APP: api.runtime.getManifest().name,

  paths(name) {
    return {
      16: '/data/icons/' + name + '/16.png',
      32: '/data/icons/' + name + '/32.png',
      48: '/data/icons/' + name + '/48.png',
      128: '/data/icons/' + name + '/128.png'
    };
  },

  async icon(name) {
    try {
      await api.action.setIcon({path: button.paths(name)});
    }
    catch (e) {
      // Losing the icon is never worth breaking a poll over.
      console.warn('[button] setIcon failed', e);
    }
  },

  /* Cosmetic calls are individually guarded. The toolbar is the least important
     thing a poll does, and a rejected setter here used to propagate out of
     check.run() and abort the alarm rearm -- stopping polling entirely. */
  async badge(text, color) {
    try {
      await api.action.setBadgeText({text: String(text || '')});
      if (color) {
        await api.action.setBadgeBackgroundColor({color});
      }
    }
    catch (e) {
      console.warn('[button] badge failed', e);
      // An unusable colour should not also cost us the count.
      try {
        await api.action.setBadgeText({text: String(text || '')});
      }
      catch (ignored) {}
    }
  },

  async label(text) {
    try {
      await api.action.setTitle({title: text});
    }
    catch (e) {
      console.warn('[button] setTitle failed', e);
    }
  },

  /* A Chrome badge fits about four characters, so counts above 999 are
     compacted with no fraction digit: 33855 -> "34K", not "33.9K" (5 chars,
     which the badge silently truncates). */
  format(n) {
    if (n > 999) {
      return new Intl.NumberFormat(undefined, {
        notation: 'compact', maximumFractionDigits: 0
      }).format(n);
    }
    return String(n);
  },

  async loggedOut(reason) {
    await button.icon('gray');
    await button.badge('!', button.AMBER);
    await button.label(button.APP + '\n' + (reason || 'Not connected. Open options to add an API token.'));
  },

  async checking() {
    await button.icon('load');
  },

  /* Tooltip body, given the per-folder breakdown.

     One watched folder needs no breakdown -- it would only restate the total. The
     inbox alone therefore reads exactly as it always has ("3 unread"), while a
     single non-inbox folder names itself, because otherwise the number has no
     stated home. Two or more get a line each, since the badge then disagrees with
     any single folder and that looks like a bug unless it is explained. Folders
     sitting at zero are left out rather than padding it with lines saying nothing. */
  summary(count, breakdown) {
    const rows = breakdown || [];
    if (rows.length === 1) {
      return rows[0].inbox ? count + ' unread' : count + ' unread in ' + rows[0].name;
    }
    const nonzero = rows.filter(b => b.unread > 0);
    if (!nonzero.length) {
      return count + ' unread';
    }
    return [count + ' unread']
      .concat(nonzero.map(b => '  ' + b.unread + ' in ' + b.name)).join('\n');
  },

  /* Whether anything is being watched at all. Read from prefs rather than from the
     breakdown: the breakdown is empty on a cold worker start, before the first
     poll has run, and prefs express the user's intent, which is what the
     "nothing selected" message is actually about. */
  watching(prefs) {
    return prefs.watchInbox !== false || ((prefs.watchFolders || []).length > 0);
  },

  async render({count, breakdown, username, prefs, flash}) {
    if (count > 0) {
      await button.icon(flash ? 'new' : 'red');
      await button.badge(prefs.badge ? button.format(count) : '', prefs.badgeColor);
      await button.label(button.APP + '\n' + username + '\n' +
                         button.summary(count, breakdown));
      return;
    }
    await button.icon('gray');
    await button.badge('');
    /* Deliberately not the amber "!" -- that means the token is dead. This is a
       working connection watching nothing, which is a choice the user made and can
       undo, so it gets the ordinary idle icon and an explanatory tooltip. */
    await button.label(button.APP + '\n' + username + '\n' + (button.watching(prefs)
      ? 'No unread mail'
      : 'No folders are being watched. Open options to choose some.'));
  }
};

self.button = button;
