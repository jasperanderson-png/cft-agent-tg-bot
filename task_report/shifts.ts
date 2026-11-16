import type { Db } from '../db_storage/db.js';
import { reportTimeZone } from '../core/updates.js';
import { dayOf, type Day } from './periods.js';
import { publish, updateStatus, type Published } from './publish.js';
import { closeShift, ensureStaff, insertShift, lastActivity, openShift, shiftsBetween, type Shift, type Staff } from './store.js';

// Starting and ending a shift. Ending one posts that day's report.

export interface Person {
  id: number;
  first_name?: string;
  last_name?: string;
}

export async function beginShift(db: Db, who: Person, now = new Date()): Promise<{ staff: Staff; shift: Shift; already: boolean }> {
  const staff = await ensureStaff(db, who);
  const tz = await reportTimeZone(db);
  const { shift, already } = await insertShift(db, staff.id, dayOf(now, tz), now);
  if (!already) await updateStatus(db, staff, shift, null);
  return { staff, shift, already };
}

export interface Finished {
  staff: Staff;
  shift: Shift;
  report: Published | null;
  /** Why the report could not be posted, when it could not. */
  reportError?: string;
}

/** Ends the open shift and posts (or updates) that day's report. Null when no shift was open. */
export async function endShift(db: Db, staff: Staff, at = new Date(), reason: 'manual' | 'auto' = 'manual'): Promise<Finished | null> {
  const shift = await closeShift(db, staff.id, at, reason);
  if (!shift) return null;
  await updateStatus(db, staff, null, shift);
  try {
    return { staff, shift, report: await publish(db, staff, 'daily', shift.workDate, at) };
  } catch (e) {
    console.error('[report] daily report failed:', (e as Error).message);
    return { staff, shift, report: null, reportError: (e as Error).message };
  }
}

/** A forgotten shift is closed at the last sign of work (its last log entry), or where it started. */
export async function closeForgotten(db: Db, staff: Staff, shift: Shift): Promise<Finished | null> {
  const last = await lastActivity(db, staff.id, shift.startedAt);
  return endShift(db, staff, last ?? shift.startedAt, 'auto');
}

/** The day new log entries belong to: the open shift's day, or today. */
export async function currentDay(db: Db, staffId: number, now = new Date()): Promise<Day> {
  const open = await openShift(db, staffId);
  return open?.workDate ?? dayOf(now, await reportTimeZone(db));
}

/** The person's last finished shift today, for the channel's status line. */
export async function lastShiftOn(db: Db, staffId: number, day: Day): Promise<Shift | null> {
  return (await shiftsBetween(db, staffId, day, day)).filter((s) => s.endedAt).at(-1) ?? null;
}
