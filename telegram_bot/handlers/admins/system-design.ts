import { Resvg } from '@resvg/resvg-js';
import { escXml as xml } from '../../../shared/html.js';
import { brandFile, LOGO_RATIO, logoDataUri } from '../../../core/brand.js';
import { SECTION } from '../../../core/home.js';
import { botApi, botSendPhoto, type PrivateMessage } from '../../../core/telegram.js';
import { TOOLS } from '../../server/tools.js';
import { commandOf } from '../viewer.js';

// 🧩 System Design, for the developer (TASK_REPORT_USER_IDS): a picture of how the bot is built right
// now, in the CFT look. The tools come from telegram_bot/server/tools.ts, so a new tool shows up by
// itself; give it a line in TOOL_INFO.

export const DESIGN_COMMAND = { command: 'design', description: 'System design: how the bot is built' };

const TOOL_INFO: Record<string, { name: string; what: string }> = {
  'agent-academy': { name: 'Agent Academy', what: 'The Sales Agent test, grading, results, Excel and the Monday summary' },
  'driver-leads': { name: 'Driver Leads', what: 'Sign-up page, vendor webhooks, daily FMCSA sync, each lead sent once' },
  'fuel-prices': { name: 'Fuel prices', what: 'United Fuel cabinet, the Excel of every station, agent prices minus the margin' },
  'driver-map': { name: 'Driver map', what: 'Partner stations on a map, the cheapest along a truck route, directions and voice' },
  agents: { name: 'Agents', what: 'Invite links and the agent list' },
  'task-report': { name: 'Task report', what: 'Shifts, the work log, daily / weekly / monthly reports to the chat' },
};
const ROLES = [
  { name: 'Admins', what: 'Home, Academy console, Driver Leads, fuel prices, agent and admin invites; you also have Shift and this picture' },
  { name: 'Agents', what: 'Type a state or station, get discount price tables to forward to drivers' },
  { name: 'Candidates', what: 'Only the Sales Agent test, in the Mini App' },
  { name: 'Drivers', what: 'Empty for now: ready for when drivers talk to the bot' },
];
const BASE = [
  { name: 'core/', what: 'Settings, the Telegram connection, who is admin or agent, brand fonts and logo' },
  { name: 'db_storage/', what: 'The Postgres database (Supabase): connection, migrations, Academy questions' },
  { name: 'shared/', what: 'Dates, grading, CSV and types, used by the server and the Mini App' },
];
const OUTSIDE = [
  { name: 'Telegram', what: 'The bot, the Mini App, the reports chat' },
  { name: 'Vercel', what: 'Hosting and 3 daily jobs (leads, Monday summary, reports)' },
  { name: 'Supabase', what: 'The Postgres database' },
  { name: 'United Fuel', what: 'The fuel price cabinet' },
  { name: 'FMCSA', what: 'The US carrier registry (new leads)' },
];

const C = { bg: '#000', card: '#121416', line: 'rgba(255,255,255,0.1)', ink: '#202c33', blue: '#a0dcff', text: '#fff', soft: '#ccc', muted: '#8f8f8f' };
const W = 1080;
const PAD = 56;
const T = (x: number, y: number, t: string, size: number, o: { w?: number; fill?: string; anchor?: string; cond?: boolean } = {}) =>
  `<text x="${x}" y="${y}" font-family="${o.cond ? 'Fira Sans Condensed' : 'Fira Sans'}" font-weight="${o.w ?? 400}" font-size="${size}" fill="${o.fill ?? C.text}" text-anchor="${o.anchor ?? 'start'}">${xml(t)}</text>`;
/** Wraps by an average letter width; the texts here are short and known. */
function wrap(t: string, maxPx: number, size: number): string[] {
  const per = Math.floor(maxPx / (size * 0.53));
  const out: string[] = [];
  let line = '';
  for (const w of t.split(' ')) {
    if (line && (line + ' ' + w).length > per) {
      out.push(line);
      line = w;
    } else line = line ? line + ' ' + w : w;
  }
  return [...out, line];
}

