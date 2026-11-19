// Russian wording shared by the cards, captions and the bot: plurals, durations, times.

/** plural(5, 'задача', 'задачи', 'задач') → "задач" */
export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}
export const count = (n: number, one: string, few: string, many: string) => `${n.toLocaleString('ru-RU')} ${plural(n, one, few, many)}`;
export const tasks = (n: number) => count(n, 'задача', 'задачи', 'задач');

/** 575 → "9 ч 35 мин", 45 → "45 мин", 120 → "2 ч" */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} мин`;
  return r ? `${h} ч ${r} мин` : `${h} ч`;
}
/** 575 → "9 h 35 min" (the bot's own messages are in English) */
export function durationEn(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (!h) return `${r} min`;
  return r ? `${h} h ${r} min` : `${h} h`;
}
/** Hours to the half hour, with a decimal comma: 3110 → "52", 3090 → "51,5" */
export function hours(minutes: number): string {
  const h = Math.round((minutes / 60) * 2) / 2;
  return String(h).replace('.', ',');
}
/** "+6 ч к прошлой", "−2 задачи к прошлой" */
export const signed = (n: number) => (n > 0 ? `+${n}` : n < 0 ? `−${-n}` : '±0');

const p2 = (n: number) => String(n).padStart(2, '0');
/** 09:05 in the report time zone. */
export function hm(at: Date, tz: string): string {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (t: string) => Number(f.find((p) => p.type === t)?.value ?? 0);
  return `${p2(get('hour') % 24)}:${p2(get('minute'))}`;
}

export { escHtml as esc } from '../../support/common/html.js';
export const cut = (t: string, n: number) => (t.length <= n ? t : t.slice(0, n - 1).trimEnd() + '…');

/** The labels of each kind of entry: Russian on the reports, English in the bot. */
export const KIND = {
  done: { title: 'Сделано', en: 'Done', icon: '✅', command: 'done', ask: 'what was done' },
  improved: { title: 'Что стало лучше', en: 'Got better', icon: '📈', command: 'better', ask: 'what got better' },
  learned: { title: 'Чему научился', en: 'Learned', icon: '🎓', command: 'learned', ask: 'what you learned' },
  plan: { title: 'План на завтра', en: 'Plan for tomorrow', icon: '🔜', command: 'plan', ask: 'what is planned' },
  blocker: { title: 'Что мешает', en: 'Blockers', icon: '⚠️', command: 'blocker', ask: 'what is in the way' },
} as const;
export type Kind = keyof typeof KIND;
export const KINDS = Object.keys(KIND) as Kind[];
