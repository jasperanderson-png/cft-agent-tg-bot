import { listAdmins } from '../../../core/admin-invites.js';
import { listAgents } from '../../../core/agents.js';
import { listDrivers } from '../../../core/drivers.js';
import { DRIVER_CALLBACK } from '../driver-invites.js';
import { OLD_AGENTS_BUTTON, SECTION } from '../../../core/home.js';
import { botApi, type PrivateCallback, type PrivateMessage } from '../../../core/telegram.js';
import type { Db } from '../../../db_storage/db.js';
import type { Viewer } from '../viewer.js';
import { ADMIN_TEAM_CALLBACK } from './admin-team.js';
import { agentsText, TEAM_CALLBACK } from './team.js';

// The two home buttons for people: ➕ Invite (who is the link for: an agent or an admin?) and
// 👥 Team (how many agents and admins there are, and a way into each list). The links and lists
// themselves are in team.ts (agents) and admin-team.ts (admins).

const CB = 'tm:';
const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });

function inviteChoice(owner: boolean) {
  const lines = [
    '➕ <b>Invite someone</b>',
    '',
    'Who is the link for?',
    '',
    '👤 <b>Agent</b> — sees CFT fuel discount prices. One link works for everyone you send it to.',
    '🚚 <b>Driver</b> — gets the CFT route map: truck routes, partner stations with the CFT price, navigation.',
    '🛡 <b>Admin</b> — runs the bot: Academy, Driver Leads, fuel prices and agents. One link makes one person an admin.',
  ];
  if (!owner) lines.push('', '<i>Only owners can invite admins.</i>');
  const row = [{ text: '👤 Agent', callback_data: `${TEAM_CALLBACK}new` }, { text: '🚚 Driver', callback_data: `${DRIVER_CALLBACK}new` }];
  if (owner) row.push({ text: '🛡 Admin', callback_data: `${ADMIN_TEAM_CALLBACK}new` });
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: [row] } };
}

async function teamView(db: Db) {
  const [{ agents, invites }, { admins, links }, d] = await Promise.all([listAgents(db), listAdmins(db), listDrivers(db)]);
  const open = invites.length + links.length + d.links;
  const lines = [
    '👥 <b>Team</b>',
    '',
    `👤 Agents: <b>${agents.length}</b>`,
    `🚚 Drivers: <b>${d.drivers.length}</b>`,
    `🛡 Admins: <b>${admins.length}</b>`,
    ...(open ? [`🔗 Invite links still open: <b>${open}</b>`] : []),
    '',
    'Open a list to see who has access, let agents invite drivers, turn a link off or remove someone.',
  ];
  return {
    text: lines.join('\n'),
    reply_markup: {
      inline_keyboard: [
        [{ text: `👤 Agents · ${agents.length}`, callback_data: `${CB}agents` }, { text: `🚚 Drivers · ${d.drivers.length}`, callback_data: `${DRIVER_CALLBACK}list` }],
        [{ text: `🛡 Admins · ${admins.length}`, callback_data: `${ADMIN_TEAM_CALLBACK}list` }, { text: '➕ Invite someone', callback_data: `${CB}invite` }],
      ],
    },
  };
}

/** The ➕ Invite and 👥 Team buttons (and 👥 Agents on keyboards sent before them). */
export async function teamMenuMessage(db: Db, msg: PrivateMessage, who: Viewer): Promise<boolean> {
  const text = msg.text?.trim();
  if (text === SECTION.invite) {
    const v = inviteChoice(who.owner);
    await send(msg.chat.id, v.text, { reply_markup: v.reply_markup });
  } else if (text === SECTION.team || text === OLD_AGENTS_BUTTON) {
    const v = await teamView(db);
    await send(msg.chat.id, v.text, { reply_markup: v.reply_markup });
  } else return false;
  return true;
}

export async function teamMenuCallback(db: Db, cb: PrivateCallback, who: Viewer): Promise<boolean> {
  if (!cb.data.startsWith(CB)) return false;
  await botApi('answerCallbackQuery', { callback_query_id: cb.id }).catch(() => {});
  const kind = cb.data.slice(CB.length);
  const v = kind === 'agents' ? await agentsText(db) : kind === 'invite' ? inviteChoice(who.owner) : null;
  if (v) await send(cb.message.chat.id, v.text, { reply_markup: v.reply_markup });
  return true;
}
