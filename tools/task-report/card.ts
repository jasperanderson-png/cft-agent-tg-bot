import { Resvg } from '@resvg/resvg-js';
import { brandFile, LOGO_RATIO, logoDataUri } from '../../support/helpers/brand.js';
import { escXml as xml } from '../../support/common/html.js';
import { areaOf } from './areas.js';
import { areasOf, type DailyReport, type MonthlyReport, type Report, type WeeklyReport } from './build.js';
import { capital, dm, MONTHS, MONTHS_DATIVE, monthIndex, WEEKDAYS, WEEKDAYS_SHORT, weekday, yearOf } from './periods.js';
import type { Entry } from './store.js';
import { count, duration, hm, hours, KIND, plural, signed } from './words.js';

// The report cards: pictures in the CFT Mini App's look (black, the CFT logo, blue accents) posted to
// the channel. Fira Sans, because the Mini App's Barlow has no Russian letters.

const C = { bg: '#000', card: '#121416', line: 'rgba(255,255,255,0.1)', row: 'rgba(255,255,255,0.07)', ink: '#202c33', blue: '#a0dcff', text: '#fff', soft: '#ccc', muted: '#8f8f8f', good: '#9be7b0', warn: '#f2c27b' };
const SANS = 'Fira Sans';
const COND = 'Fira Sans Condensed';
const W = 1080;
const PAD = 56;
/** Items shown per list; the rest are counted ("…и ещё 3"). */
const MAX_ITEMS = 8;

const fontFiles = () => ['FiraSans-Regular.ttf', 'FiraSans-SemiBold.ttf', 'FiraSansCondensed-Bold.ttf'].map(brandFile);
const resvgOpts = () => ({ font: { fontFiles: fontFiles(), loadSystemFonts: false, defaultFontFamily: SANS } });

// ---- Measuring text: each character's width in the real font, measured once ----

