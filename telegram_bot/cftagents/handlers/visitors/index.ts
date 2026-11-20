import { botUsername } from '../../../../support/helpers/agents.js';
import { REQUEST_PREFIX } from '../../../../support/helpers/driver-requests.js';
import { env } from '../../../../support/helpers/env.js';
import { SECTION } from '../../../../support/helpers/home.js';
import { botApi } from '../../../../support/helpers/telegram.js';
import { ACADEMY_ADMIN_ONLY } from '../admins/academy.js';
import { refuseAdminCallback, refuseAdminMessage, refuseAgentCallback } from '../not-allowed.js';
import { commandOf, type RoleHandlers } from '../viewer.js';

// Everyone in @cft_Agentbot who is not an admin, agent or driver (yet). This bot has no test and no
// candidates: a visitor can only ask for driver access (../driver-requests.ts). Sales Agent candidates
// are sent to the Academy's own bot (telegram_bot/cftacademy/).

/** The bot's default command menu, for visitors. */
export const VISITOR_COMMANDS = [
  { command: 'start', description: 'Start: request access' },
  { command: 'help', description: 'How this bot works' },
];

const say = (chat_id: number, text: string, extra: Record<string, unknown> = {}) => botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

/** What a visitor sees: request driver access, or the Academy bot for Sales Agent candidates. */
async function welcome(chat_id: number): Promise<void> {
  const academy = env.academyBotUsername;
  const text =
    '👋 <b>CFT Agent bot</b>\n\nThis bot is for CFT agents and drivers.\n\n' +
    '🚚 <b>Drivers:</b> tap <b>Request access</b> to get the CFT route map: truck routes, partner stations with the CFT fuel price, and navigation. A CFT admin approves each request.' +
    (academy ? `\n\n🎓 <b>Applying to be a Sales Agent?</b> The test is in @${academy}.` : '');
  const self = await botUsername().catch(() => null); // without it, the welcome still goes out
  const rows = self ? [[{ text: '🚚 Request access', url: `https://t.me/${self}?start=${REQUEST_PREFIX}` }]] : [];
  if (academy) rows.push([{ text: '🎓 Sales Agent test', url: `https://t.me/${academy}` }]);
  await say(chat_id, text, { reply_markup: { inline_keyboard: rows } });
}

export const visitors: RoleHandlers = {
  async message(_db, msg) {
    if (await refuseAdminMessage(msg)) return;
    if (typeof msg.text !== 'string') return;
    const text = msg.text.trim();
    const cmd = text === SECTION.home || text === SECTION.academy ? '/start' : commandOf(text);
    if (ACADEMY_ADMIN_ONLY.includes(cmd)) await say(msg.chat.id, 'This command is for CFT administrators.');
    else if (['/start', '/help', '/academy', '/test'].includes(cmd)) {
      await welcome(msg.chat.id);
      // Someone who was an admin or agent earlier keeps nothing of it: back to the default menu.
      if (cmd === '/start') await botApi('setChatMenuButton', { chat_id: msg.chat.id, menu_button: { type: 'default' } }).catch(() => {});
    }
  },
  async callback(_db, cb) {
    return (await refuseAdminCallback(cb)) || (await refuseAgentCallback(cb));
  },
  /** The bot's default menu: the command list (no app button). */
  async menu(chat_id) {
    await botApi('setChatMenuButton', { chat_id, menu_button: { type: 'default' } });
    await botApi('deleteMyCommands', { scope: { type: 'chat', chat_id } });
  },
};
