import { SECTION } from '../../../support/helpers/home.js';
import { botApi } from '../../../support/helpers/telegram.js';
import { CANDIDATE_HELP, showAcademy } from '../../../tools/agent-academy/chat.js';
import { refuseAdminCallback, refuseAdminMessage, refuseAgentCallback } from '../not-allowed.js';
import { commandOf, type RoleHandlers } from '../viewer.js';
import { academyMessage } from './academy.js';

// Everyone who is neither an admin nor an agent: Sales Agent candidates. They only have the test,
// and are never shown anything about the other sections.

/** The command menu of someone who only takes the test (the bot's default menu). */
export const CANDIDATE_COMMANDS = [
  { command: 'start', description: 'Open the Sales Agent assessment' },
  { command: 'help', description: 'How this bot works' },
];

export const candidates: RoleHandlers = {
  async message(_db, msg) {
    if (await academyMessage(msg)) return;
    if (await refuseAdminMessage(msg)) return;
    if (typeof msg.text !== 'string') return;
    const chat_id = msg.chat.id;
    const cmd = msg.text.trim() === SECTION.home ? '/start' : commandOf(msg.text);
    if (cmd === '/start') {
      await showAcademy(chat_id, false); // candidates go straight to the test
      // Someone who was an admin earlier keeps nothing of it: back to the default "Start test" button.
      await botApi('setChatMenuButton', { chat_id, menu_button: { type: 'default' } }).catch(() => {});
    } else if (cmd === '/help') {
      await botApi('sendMessage', { chat_id, text: CANDIDATE_HELP, parse_mode: 'HTML' });
    }
  },

  async callback(_db, cb) {
    return (await refuseAdminCallback(cb)) || (await refuseAgentCallback(cb));
  },
  /** The bot's default menu button ("Start test") and commands. */
  async menu(chat_id) {
    await botApi('setChatMenuButton', { chat_id, menu_button: { type: 'default' } });
    await botApi('deleteMyCommands', { scope: { type: 'chat', chat_id } });
  },
};
