import { escHtml } from '../../../shared/html.js';
import { US_STATES } from '../../../shared/leads.js';
import type { Db } from '../../../db_storage/db.js';
import { env } from '../../../core/env.js';
import { HttpError } from '../../../core/http.js';
import { SECTION } from '../../../core/home.js';
import { botApi, type PrivateCallback, type PrivateMessage, type TelegramMessage } from '../../../core/telegram.js';
import { firstSight, reportTimeZone } from '../../../core/updates.js';
import {
  CDL_CLASSES, downloadsMenu, exportOf, limits, OWNER_ONLY, picker, RUN_ONCE, runAction, type Action, type Ctx,
} from '../../../tools/driver-leads/actions.js';
import * as m from '../../../tools/driver-leads/messages.js';
import { leadsRole, type ExportKind, type FileFormat } from '../../../tools/driver-leads/store.js';

// Driver Leads in the chat, for admins: which button, command, inline tap or uploaded CSV asks for
// which action (the actions themselves are in tools/driver-leads/actions.ts). Owners also get the
// owner tools. People who are not admins are refused in ../not-allowed.ts.

export const LEADS_COMMAND = { command: 'leads', description: 'Driver Leads: menu' };
export const LEADS_CALLBACK = 'leads:';

/** Button text as typed or tapped, without emoji, punctuation or case. */
const canon = (s: string) => s.replace(/['’]/g, '').replace(/[^A-Za-z ]/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();

const BUTTON_ACTIONS = new Map<string, Action>(
  ([
    [SECTION.leads, { t: 'menu' }],
    [m.BACK, { t: 'menu' }],
    [m.BUTTONS.recent, { t: 'recent' }],
    [m.BUTTONS.stats, { t: 'stats' }],
    [m.KEYS.stats, { t: 'stats' }],
    [m.KEYS.downloads, { t: 'downloads' }],
    [m.BUTTONS.state, { t: 'pickState' }],
    [m.BUTTONS.cdl, { t: 'pickCdl' }],
    [m.BUTTONS.today, exportOf('today')],
    [m.BUTTONS.excel, exportOf('excel')],
    [m.BUTTONS.csv, exportOf('csv', undefined, 'csv')],
    [m.BUTTONS.full, exportOf('full')],
  ] as [string, Action][]).map(([label, action]) => [canon(label), action]),
);

const COMMANDS: Record<string, (args: string[]) => Action> = {
  '/leads': () => ({ t: 'menu' }),
  '/leadshelp': () => ({ t: 'menu' }),
  '/leadstats': () => ({ t: 'stats' }),
  '/resend': () => ({ t: 'resend' }),
  '/leadsync': () => ({ t: 'sync' }),
  '/leadsource': (args) => ({ t: 'sources', args }),
  '/leadsources': (args) => ({ t: 'sources', args }),
  '/optout': (args) => ({ t: 'optout', args }),
  '/state': ([st = '']) => (!st ? { t: 'pickState' } : US_STATES[st.toUpperCase()] ? exportOf('state', st.toUpperCase()) : { t: 'say', text: m.STATE_USAGE }),
  '/cdl': ([c = '']) => (!c ? { t: 'pickCdl' } : CDL_CLASSES.includes(c.toUpperCase()) ? exportOf('cdl', c.toUpperCase()) : { t: 'say', text: m.CDL_USAGE }),
};

/** The Driver Leads action a message asks for, or null when the message belongs to the rest of the bot. */
export function parseAction(msg: TelegramMessage): Action | null {
  if (msg.document) {
    return /\.csv$/i.test(msg.document.file_name ?? '') ? { t: 'import', fileId: msg.document.file_id, caption: (msg.caption ?? '').trim() } : null;
  }
  const text = msg.text?.trim();
  if (!text) return null;

  if (text.startsWith('/')) {
    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();
    // The "next file" link of a long export: /more_<kind>_<filter>_<format>_<after>_<part>
    const more = /^\/more_(today|full|csv|excel|state|cdl)_([a-z0-9]+)_(xlsx|csv)_(\d{1,12})_(\d{1,4})$/.exec(cmd);
    if (more) {
      const kind = more[1] as ExportKind;
      const filter = more[2].toUpperCase();
      if (kind === 'state' && !US_STATES[filter]) return null;
      if (kind === 'cdl' && ![...CDL_CLASSES, 'NA'].includes(filter)) return null;
      return exportOf(kind, kind === 'state' || kind === 'cdl' ? filter : undefined, more[3] as FileFormat, Number(more[4]), Number(more[5]));
    }
    return COMMANDS[cmd]?.(args) ?? null;
  }

  const tapped = BUTTON_ACTIONS.get(canon(text));
  if (tapped) return tapped;
  // Buttons of the state and CDL pickers: "TX · 210", "CDL A · 800", "CDL not given · 12".
  const st = /^([A-Z]{2}) · [\d,]+$/.exec(text);
  if (st && US_STATES[st[1]]) return exportOf('state', st[1]);
  const cdl = /^CDL (A|B|C|not given) · [\d,]+$/.exec(text);
  if (cdl) return exportOf('cdl', cdl[1] === 'not given' ? 'NA' : cdl[1]);
  return null;
}

/**
 * Handles Driver Leads buttons, commands and CSV uploads. Returns true when the message was a leads
 * action (handled or refused), false when it belongs to the rest of the bot.
 */
export async function leadsMessage(db: Db, msg: PrivateMessage, updateId: number | undefined): Promise<boolean> {
  const action = parseAction(msg);
  if (!action) return false;
  const chatId = msg.chat.id;
  const say: Ctx['say'] = async (text, extra = {}) => {
    await botApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  };
  try {
    const role = await leadsRole(db, msg.from.id, env.ownerTelegramIds);
    if (!role) {
      // Stay quiet about files from people who are not admins; answer commands and typed button names.
      if (action.t !== 'import') await say(m.NOT_AUTHORIZED);
      return true;
    }
    if (OWNER_ONLY.has(action.t) && role !== 'owner') {
      await say(m.OWNERS_ONLY);
      return true;
    }
    if (RUN_ONCE.has(action.t) && !(await firstSight(db, updateId))) return true;
    await runAction({ db, chatId, userId: msg.from.id, role, tz: await reportTimeZone(db), deadline: Date.now() + limits.budgetMs, say }, action);
  } catch (e) {
    console.error('leads action failed', action.t, (e as Error).message);
    await say(e instanceof HttpError ? escHtml(e.message) : m.FAILED).catch(() => {});
  }
  return true;
}

/** The Driver Leads action an inline button asks for: a menu to show in place, or a file to send. */
function callbackAction(data: string): { menu: 'dl' | 'states' | 'cdls' } | { action: Action } | null {
  const [, what, arg = ''] = /^leads:([a-z]+)(?::([A-Za-z]+))?$/.exec(data) ?? [];
  if (what === 'dl' || what === 'states' || what === 'cdls') return { menu: what };
  if (what === 'x' && ['today', 'excel', 'csv', 'full'].includes(arg)) return { action: exportOf(arg as ExportKind, undefined, arg === 'csv' ? 'csv' : 'xlsx') };
  if (what === 'st' && US_STATES[arg]) return { action: exportOf('state', arg) };
  if (what === 'cdl' && [...CDL_CLASSES, 'NA'].includes(arg)) return { action: exportOf('cdl', arg) };
  return null;
}

/** Taps on the downloads menu. Menus change the message in place; files arrive as new messages. */
export async function leadsCallback(db: Db, cb: PrivateCallback, updateId: number | undefined): Promise<boolean> {
  if (!cb.data.startsWith(LEADS_CALLBACK)) return false;
  const chatId = cb.message.chat.id;
  const answer = (text?: string) => botApi('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const parsed = callbackAction(cb.data);
  const role = await leadsRole(db, cb.from.id, env.ownerTelegramIds);
  if (!role) {
    await answer(m.NOT_AUTHORIZED.replace(/<[^>]+>/g, ''));
    return true;
  }
  if (!parsed) {
    await answer();
    return true;
  }
  if ('menu' in parsed) {
    const p = parsed.menu === 'dl' ? { text: m.DOWNLOADS, markup: downloadsMenu() } : await picker(db, parsed.menu);
    await botApi('editMessageText', { chat_id: chatId, message_id: cb.message.message_id, text: p.text, parse_mode: 'HTML', reply_markup: p.markup ?? downloadsMenu() }).catch(() => {});
    await answer();
    return true;
  }
  await answer('Preparing the file…');
  if (!(await firstSight(db, updateId))) return true; // Telegram retried the same tap
  const say: Ctx['say'] = async (text, extra = {}) => {
    await botApi('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
  };
  try {
    await runAction({ db, chatId, userId: cb.from.id, role, tz: await reportTimeZone(db), deadline: Date.now() + limits.budgetMs, say }, parsed.action);
  } catch (e) {
    console.error('leads callback failed', cb.data, (e as Error).message);
    await say(m.FAILED).catch(() => {});
  }
  return true;
}

