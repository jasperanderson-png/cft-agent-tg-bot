/** Timezone-aware date helpers for reports (dd/mm/yyyy, Monday-start weeks). */

export interface Zoned {
  y: number;
  m: number; // 1–12
  d: number;
  h: number;
  mi: number;
  /** 0 = Monday … 6 = Sunday */
  wd: number;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' });
    fmtCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

export function zoned(date: Date | string, tz: string): Zoned {
  const parts = Object.fromEntries(fmt(tz).formatToParts(new Date(date)).map((p) => [p.type, p.value]));
  return { y: +parts.year, m: +parts.month, d: +parts.day, h: +parts.hour % 24, mi: +parts.minute, wd: WD[parts.weekday] ?? 0 };
}

const p2 = (n: number) => String(n).padStart(2, '0');
export const dmy = (z: Pick<Zoned, 'y' | 'm' | 'd'>) => `${p2(z.d)}/${p2(z.m)}/${z.y}`;
export const fmtDMY = (date: Date | string, tz: string) => dmy(zoned(date, tz));
export const fmtDMYHM = (date: Date | string, tz: string) => {
  const z = zoned(date, tz);
  return `${dmy(z)} ${p2(z.h)}:${p2(z.mi)}`;
};

/** The UTC instant of a wall-clock time in `tz`. */
export function zonedToUtc(y: number, m: number, d: number, h: number, mi: number, tz: string): Date {
  const guess = Date.UTC(y, m - 1, d, h, mi);
  let t = guess;
  for (let i = 0; i < 3; i++) {
    const z = zoned(new Date(t), tz);
    const diff = Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi) - guess;
    if (!diff) break;
    t -= diff;
  }
  return new Date(t);
}

/** Monday 00:00 (in tz) of the week containing `date`, offset by `weeks`. */
export function weekStart(date: Date | string, tz: string, weeks = 0): Date {
  const z = zoned(date, tz);
  const base = new Date(Date.UTC(z.y, z.m - 1, z.d - z.wd + weeks * 7));
  return zonedToUtc(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 0, 0, tz);
}

/** Excel serial number of the wall-clock time in tz, rounded to the minute. */
export function excelSerial(date: Date | string, tz: string): number {
  const z = zoned(date, tz);
  return Date.UTC(z.y, z.m - 1, z.d, z.h, z.mi) / 86_400_000 + 25_569;
}

export interface Range {
  from: Date | null;
  to: Date | null;
  label: string;
}

export type RangeKey = 'week' | 'last_week' | '30d' | 'all';

export function rangeFor(key: RangeKey, tz: string, now = new Date()): Range {
  if (key === 'week') {
    const from = weekStart(now, tz);
    return { from, to: null, label: `${fmtDMY(from, tz)} – ${fmtDMY(now, tz)}` };
  }
  if (key === 'last_week') {
    const from = weekStart(now, tz, -1);
    const to = weekStart(now, tz);
    return { from, to, label: `${fmtDMY(from, tz)} – ${fmtDMY(new Date(to.getTime() - 1), tz)}` };
  }
  if (key === '30d') {
    const from = new Date(now.getTime() - 30 * 86_400_000);
    return { from, to: null, label: `${fmtDMY(from, tz)} – ${fmtDMY(now, tz)}` };
  }
  return { from: null, to: null, label: 'All time' };
}

export function inRange(iso: string | null | undefined, r: Range): boolean {
  if (!iso) return false;
  const t = new Date(iso).getTime();
  return (!r.from || t >= r.from.getTime()) && (!r.to || t < r.to.getTime());
}
