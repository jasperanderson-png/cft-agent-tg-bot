import { SECTION, hasWorkReports, homeKeyboardFor, hubMenuButton } from '../../../../support/helpers/home.js';
import { env } from '../../../../support/helpers/env.js';
import { botApi } from '../../../../support/helpers/telegram.js';
import { ADMIN_HELP } from '../../../../tools/agent-academy/chat.js';
import { menu as leadsMenu } from '../../../../tools/driver-leads/messages.js';
import { HELP as INDEED_HELP } from '../../../../tools/indeed-applicants/messages.js';
import { SEARCH_HELP } from '../../../../tools/fuel-prices/agent-prices.js';
import { discountCallback, searchMessage } from '../agents/fuel-search.js';
import { commandOf, type RoleHandlers } from '../viewer.js';
import { ACADEMY_ADMIN_COMMANDS, ACADEMY_COMMAND, academyMessage } from './academy.js';
import { FUEL_COMMAND, FUEL_HELP, fuelMessage } from './fuel.js';
import { INDEED_COMMAND, indeedCallback, indeedMessage } from './indeed.js';
import { LEADS_COMMAND, leadsCallback, leadsMessage } from './leads.js';
import { ADD_ADMIN_COMMAND, ADMINS_COMMAND, ADMIN_TEAM_HELP, adminTeamCallback, adminTeamMessage } from './team/admins.js';
import { teamMenuCallback, teamMenuMessage } from './team/menu.js';
import { DESIGN_COMMAND, designMessage } from './system-design.js';
import { DRIVERS_COMMAND, DRIVERS_HELP, INVITE_DRIVER_COMMAND, driverInviteCallback, driverInviteMessage } from '../driver-invites.js';
import { SHIFT_CALLBACK, SHIFT_COMMANDS, SHIFT_HELP, shiftCallback, shiftMessage } from './shift.js';
import { AGENTS_COMMAND, INVITE_COMMAND, TEAM_HELP, teamCallback, teamMessage } from './team/agents.js';

// What CFT administrators (and owners) have in the bot: the home screen with every section, each
// section's buttons and commands, and the agents' price search to see what agents see.
// To give admins a new section: write its file here, add it to SECTIONS, and to message()/callback().

const SECTIONS = [
  { line: `${SECTION.academy} — the Sales Agent knowledge test, its results and reports. /academy`, commands: [ACADEMY_COMMAND, ...ACADEMY_ADMIN_COMMANDS] },
  { line: `${SECTION.leads} — new driver leads, downloads and statistics. /leads`, commands: [LEADS_COMMAND] },
  { line: `${SECTION.indeed} — people who applied to our jobs on Indeed: a card for each in the hiring chat, and the lead-import Excel file. /indeed`, commands: [INDEED_COMMAND] },
  { line: `${SECTION.fuel} — every station's fuel prices from the United Fuel cabinet, as an Excel file. Each download also updates the prices agents see. /fuelprices`, commands: [FUEL_COMMAND] },
  { line: `${SECTION.invite} — send a link to a new agent (sees fuel discounts), a driver (route map) or a new admin. /invite · /invitedriver · /addadmin`, commands: [INVITE_COMMAND, INVITE_DRIVER_COMMAND, ADD_ADMIN_COMMAND] },
  { line: `${SECTION.team} — your agents, drivers and admins: who has access, who invited which driver, remove someone. /agents · /drivers · /admins`, commands: [AGENTS_COMMAND, DRIVERS_COMMAND, ADMINS_COMMAND] },
];
/** Only for the people in TASK_REPORT_USER_IDS. */
const SHIFT_SECTION = { line: `${SECTION.shift} — start and end your shift; the bot posts your work reports to the reports chat. /shift`, commands: SHIFT_COMMANDS };
const DESIGN_SECTION = { line: `${SECTION.design} — a picture of how the bot is built right now. /design`, commands: [DESIGN_COMMAND] };
const sectionsFor = (userId: number) => (hasWorkReports(userId) ? [...SECTIONS, SHIFT_SECTION, DESIGN_SECTION] : SECTIONS);

