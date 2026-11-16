import { Resvg } from '@resvg/resvg-js';
import { byPrice, usd, type AgentStation } from '../../shared/discounts.js';
import { brandFile, logoDataUri } from '../../core/brand.js';

// The price table drivers receive, drawn as a picture in the CFT Mini App's look (black, the CFT
// logo, blue accents, Barlow): Station · City · State · Retail Price · Discount · Discounted Price ·
// Discounted Percent, cheapest first. A picture keeps seven columns lined up on any phone, which a
// text message cannot. Columns are as wide as their content with equal gaps; long names wrap.

/** Rows per picture: more would be shrunk too small to read when Telegram resizes the photo. */
export const ROWS_PER_IMAGE = 25;

/** The picture's usual width; it only grows when the columns need more room. */
const MIN_W = 1600;
const PAD = 40;
const INSET = 24;
const MIN_GAP = 40;
const TOP = 196;
const HEAD_H = 60;
const LINE_H = 36;
const ROW_PAD = 24;
const FONT = 26;

// The Mini App's colours (telegram_bot/mini_app/src/styles.css).
const C = { bg: '#000', card: '#111315', line: 'rgba(255,255,255,0.1)', row: 'rgba(255,255,255,0.08)', ink: '#202c33', blue: '#a0dcff', text: '#fff', soft: '#ccc', muted: '#999' };
const BODY = 'Barlow';
const COND = 'Barlow Semi Condensed';

type Font = { family: string; weight: number; size: number };
const F = {
  body: { family: BODY, weight: 400, size: FONT },
  name: { family: BODY, weight: 600, size: FONT },
  head: { family: BODY, weight: 600, size: 22 },
  price: { family: COND, weight: 700, size: 32 },
  chip: { family: BODY, weight: 700, size: 22 },
} satisfies Record<string, Font>;

type Kind = 'name' | 'city' | 'muted' | 'plain' | 'price' | 'chip';
interface Col {
  label: string;
  align: 'start' | 'end';
  kind: Kind;
  value: (s: AgentStation) => string;
  /** Text columns wrap at this width (px); number columns never wrap. */
  wrapAt?: number;
}
const fontOf = (k: Kind): Font => (k === 'name' ? F.name : k === 'price' ? F.price : k === 'chip' ? F.chip : F.body);
const CHIP_PAD = 14;

const discount = (s: AgentStation) => (s.saving != null ? usd(s.saving) : '—');
/** The discount as a share of the retail price: $0.63 of $6.09 is 10.3%. */
export const discountPercent = (s: AgentStation) =>
  s.saving != null && s.retail ? `${((s.saving / s.retail) * 100).toFixed(1)}%` : '—';

const NUMBER_COLS: Col[] = [
  { label: 'Retail Price', align: 'end', kind: 'muted', value: (s) => usd(s.retail) },
  { label: 'Discount', align: 'end', kind: 'plain', value: discount },
  { label: 'Discounted Price', align: 'end', kind: 'price', value: (s) => usd(s.price) },
  { label: 'Discounted Percent', align: 'end', kind: 'chip', value: discountPercent },
];
const STATION: Col = { label: 'Station', align: 'start', kind: 'name', wrapAt: 320, value: (s) => s.name };
const CITY: Col = { label: 'City', align: 'start', kind: 'city', wrapAt: 280, value: (s) => (s.city ?? '').toUpperCase() };
/** One state's stations: the state after the city, so a forwarded picture still says where the station is. */
const STATION_COLS: Col[] = [STATION, CITY, { label: 'State', align: 'start', kind: 'city', value: (s) => s.state }, ...NUMBER_COLS];
/** "Cheapest in each state": the state in front, since the rows go state by state. */
const STATE_COLS: Col[] = [{ label: 'State', align: 'start', kind: 'name', value: (s) => s.state }, STATION, CITY, ...NUMBER_COLS];

const xml = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fontFiles = () => ['Barlow-Regular.ttf', 'Barlow-SemiBold.ttf', 'BarlowSemiCondensed-Bold.ttf'].map(brandFile);
const logoUri = logoDataUri;

// ---- Measuring text: each character's width in the real font, measured once and remembered ----