const advances = new Map<string, number>();
function measure(text: string, size: number, weight: number, family: string): number {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="120"><text x="10" y="80" font-family="${family}" font-size="${size}" font-weight="${weight}">${xml(text)}</text></svg>`;
  return new Resvg(svg, resvgOpts()).getBBox()?.width ?? 0;
}
export function width(text: string, size: number, weight = 400, family = SANS): number {
  let sum = 0;
  for (const ch of text) {
    const k = `${family}|${weight}|${ch}`;
    let w = advances.get(k);
    if (w === undefined) {
      // Measured at 100px between two H's, so spaces count with their real width; scaled after.
      w = Math.max(0, measure(`H${ch}H`, 100, weight, family) - measure('HH', 100, weight, family));
      advances.set(k, w);
    }
    sum += (w * size) / 100;
  }
  return sum;
}
export function wrap(text: string, max: number, size: number, weight = 400): string[] {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const t = line ? `${line} ${word}` : word;
    if (line && width(t, size, weight) > max) {
      out.push(line);
      line = word;
    } else line = t;
  }
  out.push(line);
  return out;
}

interface TextOpts { size?: number; weight?: number; fill?: string; family?: string; anchor?: 'start' | 'middle' | 'end' }
const T = (x: number, y: number, text: string, { size = 28, weight = 400, fill = C.text, family = SANS, anchor = 'start' }: TextOpts = {}) =>
  `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-family="${family}" font-weight="${weight}" font-size="${size}" fill="${fill}" text-anchor="${anchor}">${xml(text)}</text>`;

// ---- Blocks: each has a height and draws itself at a given y ----

interface Block {
  h: number;
  svg(y: number): string;
}

function pill(xRight: number, y: number, text: string): string {
  const w = width(text, 20, 600) + 28;
  return `<rect x="${xRight - w}" y="${y}" width="${w}" height="36" rx="18" fill="rgba(160,220,255,0.10)" stroke="rgba(160,220,255,0.25)"/>` + T(xRight - w + 14, y + 25, text, { size: 20, weight: 600, fill: C.blue });
}
const tagW = (t: string) => width(t, 18, 600) + 20;
function tag(xRight: number, y: number, text: string): string {
  const w = tagW(text);
  return `<rect x="${xRight - w}" y="${y}" width="${w}" height="30" rx="7" fill="${C.ink}"/>` + T(xRight - w + 10, y + 21, text, { size: 18, weight: 600, fill: C.blue });
}

function header(kicker: string, title: string, sub: string): Block {
  const subLines = wrap(sub, W - 2 * PAD, 28);
  return {
    h: 214 + subLines.length * 36,
    svg: (y) =>
      `<image href="${logoDataUri()}" x="${PAD}" y="${y + PAD}" height="30" width="${Math.round(30 * LOGO_RATIO)}"/>` +
      pill(W - PAD, y + PAD - 2, kicker) +
      T(PAD, y + 168, title, { size: 76, weight: 700, family: COND }) +
      subLines.map((l, i) => T(PAD, y + 214 + i * 36, l, { size: 28, fill: C.soft })).join(''),
  };
}

interface Stat { value: string; unit?: string; label: string; note?: string; bad?: boolean }
function stats(items: Stat[]): Block {
  const gap = 16;
  const n = items.length;
  const w = (W - 2 * PAD - gap * (n - 1)) / n;
  const size = n > 3 ? 50 : 56;
  return {
    h: 172,
    svg: (y) =>
      items.map((s, i) => {
        const x = PAD + i * (w + gap);
        return [
          `<rect x="${x}" y="${y}" width="${w}" height="148" rx="16" fill="rgba(160,220,255,0.04)" stroke="${C.line}" stroke-width="2"/>`,
          T(x + 24, y + 74, s.value, { size, weight: 700, family: COND, fill: i === 0 ? C.blue : C.text }),
          s.unit ? T(x + 24 + width(s.value, size, 700, COND) + 8, y + 74, s.unit, { size: 26, weight: 700, family: COND, fill: C.soft }) : '',
          T(x + 24, y + 112, s.label, { size: 21, fill: C.muted }),
          s.note ? T(x + 24, y + 136, s.note, { size: 18, weight: 600, fill: s.bad ? C.warn : C.good }) : '',
        ].join('');
      }).join(''),
  };
}

interface Item { text: string; sub?: string | null; tag?: string | null; group?: string }
const cardFrame = (y: number, h: number, title: string, accent: string, right?: string) =>
  `<rect x="${PAD}" y="${y}" width="${W - 2 * PAD}" height="${h}" rx="22" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>` +
  `<rect x="${PAD + 32}" y="${y + 38}" width="6" height="30" rx="3" fill="${accent}"/>` +
  T(PAD + 52, y + 63, title, { size: 32, weight: 700, family: COND }) +
  (right ? T(W - PAD - 32, y + 63, right, { size: 22, fill: C.muted, anchor: 'end' }) : '');

const GROUP_H = 46;

function list(title: string, all: Item[], { numbered = false, accent = C.blue, right, max = MAX_ITEMS }: { numbered?: boolean; accent?: string; right?: string; max?: number } = {}): Block {
  const inner = W - 2 * PAD - 64;
  // Never hide just one or two: "…и ещё 1" costs as much room as the item itself.
  const shown = all.length <= max + 2 ? all : all.slice(0, max);
  const more = all.length - shown.length;
  const rows = shown.map((t, i) => {
    const room = inner - 40 - (t.tag ? tagW(t.tag) + 20 : 0);
    const lines = wrap(t.text, room, 27);
    const sub = t.sub ? wrap(t.sub, room, 22) : [];
    const heading = t.group && t.group !== shown[i - 1]?.group ? t.group : null;
    return { ...t, lines, sub, heading, h: lines.length * 38 + sub.length * 30 + 26 + (heading ? GROUP_H : 0) };
  });
  const h = 92 + rows.reduce((s, r) => s + r.h, 0) + (more > 0 ? 44 : 0) + 20;
  return {
    h: h + 24,
    svg: (y) => {
      const out = [cardFrame(y, h, title, accent, right)];
      let cy = y + 92;
      const x = PAD + 32;
      rows.forEach((r, i) => {
        if (r.heading) {
          out.push(T(x, cy + 30, r.heading.toUpperCase(), { size: 19, weight: 600, fill: C.blue }));
          out.push(`<rect x="${x + width(r.heading.toUpperCase(), 19, 600) + 14}" y="${cy + 23}" width="${inner - width(r.heading.toUpperCase(), 19, 600) - 14}" height="1" fill="${C.row}"/>`);
          cy += GROUP_H;
        }
        if (numbered) out.push(T(x, cy + 34, String(i + 1), { size: 27, weight: 700, family: COND, fill: accent }));
        else out.push(`<circle cx="${x + 9}" cy="${cy + 25}" r="6" fill="${accent}"/>`);
        r.lines.forEach((l, j) => out.push(T(x + 40, cy + 34 + j * 38, l, { size: 27 })));
        r.sub.forEach((l, j) => out.push(T(x + 40, cy + 30 + r.lines.length * 38 + j * 30, l, { size: 22, fill: C.muted })));
        if (r.tag) out.push(tag(W - PAD - 32, cy + 10, r.tag));
        cy += r.h - (r.heading ? GROUP_H : 0);
        if ((i < rows.length - 1 && !rows[i + 1].heading) || more > 0) out.push(`<rect x="${x + 40}" y="${cy - 12}" width="${inner - 40}" height="1" fill="${C.row}"/>`);
      });
      if (more > 0) out.push(T(x + 40, cy + 22, `…и ещё ${more}`, { size: 24, fill: C.muted }));
      return out.join('');
    },
  };
}

interface Bar { x: string; x2?: string; v: number; label: string; dim?: boolean }
function bars(title: string, data: Bar[], { avg, right }: { avg?: number; right?: string } = {}): Block {
  const h = data.some((d) => d.x2) ? 450 : 430;
  return {
    h: h + 24,
    svg: (y) => {
      const x0 = PAD + 40;
      const x1 = W - PAD - 40;
      const top = y + 130;
      const base = y + h - (data.some((d) => d.x2) ? 90 : 70);
      const max = Math.max(1, ...data.map((d) => d.v)) * 1.1;
      const slot = (x1 - x0) / data.length;
      const bw = Math.min(90, slot * 0.56);
      const out = [cardFrame(y, h, title, C.blue, right), `<rect x="${x0}" y="${base}" width="${x1 - x0}" height="2" fill="${C.line}"/>`];
      if (avg) {
        const ay = base - (avg / max) * (base - top);
        out.push(`<line x1="${x0}" y1="${ay}" x2="${x1}" y2="${ay}" stroke="${C.muted}" stroke-width="2" stroke-dasharray="8 8"/>`);
      }
      data.forEach((d, i) => {
        const cx = x0 + slot * i + slot / 2;
        const bh = d.v > 0 ? Math.max(48, (d.v / max) * (base - top)) : 6;
        out.push(`<rect x="${cx - bw / 2}" y="${base - bh}" width="${bw}" height="${bh}" rx="10" fill="${d.v <= 0 ? 'rgba(255,255,255,0.08)' : d.dim ? 'rgba(160,220,255,0.3)' : C.blue}"/>`);
        if (d.v > 0) out.push(T(cx, base - bh + 36, d.label, { size: 28, weight: 700, family: COND, anchor: 'middle', fill: d.dim ? C.text : C.ink }));
        else out.push(T(cx, base - 18, '—', { size: 24, fill: C.muted, anchor: 'middle' }));
        out.push(T(cx, base + 36, d.x, { size: 22, fill: C.soft, anchor: 'middle' }));
        if (d.x2) out.push(T(cx, base + 64, d.x2, { size: 19, fill: C.muted, anchor: 'middle' }));
      });
      return out.join('');
    },
  };
}

function areas(title: string, data: { name: string; n: number }[], right?: string): Block {
  const rowH = 64;
  const h = 100 + data.length * rowH + 16;
  return {
    h: h + 24,
    svg: (y) => {
      const max = Math.max(1, ...data.map((d) => d.n));
      const x0 = PAD + 32 + 230;
      const x1 = W - PAD - 110;
      const out = [cardFrame(y, h, title, C.blue, right)];
      data.forEach((d, i) => {
        const cy = y + 104 + i * rowH;
        out.push(T(PAD + 32, cy + 30, d.name, { size: 26, fill: C.soft }));
        out.push(`<rect x="${x0}" y="${cy + 10}" width="${x1 - x0}" height="16" rx="8" fill="rgba(255,255,255,0.07)"/>`);
        out.push(`<rect x="${x0}" y="${cy + 10}" width="${((x1 - x0) * d.n) / max}" height="16" rx="8" fill="${C.blue}"/>`);
        out.push(T(W - PAD - 32, cy + 31, String(d.n), { size: 30, weight: 700, family: COND, anchor: 'end' }));
      });
      return out.join('');
    },
  };
}

const footer = (left: string): Block => ({
  h: 90,
  svg: (y) => T(PAD, y + 40, left, { size: 21, fill: C.muted }) + T(W - PAD, y + 40, '@cft_Agentbot', { size: 21, fill: C.muted, anchor: 'end' }),
});

function page(blocks: Block[]): string {
  const h = blocks.reduce((s, b) => s + b.h, 0);
  let y = 0;
  const body = blocks.map((b) => {
    const s = b.svg(y);
    y += b.h;
    return s;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}"><defs><radialGradient id="glow" cx="0.1" cy="0" r="0.8"><stop offset="0" stop-color="${C.blue}" stop-opacity="0.30"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${h}" fill="${C.bg}"/><rect width="${W}" height="620" fill="url(#glow)"/>${body}</svg>`;
}

