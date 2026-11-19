import { escHtml as esc } from '../../support/common/html.js';
import { fmtDMY } from '../../support/common/time.js';
import { personalLinks } from '../../support/helpers/driver-requests.js';
import { env } from '../../support/helpers/env.js';
import { telegramAdmin } from '../../support/helpers/admins.js';
import { listDrivers, removeDriver, revokeDriverInvite, type Actor, type DriverRow } from '../../support/helpers/drivers.js';
import type { Db } from '../../database/db.js';
import { HttpError, UUID_RE } from '../../support/helpers/http.js';
import { botApi, type PrivateCallback, type PrivateMessage } from '../../support/helpers/telegram.js';
import { firstSight, reportTimeZone } from '../../support/helpers/updates.js';
import { commandOf, type Viewer } from './viewer.js';

// Driver links in the chat, for admins and every agent: their two personal links (Telegram and the
// website), the drivers, and removing one. A driver who opens an agent's link requests access and an
// admin approves it; an admin's own link gives access at once (support/helpers/driver-requests.ts).
// Agents see all drivers (or only their own: "My drivers") and remove only those they brought; admins
// remove anyone. Drivers get the route map only (handlers/drivers/). Driver links made before requests
// keep working until they expire, and can still be turned off.

export const DRIVER_CALLBACK = 'drv:';
const CB = DRIVER_CALLBACK;
export const INVITE_DRIVER_COMMAND = { command: 'invitedriver', description: 'Drivers: your driver links (Telegram and website)' };
export const DRIVERS_COMMAND = { command: 'drivers', description: 'Drivers: see your drivers and remove one' };
export const DRIVERS_HELP = '🚚 <b>Drivers</b>\n/invitedriver — your two driver links (Telegram and website) for the CFT route map\n/drivers — see drivers and remove one';
/** The agents' home buttons: a driver link in two taps, their drivers in one. */
export const AGENT_DRIVER_BUTTONS = [{ text: '🚚 Invite a driver', callback_data: `${CB}new` }, { text: '👤 My drivers', callback_data: `${CB}list:mine` }];
const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const edit = (cb: PrivateCallback, text: string, extra: Record<string, unknown> = {}) =>
  botApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch(() => {});
const shareUrl = (url: string) => `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent('CFT route map for drivers: truck routes and CFT fuel prices on the way.')}`;

/** The agent's or admin's two personal driver links, ready to send. */
async function sendPersonalLinks(db: Db, chat_id: number, by: Actor) {
  const links = await personalLinks(db, by);
  const how = by.agentId != null
    ? 'A driver who opens one asks for access, and a CFT admin approves it. You are shown as the one who invited them.'
    : 'A driver who opens one of your links gets the route map at once, approved by you.';
  await send(chat_id, ['🚚 <b>Your driver links</b>', '', 'Send either one to a driver:', `🤖 Telegram: <code>${links.bot}</code>`, `🌐 Website: <code>${links.website}</code>`, '', how].join('\n'), {
    reply_markup: {
      inline_keyboard: [
        [{ text: '📤 Share Telegram link', url: shareUrl(links.bot) }, { text: '📤 Share website link', url: shareUrl(links.website) }],
        [{ text: by.agentId != null ? '👤 My drivers' : '🚚 Drivers', callback_data: `${CB}list:mine` }],
      ],
    },
  });
}

/** Who is acting: an admin, an agent, or nobody allowed. */
async function actorOf(db: Db, who: Viewer, from: PrivateMessage['from']): Promise<Actor | null> {
  if (who.admin) {
    const me = await telegramAdmin(db, from);
    return me ? { adminId: me.id } : null;
  }
  return who.agent ? { agentId: from.id } : null;
}

/** Whether `by` may remove this driver: admins anyone, an agent the drivers of their own links. */
const mayRemove = (by: Actor, d: DriverRow) => by.adminId != null || d.invitedByAgent === by.agentId;

