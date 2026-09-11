/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

'use strict';

/* Toolbar button. Every api.action call lives here so the Firefox port and
   any future polyfill have exactly one place to land.

   Icon states, one directory of PNGs each under data/icons:
     idle       - the browser has started and we have not fetched anything yet
     checking   - a check is in flight
     connected  - a working connection, whatever the count; the badge carries that
     newmail    - FLASH_MS after mail arrives, then back to connected
     error      - no token, a rejected token, or a check that failed
   How many are unread is the badge's job, not the icon's, so `connected` covers
   an empty inbox and a full one alike. `error` carries an amber "!" badge when
   the cause is the token, which is the one the user can do something about. */

const button = {
  AMBER: '#f9ab00',

  /* The spinner's two timings, and the deadline it is currently holding until.

     A warm steady-state poll is a single request and finishes faster than the eye
     registers. Shown and withdrawn inside that window the spinner reads as a
     glitch rather than as work, so it is governed at both ends: DELAY_MS before a
     background check may show it at all, and HOLD_MS that it stays up for once it
     does. A check the user asked for skips the delay, because on a quiet account
     the spinner is the only sign that anything happened, but it keeps the floor.

     heldUntil is module scope for the same reason as check.running: it need only
     hold for the life of one worker invocation, and a value surviving a teardown
     would be worse than none. */
  DELAY_MS: 500,
  HOLD_MS: 400,
  heldUntil: 0,

  /* How long a new-mail arrival keeps the newmail icon before settling back to
     connected. Long enough to catch the eye from across the desk, short enough
     that the button is not lying about the current state a moment later. */
  FLASH_MS: 3000,

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
    /* Every repaint enters here first, and render() awaits it before touching the
       badge or the tooltip, so waiting here holds the whole repaint rather than
       just the picture -- and it covers the failure paths too, where the
       acknowledgement is worth at least as much. */
    const left = button.heldUntil - Date.now();
    if (left > 0) {
      await new Promise(r => setTimeout(r, left));
    }
    button.heldUntil = 0;
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
      // An unusable color should not also cost us the count.
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
    await button.icon('error');
    await button.badge('!', button.AMBER);
    await button.label(button.APP + '\n' + (reason || 'Not connected. Open options to add an API token.'));
  },

  /* Put the spinner up now. Whether to call this at once or only after DELAY_MS
     is check.run's decision, since the flag saying a check is still in flight
     lives there.

     Clearing the hold first stops icon() waiting on a previous one and delaying
     the very state it is about to be asked to show; arming it afterwards starts
     the floor from when the spinner is actually on screen rather than from when
     we asked for it. */
  async checking() {
    button.heldUntil = 0;
    await button.icon('checking');
    button.heldUntil = Date.now() + button.HOLD_MS;
  },

  /* Nothing fetched yet in this browser session. Distinct from `connected` with
     an empty inbox, which is a real answer rather than the absence of one. */
  async idle() {
    await button.icon('idle');
    await button.badge('');
    await button.label(button.APP + '\nStarting up...');
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

  /* `error` paints the failed icon while leaving the count and the breakdown
     alone: a check that could not complete says nothing about how much mail is
     waiting, and blanking the badge would throw away the last good answer. The
     caller writes the tooltip afterwards to say what went wrong. */
  async render({count, breakdown, username, prefs, flash, error}) {
    if (count > 0) {
      await button.icon(error ? 'error' : (flash ? 'newmail' : 'connected'));
      await button.badge(prefs.badge ? button.format(count) : '', prefs.badgeColor);
      await button.label(button.APP + '\n' + username + '\n' +
                         button.summary(count, breakdown));
      return;
    }
    await button.icon(error ? 'error' : 'connected');
    await button.badge('');
    /* Deliberately not the amber "!" -- that means the token is dead. This is a
       working connection watching nothing, which is a choice the user made and can
       undo, so it gets the ordinary connected icon and an explanatory tooltip. */
    await button.label(button.APP + '\n' + username + '\n' + (button.watching(prefs)
      ? 'No unread mail'
      : 'No folders are being watched. Open options to choose some.'));
  }
};

self.button = button;