interface Box { name: string; what: string }
/** A layer: a title, a note, and its boxes in `cols` columns. Returns [svg, height]. */
function layer(y: number, title: string, note: string, boxes: Box[], cols: number): [string, number] {
  const gap = 16;
  const bw = (W - 2 * PAD - 48 - gap * (cols - 1)) / cols;
  const sized = boxes.map((b) => ({ ...b, lines: wrap(b.what, bw - 36, 21) }));
  const rowHeights: number[] = [];
  sized.forEach((b, i) => {
    const r = Math.floor(i / cols);
    rowHeights[r] = Math.max(rowHeights[r] ?? 0, 74 + b.lines.length * 28);
  });
  const boxesH = rowHeights.reduce((s, h) => s + h, 0) + gap * (rowHeights.length - 1);
  const h = 118 + boxesH + 24;
  const out = [
    `<rect x="${PAD}" y="${y}" width="${W - 2 * PAD}" height="${h}" rx="22" fill="${C.card}" stroke="${C.line}" stroke-width="2"/>`,
    `<rect x="${PAD + 24}" y="${y + 34}" width="6" height="30" rx="3" fill="${C.blue}"/>`,
    T(PAD + 44, y + 59, title, 32, { w: 700, cond: true }),
    T(PAD + 24, y + 96, note, 21, { fill: C.muted }),
  ];
  let by = y + 118;
  rowHeights.forEach((rh, r) => {
    sized.slice(r * cols, r * cols + cols).forEach((b, c) => {
      const bx = PAD + 24 + c * (bw + gap);
      out.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${rh}" rx="14" fill="rgba(160,220,255,0.05)" stroke="${C.line}" stroke-width="2"/>`);
      out.push(T(bx + 18, by + 38, b.name, 25, { w: 600, fill: C.blue }));
      b.lines.forEach((l, i) => out.push(T(bx + 18, by + 72 + i * 28, l, 21, { fill: C.soft })));
    });
    by += rh + gap;
  });
  return [out.join(''), h];
}
const arrow = (y: number, label: string) =>
  `<line x1="${W / 2}" y1="${y + 8}" x2="${W / 2}" y2="${y + 44}" stroke="${C.blue}" stroke-width="3"/><path d="M ${W / 2 - 10} ${y + 36} L ${W / 2} ${y + 50} L ${W / 2 + 10} ${y + 36}" fill="none" stroke="${C.blue}" stroke-width="3"/>` +
  T(W / 2 + 24, y + 36, label, 20, { fill: C.muted });

export function systemDesignSvg(): string {
  const parts: string[] = [
    `<image href="${logoDataUri()}" x="${PAD}" y="${PAD}" height="30" width="${Math.round(30 * LOGO_RATIO)}"/>`,
    `<rect x="${W - PAD - 210}" y="${PAD - 2}" width="210" height="36" rx="18" fill="rgba(160,220,255,0.10)" stroke="rgba(160,220,255,0.25)"/>`,
    T(W - PAD - 105, PAD + 23, 'SYSTEM DESIGN', 20, { w: 600, fill: C.blue, anchor: 'middle' }),
    T(PAD, 168, 'CFT Agent bot', 76, { w: 700, cond: true }),
    T(PAD, 212, 'One bot · one Mini App · one database · one deploy', 28, { fill: C.soft }),
  ];
  let y = 250;
  const add = (svg: string, h: number) => {
    parts.push(svg);
    y += h;
  };
  add(...layer(y, 'WHO can do what · telegram_bot/', 'The front door works out who is writing; that role’s folder answers.', ROLES, 2));
  add(arrow(y, 'asks the tools'), 60);
  const tools = TOOLS.map((t) => TOOL_INFO[t.id] ?? { name: t.id, what: '—' });
  add(...layer(y, 'WHAT the business does · tools/ · task_report/', 'Each tool: its data, rules and what it sends. Never decides who may ask.', tools, 2));
  add(arrow(y, 'imports only go down'), 60);
  add(...layer(y, 'The base · core/ · db_storage/ · shared/', 'Plumbing every part uses.', BASE, 1));
  add(arrow(y, 'talks to'), 60);
  add(...layer(y, 'Outside services', 'Everything runs on free plans.', OUTSIDE, 2));
  const mini = 'The Mini App (telegram_bot/mini_app) has its screens grouped the same way: admins, agents, candidates.';
  wrap(mini, W - 2 * PAD, 21).forEach((l, i) => parts.push(T(PAD, y + 30 + i * 28, l, 21, { fill: C.muted })));
  y += 90;
  const h = y + 20;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${h}" viewBox="0 0 ${W} ${h}"><defs><radialGradient id="g" cx="0.1" cy="0" r="0.8"><stop offset="0" stop-color="${C.blue}" stop-opacity="0.3"/><stop offset="1" stop-color="${C.blue}" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${h}" fill="${C.bg}"/><rect width="${W}" height="620" fill="url(#g)"/>${parts.join('')}</svg>`;
}

export const designRender = {
  png: (svg: string) =>
    new Resvg(svg, { font: { fontFiles: ['FiraSans-Regular.ttf', 'FiraSans-SemiBold.ttf', 'FiraSansCondensed-Bold.ttf'].map(brandFile), loadSystemFonts: false, defaultFontFamily: 'Fira Sans' }, fitTo: { mode: 'width', value: W } }).render().asPng(),
};

const CAPTION = [
  '🧩 <b>System design</b> · how the bot is built now',
  '',
  '<b>WHO</b> (telegram_bot/): works out whether you are an admin, agent or candidate; that role’s folder decides what you can do.',
  '<b>WHAT</b> (tools/, task_report/): the business itself, one folder per tool.',
  '<b>BASE</b> (core/, db_storage/, shared/): settings, the database, shared helpers.',
  '',
  'Rule that keeps it growing safely: imports only go down. A new tool = one folder + one line; a new role = one folder.',
].join('\n');

/** 🧩 System Design and /design. */
export async function designMessage(msg: PrivateMessage): Promise<boolean> {
  const text = msg.text?.trim() ?? '';
  if (text !== SECTION.design && commandOf(text) !== '/design') return false;
  await botApi('sendChatAction', { chat_id: msg.chat.id, action: 'upload_photo' }).catch(() => {});
  await botSendPhoto(msg.chat.id, designRender.png(systemDesignSvg()), CAPTION, { filename: 'system-design.png' });
  return true;
}