// ---- The three cards ----

const item = (e: Entry): Item => ({ text: e.text, sub: e.detail, tag: e.area });
const compare = (now: number, before: number | undefined, unit: (n: number) => string, what: string) =>
  before === undefined || before === 0 && now === 0 ? undefined : { note: `${signed(now - before)}${unit(now - before)} ${what}`, bad: now < before };

export function dailySvg(r: DailyReport, tz: string): string {
  const times = r.shifts.map((s) => `${hm(s.startedAt, tz)} – ${s.endedAt ? hm(s.endedAt, tz) : 'сейчас'}`);
  const sub = [r.shifts.length ? `${r.shifts.length > 1 ? 'Смены' : 'Смена'} ${times.join(', ')}` : 'Смены не было', r.name].join(' · ');
  const blocks: Block[] = [
    header('ОТЧЁТ ЗА ДЕНЬ', `${capital(WEEKDAYS[weekday(r.day)])}, ${dm(r.day)}`, sub),
    stats([
      { value: duration(r.minutes).split(' ')[0], unit: duration(r.minutes).split(' ').slice(1).join(' '), label: r.open ? 'на смене (идёт)' : r.autoClosed ? 'смена закрыта ботом' : 'на смене' },
      { value: String(r.entries.done.length), label: `${plural(r.entries.done.length, 'задача выполнена', 'задачи выполнено', 'задач выполнено')}` },
      { value: String(r.entries.improved.length), label: plural(r.entries.improved.length, 'улучшение', 'улучшения', 'улучшений') },
    ]),
  ];
  const e = r.entries;
  // Finished tasks grouped by area, biggest area first; the area is a heading, not a tag on each line.
  const order = areasOf(e.done).map((a) => a.name);
  const done = [...e.done].sort((a, b) => order.indexOf(areaOf(a)) - order.indexOf(areaOf(b)));
  const grouped = order.length > 1;
  blocks.push(list(KIND.done.title, done.length ? done.map((x) => ({ text: x.text, sub: x.detail, tag: grouped ? null : x.area, group: grouped ? areaOf(x) : undefined })) : [{ text: 'Записей о сделанном за день нет' }], { max: 14 }));
  if (e.improved.length) blocks.push(list(KIND.improved.title, e.improved.map(item), { accent: C.good }));
  if (e.learned.length) blocks.push(list(KIND.learned.title, e.learned.map(item), { accent: C.good }));
  if (e.blocker.length) blocks.push(list(KIND.blocker.title, e.blocker.map(item), { accent: C.warn }));
  if (e.plan.length) blocks.push(list(KIND.plan.title, e.plan.map(item)));
  blocks.push(footer('CFT · отчёт о работе'));
  return page(blocks);
}

