'use strict';

/* Scheduling. Uses one-shot chrome.alarms re-armed after every fire rather than a
   periodic alarm: chrome.alarms clamps periodInMinutes to a 30s floor, and
   re-arming ourselves keeps the actual cadence under our control. setTimeout is
   not an option -- it does not survive service-worker teardown. */

const repeater = {
  NAME: 'fmc-check',
  MIN_PERIOD: 30,

  async period() {
    const prefs = await state.prefs();
    return Math.max(repeater.MIN_PERIOD, Number(prefs.period) || 60);
  },

  /* Schedule the next check. Will not push an already-pending check further out,
     so a burst of triggers cannot starve the poll. */
  async build(reason, delayMs) {
    const delay = typeof delayMs === 'number' ? delayMs : (await repeater.period()) * 1000;
    const when = Date.now() + delay;

    const existing = await chrome.alarms.get(repeater.NAME);
    if (existing && existing.scheduledTime <= when) {
      return console.log('[repeater] keeping earlier alarm, ignoring', reason);
    }
    await chrome.alarms.create(repeater.NAME, {when});
    console.log('[repeater] scheduled in', Math.round(delay / 1000) + 's', 'for', reason);
  },

  /* Force a check now, then resume the normal cadence. */
  async reset(reason, delayMs) {
    await chrome.alarms.clear(repeater.NAME);
    await chrome.alarms.create(repeater.NAME, {when: Date.now() + (delayMs || 500)});
    console.log('[repeater] reset for', reason);
  }
};

self.repeater = repeater;