const advances = new Map<string, number>();
function measureOne(text: string, f: Font): number {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="80"><text x="10" y="50" font-family="${f.family}" font-size="${f.size}" font-weight="${f.weight}">${xml(text)}</text></svg>`;
  return new Resvg(svg, { font: { fontFiles: fontFiles(), loadSystemFonts: false, defaultFontFamily: BODY } }).getBBox()?.width ?? 0;
}
function advance(ch: string, f: Font): number {
  const key = `${f.family}|${f.weight}|${f.size}|${ch}`;
  let w = advances.get(key);
  if (w === undefined) {
    // Between two H's, so spaces and thin marks count with their real width.
    w = Math.max(0, measureOne(`H${ch}H`, f) - measureOne('HH', f));
    advances.set(key, w);
  }
  return w;
}
/** Width of a line of text in pixels (body font unless another is given). */
export const textWidth = (t: string, f: Font = F.body) => [...t].reduce((sum, ch) => sum + advance(ch, f), 0);

/** Breaks text into lines no wider than `max`, at spaces where possible. */
export function wrap(text: string, max: number, f: Font = F.body): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    const tryLine = line ? `${line} ${word}` : word;
    if (textWidth(tryLine, f) <= max) {
      line = tryLine;
      continue;
    }
    if (line) lines.push(line);
    // A single word longer than the column is split.
    let rest = word;
    while (textWidth(rest, f) > max) {
      let n = rest.length - 1;
      while (n > 1 && textWidth(rest.slice(0, n), f) > max) n--;
      lines.push(rest.slice(0, n));
      rest = rest.slice(n);
    }
    line = rest;
  }
  if (line) lines.push(line);
  return lines;
}

export interface TableTitle {
  /** Big heading, e.g. "Ohio" or "Cheapest in each state". */
  heading: string;
  /** "Prices of 14/11/2026". */
  date: string;
  /** "Page 1 of 3" when a list takes several pictures. */
  page?: string;
}

const textAttrs = (f: Font, fill: string, anchor: 'start' | 'end') =>
  `font-family="${f.family}" font-size="${f.size}" font-weight="${f.weight}" fill="${fill}" text-anchor="${anchor}"`;

/** One table picture as SVG. */
export function tableSvg(rows: AgentStation[], title: TableTitle, byState = false): string {
  const cols = byState ? STATE_COLS : STATION_COLS;
  const cells = rows.map((r) => cols.map((c) => c.value(r)));
  const cellW = (c: Col, t: string) => textWidth(t, fontOf(c.kind)) + (c.kind === 'chip' && t !== '—' ? 2 * CHIP_PAD : 0);
  // Each column as wide as its widest entry (header included); text columns wrap past their limit.
  const widths = cols.map((c, i) => {
    const head = textWidth(c.label, F.head);
    const widest = Math.max(0, ...cells.map((row) => cellW(c, row[i])));
    return Math.ceil(Math.max(head, c.wrapAt ? Math.min(widest, c.wrapAt) : widest));
  });
  const lines = cells.map((row) => row.map((t, i) => (cols[i].wrapAt ? wrap(t, widths[i], fontOf(cols[i].kind)) : [t])));
  const used = widths.reduce((a, b) => a + b, 0);
  const gap = Math.max(MIN_GAP, (MIN_W - 2 * (PAD + INSET) - used) / (cols.length - 1));
  const W = Math.ceil(2 * (PAD + INSET) + used + gap * (cols.length - 1));
  const xs: number[] = [];
  let x = PAD + INSET;
  for (const w of widths) {
    xs.push(x);
    x += w + gap;
  }
  const anchor = (i: number) => (cols[i].align === 'end' ? xs[i] + widths[i] : xs[i]);
  const heights = lines.map((row) => ROW_PAD + LINE_H * Math.max(...row.map((l) => l.length)));
  const cardH = HEAD_H + heights.reduce((a, b) => a + b, 0);
  const h = TOP + cardH + PAD;
  const cardW = W - 2 * PAD;

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}">`,
    `<defs><radialGradient id="glow" cx="0.12" cy="0" r="0.75"><stop offset="0" stop-color="${C.blue}" stop-opacity="0.32"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0"/></radialGradient>`,
    `<clipPath id="card"><rect x="${PAD}" y="${TOP}" width="${cardW}" height="${cardH}" rx="22"/></clipPath></defs>`,
    `<rect width="${W}" height="${h}" fill="${C.bg}"/>`,
    `<rect width="${W}" height="${Math.min(h, 520)}" fill="url(#glow)"/>`,
    `<image href="${logoUri()}" x="${PAD}" y="${PAD}" height="30" width="${Math.round((30 * 366.52) / 43.72)}"/>`,
    `<text x="${W - PAD}" y="${PAD + 24}" ${textAttrs(F.head, C.muted, 'end')}>${xml(title.date)}</text>`,
    `<text x="${PAD}" y="${PAD + 112}" font-family="${COND}" font-size="56" font-weight="700" fill="${C.text}">${xml(title.heading)}</text>`,
    `<text x="${W - PAD}" y="${PAD + 112}" ${textAttrs(F.head, C.blue, 'end')}>${xml(['Fuel discounts with CFT · per gallon', title.page].filter(Boolean).join(' · '))}</text>`,
    `<rect x="${PAD}" y="${TOP}" width="${cardW}" height="${cardH}" rx="22" fill="${C.card}"/>`,
    `<g clip-path="url(#card)"><rect x="${PAD}" y="${TOP}" width="${cardW}" height="${HEAD_H}" fill="${C.ink}"/></g>`,
    ...cols.map((c, i) => `<text x="${anchor(i)}" y="${TOP + HEAD_H / 2 + 8}" ${textAttrs(F.head, C.blue, c.align)}>${xml(c.label)}</text>`),
  ];
  let y = TOP + HEAD_H;
  lines.forEach((row, r) => {
    row.forEach((cellLines, i) => {
      const c = cols[i];
      const base = y + ROW_PAD / 2 + 26;
      if (c.kind === 'chip' && cellLines[0] !== '—') {
        const t = cellLines[0];
        const w = textWidth(t, F.chip) + 2 * CHIP_PAD;
        const right = anchor(i);
        out.push(`<rect x="${right - w}" y="${base - 26}" width="${w}" height="36" rx="8" fill="${C.blue}"/>`);
        out.push(`<text x="${right - CHIP_PAD}" y="${base - 1}" ${textAttrs(F.chip, '#000', 'end')}>${xml(t)}</text>`);
        return;
      }
      const f = fontOf(c.kind);
      const fill = c.kind === 'price' ? C.blue : c.kind === 'city' ? C.soft : c.kind === 'muted' ? C.muted : C.text;
      cellLines.forEach((l, k) => out.push(`<text x="${anchor(i)}" y="${base + k * LINE_H + (c.kind === 'price' ? 2 : 0)}" ${textAttrs(f, fill, c.align)}>${xml(l)}</text>`));
    });
    y += heights[r];
    if (r < lines.length - 1) out.push(`<rect x="${PAD + INSET}" y="${y - 1}" width="${cardW - 2 * INSET}" height="1" fill="${C.row}"/>`);
  });
  out.push(`<rect x="${PAD}" y="${TOP}" width="${cardW}" height="${cardH}" rx="22" fill="none" stroke="${C.line}" stroke-width="2"/>`);
  out.push('</svg>');
  return out.join('');
}