export function weeklySvg(r: WeeklyReport): string {
  const t = r.totals;
  const p = r.previous ?? undefined;
  const workdays = r.days.filter((d) => weekday(d.day) !== 6).length;
  const avg = r.daysWorked ? t.minutes / 60 / r.daysWorked : 0;
  const blocks: Block[] = [
    header('ИТОГИ НЕДЕЛИ', `${dm(r.period.start)} – ${dm(r.period.end)}`, `${count(r.daysWorked, 'рабочий день', 'рабочих дня', 'рабочих дней')} · ${r.name}`),
    stats([
      { value: hours(t.minutes), unit: 'ч', label: 'на смене', ...compare(Math.round(t.minutes / 60), p && Math.round(p.minutes / 60), () => ' ч', 'к прошлой') },
      { value: String(r.daysWorked), unit: `из ${workdays}`, label: 'дней на смене' },
      { value: String(t.done), label: plural(t.done, 'задача выполнена', 'задачи выполнено', 'задач выполнено'), ...compare(t.done, p?.done, () => '', 'к прошлой') },
      { value: String(t.improved), label: plural(t.improved, 'улучшение', 'улучшения', 'улучшений') },
    ]),
    bars('Часы по дням', r.days.map((d) => ({ x: WEEKDAYS_SHORT[weekday(d.day)], v: d.minutes / 60, label: hours(d.minutes) })), {
      avg: avg || undefined, right: `всего ${hours(t.minutes)} ч${avg ? ` · в среднем ${String(Math.round(avg * 10) / 10).replace('.', ',')} ч в день` : ''}`,
    }),
  ];
  if (r.highlights.length) blocks.push(list('Главное за неделю', r.highlights.map(item), { numbered: true }));
  if (r.areas.length) blocks.push(areas('Задачи по направлениям', r.areas, count(t.done, 'задача', 'задачи', 'задач')));
  if (r.plans.length) blocks.push(list('План на следующую неделю', r.plans.map(item)));
  blocks.push(footer('CFT · итоги недели'));
  return page(blocks);
}

