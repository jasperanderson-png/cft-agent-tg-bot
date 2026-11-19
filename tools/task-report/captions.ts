import { areasOf, highlightsOf, type DailyReport, type MonthlyReport, type Report, type WeeklyReport } from './build.js';
import { areaOf } from './areas.js';
import { dm, dmy, MONTHS, monthIndex, WEEKDAYS, weekday, yearOf } from './periods.js';
import type { Entry } from './store.js';
import { count, cut, duration, esc, hm, hours, tasks } from './words.js';

// The text under each card. Notifications and channel search show only text, so it carries the
// essentials in a few lines. Telegram allows 1,024 characters under a picture.

const CAPTION_MAX = 1024;
const bullets = (list: Entry[], n: number, len = 110) => [
  ...list.slice(0, n).map((e) => `• ${esc(cut(e.text, len))}`),
  ...(list.length > n ? [`<i>…и ещё ${list.length - n}</i>`] : []),
];
function fit(lines: (string | null | false)[]): string {
  const out = lines.filter((l): l is string => typeof l === 'string');
  let text = out.join('\n');
  while (text.length > CAPTION_MAX && out.length > 3) {
    out.splice(out.length - 2, 1);
    text = out.join('\n');
  }
  return text.slice(0, CAPTION_MAX);
}

export function dailyCaption(r: DailyReport, tz: string): string {
  const times = r.shifts.map((s) => `${hm(s.startedAt, tz)}–${s.endedAt ? hm(s.endedAt, tz) : 'сейчас'}`).join(', ');
  const e = r.entries;
  const areas = areasOf(e.done);
  const top = highlightsOf(e.done, 3);
  return fit([
    `📅 <b>Отчёт за день · ${dmy(r.day)}</b> (${WEEKDAYS[weekday(r.day)]})`,
    r.shifts.length ? `⏱ ${r.shifts.length > 1 ? 'Смены' : 'Смена'} ${times} · <b>${duration(r.minutes)}</b>${r.autoClosed ? ' <i>(закрыта ботом)</i>' : ''}` : '⏱ Смены не было',
    `✅ ${tasks(e.done.length)} · 📈 ${count(e.improved.length, 'улучшение', 'улучшения', 'улучшений')}`,
    areas.length > 1 ? `📂 ${areas.map((a) => `${esc(a.name)} ${a.n}`).join(' · ')}` : null,
    top.length ? '' : null,
    top.length ? '<b>Главное:</b>' : null,
    ...bullets(top, 3),
    e.plan.length ? '' : null,
    e.plan.length ? `🔜 <b>Завтра:</b> ${esc(cut(e.plan.map((p) => p.text).join('; '), 200))}` : null,
  ]);
}

export function weeklyCaption(r: WeeklyReport): string {
  const t = r.totals;
  return fit([
    `📊 <b>Итоги недели · ${dm(r.period.start)} – ${dmy(r.period.end)}</b>`,
    `⏱ <b>${hours(t.minutes)} ч</b> на смене · ${count(r.daysWorked, 'день', 'дня', 'дней')}`,
    `✅ ${tasks(t.done)} выполнено · 📈 ${count(t.improved, 'улучшение', 'улучшения', 'улучшений')}`,
    r.highlights.length ? '' : null,
    r.highlights.length ? '<b>Главное:</b>' : null,
    ...bullets(r.highlights, 5),
  ]);
}

export function monthlyCaption(r: MonthlyReport): string {
  const t = r.totals;
  const month = MONTHS[monthIndex(r.period.start)];
  return fit([
    `🗓 <b>Итоги месяца · ${month} ${yearOf(r.period.start)}</b>`,
    `⏱ <b>${hours(t.minutes)} ч</b> на смене · ${count(r.shifts, 'смена', 'смены', 'смен')}`,
    `✅ ${tasks(t.done)} решено · 📈 ${count(t.improved, 'улучшение', 'улучшения', 'улучшений')}`,
    r.areas.length ? `📂 ${r.areas.slice(0, 5).map((a) => `${esc(a.name)} ${a.n}`).join(' · ')}` : null,
    r.highlights.length ? '' : null,
    r.highlights.length ? '<b>Главные результаты:</b>' : null,
    ...bullets(r.highlights, 5),
  ]);
}

export const reportCaption = (r: Report, tz: string) => (r.kind === 'daily' ? dailyCaption(r, tz) : r.kind === 'weekly' ? weeklyCaption(r) : monthlyCaption(r));

/** The monthly full list of solved tasks, grouped by area, split into messages Telegram accepts. */
export function monthlyTaskList(r: MonthlyReport): string[] {
  if (r.done.length <= r.highlights.length) return [];
  const month = MONTHS[monthIndex(r.period.start)];
  const lines = [`📋 <b>Все решённые задачи · ${month} ${yearOf(r.period.start)}</b> (${r.done.length})`];
  for (const a of r.areas) {
    lines.push('', `<b>${esc(a.name)}</b> · ${a.n}`);
    for (const e of r.done.filter((x) => areaOf(x) === a.name)) lines.push(`• ${esc(cut(e.text, 300))}`);
  }
  const out: string[] = [];
  let cur = '';
  for (const l of lines) {
    if (cur.length + l.length + 1 > 3900) {
      out.push(cur);
      cur = '';
    }
    cur += (cur ? '\n' : '') + l;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
