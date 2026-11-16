import { SECTION } from '../../../core/home.js';
import { botApi } from '../../../core/telegram.js';
import { SEARCH_HELP } from '../../../tools/fuel-prices/agent-prices.js';
import { refuseAdminCallback, refuseAdminMessage } from '../not-allowed.js';
import { commandOf, type RoleHandlers } from '../viewer.js';
import { discountCallback, searchMessage, setAgentMenu, showAgentHome } from './fuel-search.js';
import { driverInviteCallback, driverInviteMessage } from '../driver-invites.js';

// What agents (people who joined through an invite link) have in the bot: fuel discount prices.
// They type a state or a station and get tables to forward to drivers. Nothing else: no Academy,
// no Driver Leads "for now".

export const agents: RoleHandlers = {
  async message(db, msg, who) {
    if (await refuseAdminMessage(msg)) return;
    if (await driverInviteMessage(db, msg, who)) return;
    if (typeof msg.text !== 'string') return;
    const cmd = msg.text.trim() === SECTION.home ? '/start' : commandOf(msg.text);
    if (cmd === '/start') await showAgentHome(msg.chat.id, msg.from.first_name, who.canInviteDrivers);
    else if (cmd === '/help') await botApi('sendMessage', { chat_id: msg.chat.id, text: SEARCH_HELP, parse_mode: 'HTML' });
    else await searchMessage(db, msg, who);
  },

  async callback(db, cb, who) {
    return (await driverInviteCallback(db, cb, who)) || (await refuseAdminCallback(cb)) || (await discountCallback(db, cb, who));
  },
  menu: (chatId, who) => setAgentMenu(chatId, who.canInviteDrivers),
};
