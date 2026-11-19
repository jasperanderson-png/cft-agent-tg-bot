import { US_STATES } from '../../../support/common/discounts.js';
import { escHtml as esc } from '../../../support/common/html.js';
import type { Db } from '../../../database/db.js';
import { env } from '../../../support/helpers/env.js';
import { SECTION } from '../../../support/helpers/home.js';
import { botApi, type PrivateCallback, type PrivateMessage } from '../../../support/helpers/telegram.js';
import { firstSight } from '../../../support/helpers/updates.js';
import { answerSearch, DISCOUNT_CALLBACK, maskBrands, SEARCH_HELP, sendAgentExcel, sendSelection } from '../../../tools/fuel-prices/agent-prices.js';
import type { Viewer } from '../viewer.js';
import { AGENT_DRIVER_BUTTONS, DRIVERS_COMMAND, INVITE_DRIVER_COMMAND } from '../driver-invites.js';

// Fuel discounts in the chat for agents (admins use the same search to see what agents see): the
// agent's home screen, typed searches and the buttons under the answers.

/** An agent's command menu: fuel discounts and their drivers. */
export const AGENT_COMMANDS = [
  { command: 'start', description: 'Find fuel discounts' },
  INVITE_DRIVER_COMMAND,
  DRIVERS_COMMAND,
  { command: 'help', description: 'How to search and invite drivers' },
];
/** The agents' /help: searching, then drivers. */
export const AGENT_HELP = `${SEARCH_HELP}\n\n🚚 <b>Drivers</b>\n/invitedriver — a link that gives a driver the CFT route map (add a name: /invitedriver Night shift). Send it to the driver; when they press Start you get a message.\n/drivers — all drivers, or only yours; remove a driver who joined through your link.`;

export const discountsMenuButton = (appUrl: string) => ({ type: 'web_app', text: 'Discounts', web_app: { url: `${appUrl}/#/discounts` } });

const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const openApp = () => (env.appUrl ? [[{ text: '⛽ Open Discounts', web_app: { url: `${env.appUrl}/#/discounts` } }]] : []);

export const agentWelcome = (name: string | undefined) =>
  [
    `⛽ <b>CFT fuel discounts</b>`, '',
    `Welcome${name ? ', ' + esc(name) : ''}! You can now look up CFT discount prices at partner stations and send them to drivers.`, '',
    SEARCH_HELP, '',
    '🚚 <b>Your drivers:</b> tap <b>Invite a driver</b> for a link that gives a driver the CFT route map (truck routes, CFT prices on the way, navigation). <b>My drivers</b> shows who joined.',
  ].join('\n');

/** The agent's home: what the bot does, the Discounts menu button, the driver buttons and the command menu. */
export async function showAgentHome(chat_id: number, firstName?: string): Promise<void> {
  await send(chat_id, agentWelcome(firstName), { reply_markup: { inline_keyboard: [...openApp(), AGENT_DRIVER_BUTTONS] } });
  await setAgentMenu(chat_id).catch((e) => console.warn('agent menu not set', chat_id, (e as Error).message));
}

/** The Discounts menu button and the agent's command menu. Throws when Telegram refuses. */
export async function setAgentMenu(chat_id: number): Promise<void> {
  if (env.appUrl) await botApi('setChatMenuButton', { chat_id, menu_button: discountsMenuButton(env.appUrl) });
  await botApi('setMyCommands', { commands: AGENT_COMMANDS, scope: { type: 'chat', chat_id } });
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
