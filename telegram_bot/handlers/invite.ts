import { escHtml as esc } from '../../support/common/html.js';
import { ADMIN_INVITE_PREFIX, redeemAdminInvite } from '../../support/helpers/admin-invites.js';
import { INVITE_PREFIX, redeemInvite } from '../../support/helpers/agents.js';
import { DRIVER_INVITE_PREFIX, redeemDriverInvite } from '../../support/helpers/drivers.js';
import { showDriverHome } from './drivers/index.js';
import { DRIVER_CALLBACK } from './driver-invites.js';
import { botApi, fullName, type PrivateMessage } from '../../support/helpers/telegram.js';
import { showAdminHome } from './admins/index.js';
import { showAgentHome } from './agents/fuel-search.js';
import type { Viewer } from './viewer.js';
import { getPool } from '../../database/db.js';
import { refCode } from '../../support/helpers/driver-requests.js';
import { beginRequest } from './driver-requests.js';

// Invite links (t.me/<bot>?start=agent_<token>, driver_<token> or admin_<token>). Anyone can open one, whatever
// their role, so they are answered before the role folders.

const INVITE_USED = '🔗 This invite link has expired or was turned off. Ask your CFT admin for a new one.';
const DRIVER_INVITE_USED = '🔗 This driver link has expired or was turned off. Ask CFT for a new one.';
const ADMIN_INVITE_USED = '🔗 This admin invite link was already used, has expired or was turned off. Ask a CFT owner for a new one.';

export interface Invite {
  kind: 'agent' | 'driver' | 'admin';
  token: string;
}

/** The invite in "/start agent_<token>", "/start driver_<token>" or "/start admin_<token>", or null for any other message. */
export function inviteToken(text: string | undefined): Invite | null {
  const [first = '', payload = ''] = (text ?? '').trim().split(/\s+/);
  if (first.split('@')[0].toLowerCase() !== '/start') return null;
  if (payload.startsWith(INVITE_PREFIX)) return { kind: 'agent', token: payload.slice(INVITE_PREFIX.length) };
  if (payload.startsWith(DRIVER_INVITE_PREFIX)) return { kind: 'driver', token: payload.slice(DRIVER_INVITE_PREFIX.length) };
  if (payload.startsWith(ADMIN_INVITE_PREFIX)) return { kind: 'admin', token: payload.slice(ADMIN_INVITE_PREFIX.length) };
  return null;
}

const nameOf = (msg: PrivateMessage) =>
  `<b>${esc(fullName(msg.from) || 'Someone')}</b>${msg.from.username ? ' @' + esc(msg.from.username) : ''}`;

export async function joinWithInvite(msg: PrivateMessage, invite: Invite, who: Viewer): Promise<void> {
  if (invite.kind === 'admin') return joinAsAdmin(msg, invite.token, who);
  if (invite.kind === 'driver') return joinAsDriver(msg, invite.token, who);
  const chat_id = msg.chat.id;
  const r = await redeemInvite(msg.from, invite.token, who.admin);
  if (!r.ok) {
    if (r.reason === 'admin') await botApi('sendMessage', { chat_id, text: 'You are already a CFT admin, so this invite link was not used. Send it to the agent it is meant for.' });
    else if (r.reason === 'already') await showAgentHome(chat_id, msg.from.first_name);
    else await botApi('sendMessage', { chat_id, text: INVITE_USED });
    return;
  }
  await showAgentHome(chat_id, msg.from.first_name);
  if (r.inviterChat) {
    await botApi('sendMessage', {
      chat_id: r.inviterChat,
      parse_mode: 'HTML',
      text: `✅ ${nameOf(msg)} joined as an agent${r.label ? ` (link “${esc(r.label)}”)` : ''}. They can now see fuel discounts. /agents`,
    }).catch(() => {});
  }
}

async function joinAsDriver(msg: PrivateMessage, token: string, who: Viewer): Promise<void> {
  const chat_id = msg.chat.id;
  const r = await redeemDriverInvite(msg.from, token, who.admin || who.agent);
  if (!r.ok) {
    // An agent's driver link: a request with that agent as the inviter, approved by an admin.
    if (r.reason === 'request') return beginRequest(getPool(), msg, who, await refCode(getPool(), { agentId: r.agentId }), 'bot');
    if (r.reason === 'staff') await botApi('sendMessage', { chat_id, text: 'You are already CFT staff and have the route map (📍 on Find discounts, or the Hub). This driver link was not used: send it to the driver it is meant for.' });
    else if (r.reason === 'already') await showDriverHome(chat_id, msg.from.first_name);
    else await botApi('sendMessage', { chat_id, text: DRIVER_INVITE_USED });
    return;
  }
  await showDriverHome(chat_id, msg.from.first_name);
  if (r.inviterChat) {
    await botApi('sendMessage', {
      chat_id: r.inviterChat,
      parse_mode: 'HTML',
      text: `✅ ${nameOf(msg)} joined as a driver${r.label ? ` (link “${esc(r.label)}”)` : ''}. They now have the CFT route map.`,
      reply_markup: { inline_keyboard: [[{ text: '👤 My drivers', callback_data: `${DRIVER_CALLBACK}list:mine` }]] },
    }).catch(() => {});
  }
}

async function joinAsAdmin(msg: PrivateMessage, token: string, who: Viewer): Promise<void> {
  const chat_id = msg.chat.id;
  const r = await redeemAdminInvite(msg.from, token, who.admin);
  if (!r.ok) {
    if (r.reason === 'already') {
      await botApi('sendMessage', { chat_id, text: 'You are already a CFT admin, so this link was not used. Send it to the person it is meant for.' });
      await showAdminHome(chat_id);
    } else await botApi('sendMessage', { chat_id, text: ADMIN_INVITE_USED });
    return;
  }
  await botApi('sendMessage', { chat_id, text: `🛡 Welcome${msg.from.first_name ? ', ' + msg.from.first_name : ''}! You are now a CFT admin.` });
  await showAdminHome(chat_id);
  if (r.inviterChat) {
    await botApi('sendMessage', {
      chat_id: r.inviterChat,
      parse_mode: 'HTML',
      text: `✅ ${nameOf(msg)} joined as an admin${r.label ? ` (link “${esc(r.label)}”)` : ''}. /admins`,
    }).catch(() => {});
  }
}
