import { escHtml as esc } from '../../../support/common/html.js';
import { DRIVER_MAP } from '../../../support/common/driver-config.js';
import { env } from '../../../support/helpers/env.js';
import { botApi } from '../../../support/helpers/telegram.js';
import { refuseAdminCallback, refuseAdminMessage, refuseAgentCallback } from '../not-allowed.js';
import { commandOf, type RoleHandlers } from '../viewer.js';

// What drivers (people who joined through a driver link) have in the bot: the CFT route map, opened
// with the "Route map" menu button or the button under the welcome. Nothing else.

export const DRIVER_COMMANDS = [
  { command: 'start', description: 'Open the CFT route map' },
  { command: 'help', description: 'How the route map works' },
];

export const routeMapUrl = () => `${env.appUrl}/route`;
export const routeMenuButton = () => ({ type: 'web_app', text: 'Route map', web_app: { url: routeMapUrl() } });
const openMap = () => (env.appUrl ? { inline_keyboard: [[{ text: '🗺 Open the route map', web_app: { url: routeMapUrl() } }]] } : undefined);

const DRIVER_HELP = [
  '🗺 <b>CFT route map</b>',
  '',
  '1. Open the map with the <b>Route map</b> button.',
  '2. Type where you are going and pick the place.',
  '3. The map shows a truck route and CFT partner stations on the way (Pilot / Flying J, Love\'s, TA / Petro, Speedway) with your CFT price. The cheapest one is picked for you.',
  '4. Press <b>Navigate</b>: turn-by-turn directions with street names and voice.',
  '',
  'Set your truck\'s height and weight once (the chip under the address): routes then avoid low bridges and roads closed to trucks where the map knows them. Add how many miles you can still drive before empty, and the map shows which stations you can reach. Always follow road signs.',
  '',
  `📍 <b>Alerts on the road:</b> share your <b>live</b> location in this chat (📎 → Location → Share My Live Location) and I'll tell you when a CFT station is within ${DRIVER_MAP.alerts.aheadMi} mi ahead.`,
].join('\n');

/** The driver's home: what they can do, the map button, the Route map menu button and commands. */
export async function showDriverHome(chat_id: number, firstName?: string): Promise<void> {
  const text = [`🚚 <b>CFT route map</b>`, '', `Welcome${firstName ? ', ' + esc(firstName) : ''}! Plan a truck route and see CFT partner stations on the way with your CFT fuel price, then navigate to the cheapest one.`].join('\n');
  await botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', reply_markup: openMap() ?? { remove_keyboard: true } });
  await setDriverMenu(chat_id);
}

/** The Route map menu button and the short command menu. Throws when Telegram refuses. */
export async function setDriverMenu(chat_id: number): Promise<void> {
  if (env.appUrl) await botApi('setChatMenuButton', { chat_id, menu_button: routeMenuButton() });
  await botApi('setMyCommands', { commands: DRIVER_COMMANDS, scope: { type: 'chat', chat_id } });
}

export const drivers: RoleHandlers = {
  async message(_db, msg) {
    if (await refuseAdminMessage(msg)) return;
    if (typeof msg.text !== 'string') return;
    const cmd = commandOf(msg.text);
    if (cmd === '/start') await showDriverHome(msg.chat.id, msg.from.first_name);
    else if (cmd === '/help') await botApi('sendMessage', { chat_id: msg.chat.id, text: DRIVER_HELP, parse_mode: 'HTML', reply_markup: openMap() });
    else await botApi('sendMessage', { chat_id: msg.chat.id, text: 'Open the CFT route map with the button below (or the Route map button next to the message field).', reply_markup: openMap() });
  },
  async callback(_db, cb) {
    return (await refuseAdminCallback(cb)) || (await refuseAgentCallback(cb));
  },
  menu: (chat_id) => setDriverMenu(chat_id),
};