/** How the SVG becomes a PNG. Tests swap it to read the table back as text. */
export const render = { png: (svg: string) => svgToPng(svg) };

export function svgToPng(svg: string): Uint8Array {
  const r = new Resvg(svg, { font: { fontFiles: fontFiles(), loadSystemFonts: false, defaultFontFamily: BODY }, background: C.bg });
  return r.render().asPng();
}

/** A state's stations as pictures of at most ROWS_PER_IMAGE rows each, cheapest first. */
export function stateImages(stations: AgentStation[], heading: string, date: string, limit?: number): Uint8Array[] {
  const sorted = [...stations].sort(byPrice).slice(0, limit ?? Infinity);
  const pages = Math.ceil(sorted.length / ROWS_PER_IMAGE);
  const out: Uint8Array[] = [];
  for (let i = 0; i < sorted.length; i += ROWS_PER_IMAGE) {
    const page = pages > 1 ? `page ${i / ROWS_PER_IMAGE + 1} of ${pages}` : undefined;
    out.push(render.png(tableSvg(sorted.slice(i, i + ROWS_PER_IMAGE), { heading, date, page })));
  }
  return out;
}

/** The cheapest station of each state, as pictures. */
export function cheapestImages(stations: AgentStation[], date: string): Uint8Array[] {
  const best = new Map<string, AgentStation>();
  for (const s of stations) {
    const b = best.get(s.state);
    if (!b || byPrice(s, b) < 0) best.set(s.state, s);
  }
  const rows = [...best.values()].sort((a, b) => a.state.localeCompare(b.state));
  const pages = Math.ceil(rows.length / ROWS_PER_IMAGE);
  const out: Uint8Array[] = [];
  for (let i = 0; i < rows.length; i += ROWS_PER_IMAGE) {
    const page = pages > 1 ? `page ${i / ROWS_PER_IMAGE + 1} of ${pages}` : undefined;
    out.push(render.png(tableSvg(rows.slice(i, i + ROWS_PER_IMAGE), { heading: 'Cheapest in each state', date, page }, true)));
  }
  return out;
}