/** The drivers list. `mine`: only the agent's own drivers (agents switch between the two views). */
async function driversView(db: Db, by: Actor, mine = false) {
  const tz = await reportTimeZone(db);
  const { drivers: all, links } = await listDrivers(db, by.agentId);
  const agent = by.agentId != null;
  const drivers = agent && mine ? all.filter((d) => d.invitedByAgent === by.agentId) : all;
  const lines = [`🚚 <b>${agent && mine ? 'My drivers' : 'Drivers'}</b> · ${drivers.length}`];
  if (!drivers.length) lines.push('', agent && mine ? 'Nobody has joined through your links yet. Tap ➕ Invite driver to make one.' : 'No drivers yet. Tap ➕ Invite driver to make a link.');
  drivers.slice(0, 40).forEach((d, i) => {
    const by_ = agent && d.invitedByAgent === by.agentId ? ' · <b>yours</b>' : d.invitedBy ? ` · by ${esc(d.invitedBy)}` : '';
    lines.push(`${i + 1}. ${esc(d.name ?? 'Telegram user')}${d.username ? ' @' + esc(d.username) : ''} · joined ${fmtDMY(d.joinedAt, tz)}${by_}`);
  });
  if (drivers.length > 40) lines.push(`…and ${drivers.length - 40} more.`);
  if (links) lines.push('', `🔗 ${links} ${agent ? 'of your ' : ''}driver link${links === 1 ? '' : 's'} still open.`);
  const removable = drivers.filter((d) => mayRemove(by, d));
  if (agent && removable.length) lines.push('', '<i>You can remove drivers who joined through your links.</i>');
  const buttons = [
    agent
      ? [{ text: '➕ Invite driver', callback_data: `${CB}new` }, mine ? { text: '👥 All drivers', callback_data: `${CB}view:all` } : { text: '👤 My drivers', callback_data: `${CB}view:mine` }]
      : [{ text: '➕ Invite driver', callback_data: `${CB}new` }, ...(env.appUrl ? [{ text: '🗺 Trip history', web_app: { url: `${env.appUrl}/#/drivers` } }] : [])],
    ...removable.slice(0, 20).map((d) => [{ text: `Remove ${(d.name ?? String(d.telegramUserId)).slice(0, 30)}`, callback_data: `${CB}rm:${d.telegramUserId}` }]),
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
}

/** The drivers list as a new message (/drivers, the agents' home button, the admins' 👥 Team screen). */
async function sendDriversList(db: Db, chat_id: number, by: Actor, mine = false) {
  const v = await driversView(db, by, mine);
  await send(chat_id, v.text, { reply_markup: v.reply_markup });
}

/** /invitedriver and /drivers (admins and agents). */
export async function driverInviteMessage(db: Db, msg: PrivateMessage, who: Viewer): Promise<boolean> {
  const text = msg.text?.trim() ?? '';
  const cmd = commandOf(text);
  if (cmd !== '/drivers' && cmd !== '/invitedriver') return false;
  const by = await actorOf(db, who, msg.from);
  if (!by) await send(msg.chat.id, 'For CFT admins and agents only.');
  else if (cmd === '/drivers') await sendDriversList(db, msg.chat.id, by);
  else await sendPersonalLinks(db, msg.chat.id, by);
  return true;
}

export async function driverInviteCallback(db: Db, cb: PrivateCallback, who: Viewer): Promise<boolean> {
  if (!cb.data.startsWith(CB)) return false;
  const answer = (text?: string) => botApi('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const [kind, arg = ''] = cb.data.slice(CB.length).split(':');
  const chat = cb.message.chat.id;
  const by = await actorOf(db, who, cb.from);
  if (!by) {
    await answer('For CFT admins and agents only.');
    return true;
  }
  if (!(await firstSight(db, who.updateId))) return true;
  try {
    if (kind === 'new' || kind === 'inv') {
      // ➕ Invite driver, and the expiry buttons in messages from before personal links.
      await answer();
      await sendPersonalLinks(db, chat, by);
    } else if (kind === 'list') {
      await answer();
      await sendDriversList(db, chat, by, arg === 'mine');
    } else if (kind === 'view') {
      // My drivers ⇄ All drivers, in place.
      await answer();
      const v = await driversView(db, by, arg === 'mine');
      await edit(cb, v.text, { reply_markup: v.reply_markup });
    } else if (kind === 'off' && UUID_RE.test(arg)) {
      const done = await revokeDriverInvite(db, by, arg);
      await answer(done ? 'Link turned off' : 'This link already expired or was turned off');
      if (done) await edit(cb, '🚚 This driver link was turned off. Nobody can join with it.');
    } else if (kind === 'rm') {
      const { drivers } = await listDrivers(db);
      const d = drivers.find((x) => x.telegramUserId === Number(arg));
      await answer();
      if (!d) await send(chat, 'This person is no longer a driver.');
      else if (!mayRemove(by, d)) await send(chat, `${esc(d.name ?? 'This driver')} joined through someone else's link. Ask your CFT admin to remove them.`);
      else await send(chat, `Remove <b>${esc(d.name ?? 'this driver')}</b> as a driver? They lose the route map at once.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Yes, remove', callback_data: `${CB}rmy:${d.telegramUserId}` }, { text: 'Cancel', callback_data: `${CB}no` }]] },
      });
    } else if (kind === 'rmy') {
      const done = await removeDriver(db, by, Number(arg));
      await answer(done ? 'Removed' : 'Not removed');
      await edit(cb, done ? '✅ Driver removed. They no longer have the route map.' : 'Nothing changed: this person is no longer a driver, or joined through someone else\'s link.');
    } else if (kind === 'no') {
      await answer();
      await edit(cb, 'Nothing changed.');
    } else await answer();
  } catch (e) {
    await answer(e instanceof HttpError ? e.message.slice(0, 190) : 'Something went wrong. Try again.');
    if (!(e instanceof HttpError)) console.error('driver link action failed', kind, (e as Error).message);
  }
  return true;
}
