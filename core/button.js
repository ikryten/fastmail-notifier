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

  async render({count, username, prefs, flash}) {
    if (count > 0) {
      await button.icon(flash ? 'new' : 'red');
      await button.badge(prefs.badge ? button.format(count) : '', prefs.badgeColor);
      await button.label(button.APP + '\n' + username + '\n' + count + ' unread');
    }
    else {
      await button.icon('gray');
      await button.badge('');
      await button.label(button.APP + '\n' + username + '\nNo unread mail');
    }
  }
};

self.button = button;
