import type { Db } from '../../database/db.js';
import { botApi } from '../../support/helpers/telegram.js';
import { reportTimeZone } from '../../support/helpers/updates.js';
import { addDays, dayOf, isLastDayOfMonth, isSaturday } from './periods.js';
import { publish } from './publish.js';
import { closeForgotten } from './shifts.js';
import { getPost, listStaff, openShift, shiftsBetween } from './store.js';
import { durationEn, hm } from './words.js';

// The evening job (18:00 UTC = 23:00 in Tashkent):
//   1. a shift open for more than 16 hours was forgotten: it is closed and its day reported;
//      a shift still open is a reminder in the person's private chat;
//   2. a day with a finished shift but no report (sending failed earlier) is reported now;
//   3. on Saturday the week is reported, on the last day of the month the month.
// Every step is safe to run twice: report_posts lets each report out once.

const FORGOTTEN_MS = 16 * 3_600_000;

export async function runEvening(db: Db, now = new Date()): Promise<Record<string, unknown>[]> {
  const tz = await reportTimeZone(db);
  const today = dayOf(now, tz);
  const results: Record<string, unknown>[] = [];
  for (const staff of await listStaff(db)) {
    const r: Record<string, unknown> = { staff: staff.id };
    try {
      const open = await openShift(db, staff.id);
      if (open && now.getTime() - open.startedAt.getTime() > FORGOTTEN_MS) {
        await closeForgotten(db, staff, open);
        r.autoClosed = open.workDate;
      } else if (open) {
        await botApi('sendMessage', {
          chat_id: staff.id, parse_mode: 'HTML',
          text: `🟢 Your shift is still open (since ${hm(open.startedAt, tz)}, ${durationEn((now.getTime() - open.startedAt.getTime()) / 60_000)}).\nDon't forget to end it: /endshift — that sends the day's report to the channel.`,
        }).catch(() => {});
        r.reminded = true;
      }
      for (const day of [addDays(today, -1), today]) {
        const shifts = await shiftsBetween(db, staff.id, day, day);
        if (shifts.length && shifts.every((s) => s.endedAt) && !(await getPost(db, staff.id, 'daily', day))) {
          if (await publish(db, staff, 'daily', day, now)) r[`daily ${day}`] = 'posted';
        }
      }
      if (isSaturday(today) && (await publish(db, staff, 'weekly', today, now))) r.weekly = 'posted';
      if (isLastDayOfMonth(today) && (await publish(db, staff, 'monthly', today, now))) r.monthly = 'posted';
    } catch (e) {
      console.error('[report] evening job failed for', staff.id, (e as Error).message);
      r.error = (e as Error).message;
    }
    results.push(r);
  }
  return results;
}
