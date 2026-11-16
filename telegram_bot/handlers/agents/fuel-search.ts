import { US_STATES } from '../../../shared/discounts.js';
import { escHtml as esc } from '../../../shared/html.js';
import type { Db } from '../../../db_storage/db.js';
import { env } from '../../../core/env.js';
import { SECTION } from '../../../core/home.js';
import { botApi, type PrivateCallback, type PrivateMessage } from '../../../core/telegram.js';
import { firstSight } from '../../../core/updates.js';
import { answerSearch, DISCOUNT_CALLBACK, maskBrands, SEARCH_HELP, sendAgentExcel, sendSelection } from '../../../tools/fuel-prices/agent-prices.js';
import type { Viewer } from '../viewer.js';
import { DRIVER_CALLBACK, INVITE_DRIVER_COMMAND } from '../driver-invites.js';

// Fuel discounts in the chat for agents (admins use the same search to see what agents see): the
// agent's home screen, typed searches and the buttons under the answers.

export const AGENT_COMMANDS = [
  { command: 'start', description: 'Find fuel discounts' },
  { command: 'help', description: 'How to search' },
];
/** An agent's commands: with /invitedriver when an admin allowed them to invite drivers. */
export const agentCommands = (canInviteDrivers = false) => (canInviteDrivers ? [...AGENT_COMMANDS, INVITE_DRIVER_COMMAND] : AGENT_COMMANDS);

export const discountsMenuButton = (appUrl: string) => ({ type: 'web_app', text: 'Discounts', web_app: { url: `${appUrl}/#/discounts` } });

const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const openApp = () => (env.appUrl ? [[{ text: '⛽ Open Discounts', web_app: { url: `${env.appUrl}/#/discounts` } }]] : []);

export const agentWelcome = (name: string | undefined) =>
  [`⛽ <b>CFT fuel discounts</b>`, '', `Welcome${name ? ', ' + esc(name) : ''}! You can now look up CFT discount prices at partner stations and send them to drivers.`, '', SEARCH_HELP].join('\n');

/** The agent's home: what the bot does, the Discounts menu button and the short command menu. */
export async function showAgentHome(chat_id: number, firstName?: string, canInviteDrivers = false): Promise<void> {
  const rows = [...openApp(), ...(canInviteDrivers ? [[{ text: '🚚 Invite a driver', callback_data: `${DRIVER_CALLBACK}new` }]] : [])];
  await send(chat_id, agentWelcome(firstName), { reply_markup: rows.length ? { inline_keyboard: rows } : { remove_keyboard: true } });
  await setAgentMenu(chat_id, canInviteDrivers).catch((e) => console.warn('agent menu not set', chat_id, (e as Error).message));
}

/** The Discounts menu button and the agent's command menu. Throws when Telegram refuses. */
export async function setAgentMenu(chat_id: number, canInviteDrivers = false): Promise<void> {
  if (env.appUrl) await botApi('setChatMenuButton', { chat_id, menu_button: discountsMenuButton(env.appUrl) });
  await botApi('setMyCommands', { commands: agentCommands(canInviteDrivers), scope: { type: 'chat', chat_id } });
}

const SECTION_TEXTS = new Set<string>(Object.values(SECTION));

/** A typed search. False when the message is not one (a command, a section button, a file…). */
export async function searchMessage(db: Db, msg: PrivateMessage, who: Viewer): Promise<boolean> {
  const text = msg.text?.trim();
  if (!text || text.startsWith('/') || SECTION_TEXTS.has(text) || text.length > 1000) return false;
  await answerSearch(db, msg.chat.id, text, who.admin);
  return true;
}

/** The buttons under search answers: "All N in …", a state picked from two, and the Excel file. */
export async function discountCallback(db: Db, cb: PrivateCallback, who: Viewer): Promise<boolean> {
  if (!cb.data.startsWith(DISCOUNT_CALLBACK)) return false;
  const answer = (text?: string) => botApi('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const [kind, codes = '', m = '15'] = cb.data.slice(DISCOUNT_CALLBACK.length).split(':');
  const states = (codes.match(/[A-Z]{2}/g) ?? []).filter((s) => US_STATES[s]);
  const brands = maskBrands(Number(m) & 15);
  const chat_id = cb.message.chat.id;
  if (!(await firstSight(db, who.updateId))) return true;
  await answer();
  if (kind === 'all' && states.length) await sendSelection(db, chat_id, { states, brands }, { admin: who.admin });
  else if (kind === 's' && states.length) await sendSelection(db, chat_id, { states, brands }, { quick: true, admin: who.admin });
  else if (kind === 'x') await sendAgentExcel(db, chat_id, { states, brands });
  return true;
}
