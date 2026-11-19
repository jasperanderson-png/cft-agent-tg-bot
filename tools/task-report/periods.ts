import { zoned } from '../../support/common/time.js';

// Days, weeks and months of the reports, as calendar days ("2026-11-14") in the report time zone.
// A weekly report covers the seven days that end on Saturday (Sunday – Saturday); a monthly report
// covers the calendar month.

export type Day = string;

const p2 = (n: number) => String(n).padStart(2, '0');
const parts = (day: Day) => day.split('-').map(Number) as [number, number, number];
const fromUtc = (t: Date): Day => `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}`;

/** The calendar day of an instant in `tz`. */
export function dayOf(at: Date, tz: string): Day {
  const z = zoned(at, tz);
  return `${z.y}-${p2(z.m)}-${p2(z.d)}`;
}
export function addDays(day: Day, n: number): Day {
  const [y, m, d] = parts(day);
  return fromUtc(new Date(Date.UTC(y, m - 1, d + n)));
}
/** 0 = Monday … 6 = Sunday. */
export function weekday(day: Day): number {
  const [y, m, d] = parts(day);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
export const daysBetween = (from: Day, to: Day) => {
  const out: Day[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};

export interface Period {
  start: Day;
  end: Day;
}
/** The report week a day belongs to: Sunday – Saturday. */
export function weekOf(day: Day): Period {
  const end = addDays(day, (5 - weekday(day) + 7) % 7);
  return { start: addDays(end, -6), end };
}
export function monthOf(day: Day): Period {
  const [y, m] = parts(day);
  return { start: `${y}-${p2(m)}-01`, end: fromUtc(new Date(Date.UTC(y, m, 0))) };
}
export const previousMonth = (p: Period): Period => monthOf(addDays(p.start, -1));
export const isSaturday = (day: Day) => weekday(day) === 5;
export const isLastDayOfMonth = (day: Day) => addDays(day, 1).endsWith('-01');

// ---- Russian labels ----

export const WEEKDAYS = ['понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
export const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
export const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
/** "к октябрю" */
export const MONTHS_DATIVE = ['январю', 'февралю', 'марту', 'апрелю', 'маю', 'июню', 'июлю', 'августу', 'сентябрю', 'октябрю', 'ноябрю', 'декабрю'];

/** 14/11 */
export const dm = (day: Day) => `${day.slice(8, 10)}/${day.slice(5, 7)}`;
/** 14/11/2026 */
export const dmy = (day: Day) => `${dm(day)}/${day.slice(0, 4)}`;
export const monthIndex = (day: Day) => parts(day)[1] - 1;
export const yearOf = (day: Day) => parts(day)[0];
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