export function monthlySvg(r: MonthlyReport): string {
  const t = r.totals;
  const p = r.previous ?? undefined;
  const mi = monthIndex(r.period.start);
  const vsPrev = `к ${MONTHS_DATIVE[(mi + 11) % 12]}`;
  const pct = (now: number, before: number | undefined) => (before ? { note: `${signed(Math.round(((now - before) / before) * 100))}% ${vsPrev}`, bad: now < before } : {});
  const blocks: Block[] = [
    header('ИТОГИ МЕСЯЦА', `${capital(MONTHS[mi])} ${yearOf(r.period.start)}`, `${count(r.shifts, 'смена', 'смены', 'смен')} · ${dm(r.period.start)} – ${dm(r.period.end)} · ${r.name}`),
    stats([
      { value: hours(t.minutes), unit: 'ч', label: 'на смене', ...pct(t.minutes, p?.minutes) },
      { value: String(r.shifts), label: plural(r.shifts, 'смена', 'смены', 'смен') },
      { value: String(t.done), label: plural(t.done, 'задача решена', 'задачи решено', 'задач решено'), ...pct(t.done, p?.done) },
      { value: String(t.improved), label: plural(t.improved, 'улучшение', 'улучшения', 'улучшений') },
    ]),
    bars('Часы и задачи по неделям', r.weeks.map((w) => ({
      x: w.start === w.end ? dm(w.start) : `${w.start.slice(8)}–${dm(w.end)}`, x2: count(w.done, 'задача', 'задачи', 'задач'), v: w.minutes / 60, label: hours(w.minutes), dim: w.partial,
    })), { right: r.weeks.some((w) => w.partial) ? 'бледные — неполные недели' : undefined }),
  ];
  if (r.areas.length) blocks.push(areas('Решённые задачи по направлениям', r.areas, count(t.done, 'задача', 'задачи', 'задач')));
  if (r.highlights.length) blocks.push(list('Главные результаты месяца', r.highlights.map(item), { numbered: true }));
  if (r.learned.length) blocks.push(list(KIND.learned.title, r.learned.map(item), { accent: C.good }));
  blocks.push(footer(t.done > r.highlights.length ? `Полный список ${count(t.done, 'задачи', 'задач', 'задач')} — в сообщении ниже` : 'CFT · итоги месяца'));
  return page(blocks);
}

export const reportSvg = (r: Report, tz: string) => (r.kind === 'daily' ? dailySvg(r, tz) : r.kind === 'weekly' ? weeklySvg(r) : monthlySvg(r));

/** SVG → PNG. Tests replace it to read the card's text instead of pixels. */
export const cardRender = {
  png: (svg: string): Uint8Array => new Resvg(svg, { ...resvgOpts(), fitTo: { mode: 'width', value: W } }).render().asPng(),
};
