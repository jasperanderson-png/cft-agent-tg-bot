import type { Db } from '../../database/db.js';
import { areaOf, OTHER_AREA } from './areas.js';
import { addDays, daysBetween, monthOf, previousMonth, weekday, weekOf, type Day, type Period } from './periods.js';
import { entriesBetween, shiftMinutes, shiftsBetween, type Entry, type Shift, type Staff } from './store.js';

// What goes into each report, worked out from the shifts and the work log. Drawing (card.ts) and
// wording (captions.ts) only read these.

export interface DailyReport {
  kind: 'daily';
  name: string;
  day: Day;
  shifts: Shift[];
  minutes: number;
  /** A shift still open, counted until now. */
  open: boolean;
  /** A forgotten shift the bot closed itself. */
  autoClosed: boolean;
  entries: Record<Entry['kind'], Entry[]>;
}

export interface AreaCount {
  name: string;
  n: number;
}
export interface Totals {
  minutes: number;
  done: number;
  improved: number;
}
export interface WeeklyReport {
  kind: 'weekly';
  name: string;
  period: Period;
  totals: Totals;
  previous: Totals | null;
  days: { day: Day; minutes: number }[];
  daysWorked: number;
  highlights: Entry[];
  areas: AreaCount[];
  plans: Entry[];
}
export interface MonthlyReport {
  kind: 'monthly';
  name: string;
  period: Period;
  totals: Totals;
  previous: Totals | null;
  shifts: number;
  weeks: { start: Day; end: Day; minutes: number; done: number; partial: boolean }[];
  highlights: Entry[];
  areas: AreaCount[];
  learned: Entry[];
  done: Entry[];
}
export type Report = DailyReport | WeeklyReport | MonthlyReport;

const SIZE_RANK = { l: 3, m: 2, s: 1 };

function byKind(entries: Entry[]): DailyReport['entries'] {
  const out: DailyReport['entries'] = { done: [], improved: [], learned: [], plan: [], blocker: [] };
  for (const e of entries) out[e.kind].push(e);
  return out;
}
const minutesOf = (shifts: Shift[], now: Date) => shifts.reduce((s, x) => s + shiftMinutes(x, now), 0);
const totals = (shifts: Shift[], entries: Entry[], now: Date): Totals => ({
  minutes: minutesOf(shifts, now),
  done: entries.filter((e) => e.kind === 'done').length,
  improved: entries.filter((e) => e.kind === 'improved').length,
});

/** The most notable finished work first: marked highlights, then large, then medium tasks. */
export function highlightsOf(entries: Entry[], n: number): Entry[] {
  return entries
    .filter((e) => e.kind === 'done')
    .map((e, i) => ({ e, i }))
    .sort((a, b) => Number(b.e.highlight) - Number(a.e.highlight) || SIZE_RANK[b.e.size] - SIZE_RANK[a.e.size] || a.i - b.i)
    .slice(0, n)
    .map((x) => x.e);
}
export function areasOf(entries: Entry[]): AreaCount[] {
  const m = new Map<string, number>();
  for (const e of entries) if (e.kind === 'done') m.set(areaOf(e), (m.get(areaOf(e)) ?? 0) + 1);
  return [...m.entries()].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n || (a.name === OTHER_AREA ? 1 : b.name === OTHER_AREA ? -1 : a.name.localeCompare(b.name)));
}

export async function dailyReport(db: Db, staff: Staff, day: Day, now = new Date()): Promise<DailyReport> {
  const [shifts, entries] = await Promise.all([shiftsBetween(db, staff.id, day, day), entriesBetween(db, staff.id, day, day)]);
  return {
    kind: 'daily', name: staff.name, day, shifts, minutes: minutesOf(shifts, now),
    open: shifts.some((s) => !s.endedAt), autoClosed: shifts.some((s) => s.endReason === 'auto'), entries: byKind(entries),
  };
}

export async function weeklyReport(db: Db, staff: Staff, anyDay: Day, now = new Date()): Promise<WeeklyReport> {
  const period = weekOf(anyDay);
  const prev = { start: addDays(period.start, -7), end: addDays(period.end, -7) };
  const [shifts, entries, prevShifts, prevEntries] = await Promise.all([
    shiftsBetween(db, staff.id, period.start, period.end), entriesBetween(db, staff.id, period.start, period.end),
    shiftsBetween(db, staff.id, prev.start, prev.end), entriesBetween(db, staff.id, prev.start, prev.end),
  ]);
  const perDay = (d: Day) => minutesOf(shifts.filter((s) => s.workDate === d), now);
  // Monday to Saturday always; Sunday only when there was work on it.
  const days = daysBetween(period.start, period.end).filter((d) => weekday(d) !== 6 || perDay(d) > 0).map((day) => ({ day, minutes: perDay(day) }));
  const hadPrev = prevShifts.length > 0 || prevEntries.length > 0;
  return {
    kind: 'weekly', name: staff.name, period, totals: totals(shifts, entries, now), previous: hadPrev ? totals(prevShifts, prevEntries, now) : null,
    days, daysWorked: new Set(shifts.map((s) => s.workDate)).size, highlights: highlightsOf(entries, 5), areas: areasOf(entries),
    plans: entries.filter((e) => e.kind === 'plan' && e.workDate === period.end),
  };
}

export async function monthlyReport(db: Db, staff: Staff, anyDay: Day, now = new Date()): Promise<MonthlyReport> {
  const period = monthOf(anyDay);
  const prev = previousMonth(period);
  const [shifts, entries, prevShifts, prevEntries] = await Promise.all([
    shiftsBetween(db, staff.id, period.start, period.end), entriesBetween(db, staff.id, period.start, period.end),
    shiftsBetween(db, staff.id, prev.start, prev.end), entriesBetween(db, staff.id, prev.start, prev.end),
  ]);
  // Monday-to-Sunday weeks, cut to the month; a week partly outside the month is marked partial.
  const weeks: MonthlyReport['weeks'] = [];
  for (let d = period.start; d <= period.end; ) {
    const end = [addDays(d, 6 - weekday(d)), period.end].sort()[0];
    const inWeek = (x: { workDate: Day }) => x.workDate >= d && x.workDate <= end;
    weeks.push({
      start: d, end, minutes: minutesOf(shifts.filter(inWeek), now),
      done: entries.filter((e) => inWeek(e) && e.kind === 'done').length, partial: weekday(d) !== 0 || weekday(end) !== 6,
    });
    d = addDays(end, 1);
  }
  const hadPrev = prevShifts.length > 0 || prevEntries.length > 0;
  const seen = new Set<string>();
  return {
    kind: 'monthly', name: staff.name, period, totals: totals(shifts, entries, now), previous: hadPrev ? totals(prevShifts, prevEntries, now) : null,
    shifts: shifts.length, weeks, highlights: highlightsOf(entries, 5), areas: areasOf(entries),
    learned: entries.filter((e) => e.kind === 'learned' && !seen.has(e.text.toLowerCase()) && seen.add(e.text.toLowerCase())),
    done: entries.filter((e) => e.kind === 'done'),
  };
}

/** True when a period had nothing at all to report (no shift and no entry). */
export function isEmpty(r: Report): boolean {
  if (r.kind === 'daily') return !r.shifts.length && !Object.values(r.entries).some((l) => l.length);
  return !r.totals.minutes && !r.totals.done && !r.totals.improved && !(r.kind === 'monthly' ? r.learned.length : r.plans.length);
}