/** An administrator's command menu: every section's commands, each labelled with its section. */
export const adminMenu = (userId: number) => [
  { command: 'start', description: 'Home: choose a section' },
  ...sectionsFor(userId).flatMap((s) => s.commands),
  { command: 'help', description: 'Help' },
];

const homeText = (userId: number) =>
  [
    '<b>CFT Agent bot</b>',
    'Choose what you need with the buttons below, or open the <b>CFT Hub</b> app with the menu button.',
    ...sectionsFor(userId).flatMap((s) => ['', s.line]),
  ].join('\n');

/** The admins' home: every section, the command menu and the CFT Hub menu button. */
export async function showAdminHome(chat_id: number): Promise<void> {
  await botApi('sendMessage', { chat_id, text: homeText(chat_id), parse_mode: 'HTML', reply_markup: homeKeyboardFor(chat_id) });
  await setAdminMenu(chat_id).catch((e) => console.warn('admin menu not set', chat_id, (e as Error).message));
}

/** The CFT Hub menu button and the admin command menu. Throws when Telegram refuses. */
export async function setAdminMenu(chat_id: number): Promise<void> {
  await botApi('setMyCommands', { commands: adminMenu(chat_id), scope: { type: 'chat', chat_id } });
  if (env.appUrl) await botApi('setChatMenuButton', { chat_id, menu_button: hubMenuButton(env.appUrl) });
}

/** Shift buttons: only for the people with work reports. */
async function shiftTap(db: Parameters<typeof shiftCallback>[0], cb: Parameters<typeof shiftCallback>[1], updateId: number | undefined) {
  if (hasWorkReports(cb.from.id)) return shiftCallback(db, cb, updateId);
  if (!cb.data.startsWith(SHIFT_CALLBACK)) return false;
  await botApi('answerCallbackQuery', { callback_query_id: cb.id, text: 'Not available.' }).catch(() => {});
  return true;
}

export const admins: RoleHandlers = {
  async message(db, msg, who) {
    // First: it also takes channel posts forwarded to the bot. Only for the people with work reports.
    if (hasWorkReports(msg.from.id) && ((await shiftMessage(db, msg)) || (await designMessage(msg)))) return;
    if (await academyMessage(db, msg)) return;
    if (await leadsMessage(db, msg, who.updateId)) return;
    if (await indeedMessage(db, msg)) return;
    if (await fuelMessage(db, msg, who.updateId)) return;
    if (await teamMenuMessage(db, msg, who)) return;
    if (await teamMessage(db, msg)) return;
    if (await adminTeamMessage(db, msg, who)) return;
    if (await driverInviteMessage(db, msg, who)) return;
    if (typeof msg.text !== 'string') return;

    const chat_id = msg.chat.id;
    const reply = (text: string, extra: Record<string, unknown> = {}) => botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', ...extra });
    const cmd = msg.text.trim() === SECTION.home ? '/start' : commandOf(msg.text);
    if (cmd === '/start') {
      await showAdminHome(chat_id);
    } else if (cmd === '/help') {
      const parts = [homeText(chat_id), ADMIN_HELP, leadsMenu(who.owner ? 'owner' : 'admin'), INDEED_HELP, `${FUEL_HELP}\n\n${SEARCH_HELP}`, `${TEAM_HELP}\n\n${DRIVERS_HELP}\n\n${ADMIN_TEAM_HELP}`];
      if (hasWorkReports(chat_id)) parts.push(SHIFT_HELP);
      await reply(parts.join('\n\n'), { reply_markup: homeKeyboardFor(chat_id), disable_web_page_preview: true });
    } else {
      await searchMessage(db, msg, who);
    }
  },

  async callback(db, cb, who) {
    return (
      (await leadsCallback(db, cb, who.updateId)) || (await indeedCallback(db, cb, who.updateId)) || (await discountCallback(db, cb, who)) || (await teamMenuCallback(db, cb, who)) || (await teamCallback(db, cb, who.updateId)) || (await adminTeamCallback(db, cb, who)) || (await driverInviteCallback(db, cb, who)) || (await shiftTap(db, cb, who.updateId))
    );
  },
  menu: (chatId) => setAdminMenu(chatId),
};
