'use strict';

/* Scheduling. Uses one-shot api.alarms re-armed after every fire rather than a
   periodic alarm: api.alarms clamps periodInMinutes to a 30s floor, and
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

    const existing = await api.alarms.get(repeater.NAME);
    if (existing && existing.scheduledTime <= when) {
      return console.log('[repeater] keeping earlier alarm, ignoring', reason);
    }
    await api.alarms.create(repeater.NAME, {when});
    console.log('[repeater] scheduled in', Math.round(delay / 1000) + 's', 'for', reason);
  },

  /* Check now, then resume the normal cadence.

     Deliberately not "schedule an alarm a few hundred ms out": Chrome clamps
     alarms to a 30 second floor in packaged extensions, and `when` values nearer
     than that are honoured silently late. Unpacked extensions are exempt, so that
     delay is invisible during development and would only appear once packaged --
     turning "the badge updates as soon as you mark something read" into a
     half-minute wait. Immediate work therefore runs in-process, and alarms carry
     only the durable periodic schedule. */
  async reset(reason) {
    await api.alarms.clear(repeater.NAME);
    console.log('[repeater] immediate check for', reason);
    await check.execute(reason);
    await repeater.build(reason + '.rearm');
  }
};

self.repeater = repeater;
