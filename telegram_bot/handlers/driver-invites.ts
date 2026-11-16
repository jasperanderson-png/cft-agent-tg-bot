import { fmtDMY, fmtDMYHM } from '../../shared/time.js';
import { INVITE_HOURS } from '../../core/agents.js';
import { telegramAdmin } from '../../core/admins.js';
import { createDriverInvite, listDrivers, removeDriver, revokeDriverInvite, type Actor } from '../../core/drivers.js';
import type { Db } from '../../db_storage/db.js';
import { HttpError, UUID_RE } from '../../core/http.js';
import { botApi, type PrivateCallback, type PrivateMessage } from '../../core/telegram.js';
import { firstSight, reportTimeZone } from '../../core/updates.js';
import { commandOf, type Viewer } from './viewer.js';

// Driver links in the chat: make one (admins, and agents an admin allowed to), turn it off, and for
// admins the driver list with removing. Drivers who join get the route map only
// (handlers/drivers/). The links work like agent links: anyone with one can join until it expires.

export const DRIVER_CALLBACK = 'drv:';
const CB = DRIVER_CALLBACK;
export const INVITE_DRIVER_COMMAND = { command: 'invitedriver', description: 'Drivers: invite a driver to the route map' };
export const DRIVERS_COMMAND = { command: 'drivers', description: 'Drivers: list and remove drivers' };
export const DRIVERS_HELP = '🚚 <b>Drivers</b>\n/invitedriver — a link that gives drivers the CFT route map (add a name: /invitedriver Night shift)\n/drivers — see drivers and remove one';
const HOURS_LABEL: Record<number, string> = { 1: '1 hour', 24: '1 day', 72: '3 days', 168: '7 days', 720: '30 days' };
const NOT_ALLOWED = 'Ask your CFT admin to let you invite drivers.';

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const send = (chat_id: number, text: string, extra: Record<string, unknown> = {}) =>
  botApi('sendMessage', { chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra });
const edit = (cb: PrivateCallback, text: string, extra: Record<string, unknown> = {}) =>
  botApi('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text, parse_mode: 'HTML', disable_web_page_preview: true, ...extra }).catch(() => {});

function shortLabel(label: string, maxBytes = 40): string {
  let s = label.replace(/:/g, ' ').trim();
  while (Buffer.byteLength(s, 'utf8') > maxBytes) s = s.slice(0, -1);
  return s;
}

export const askDriverExpiry = (chat_id: number, label: string) =>
  send(chat_id, `🚚 <b>Invite a driver</b>${label ? ` · ${esc(label)}` : ''}\n\nHow long should the link work? <b>Anyone</b> who opens it before then gets the CFT route map: truck routes, partner stations with the CFT price, and navigation. You can turn it off at any time.`, {
    reply_markup: { inline_keyboard: [INVITE_HOURS.slice(0, 3), INVITE_HOURS.slice(3)].map((row) => row.map((h) => ({ text: HOURS_LABEL[h], callback_data: `${CB}inv:${h}:${shortLabel(label)}` }))) },
  });

/** Who is making the link: an admin, an agent with the permission, or nobody allowed. */
async function actorOf(db: Db, who: Viewer, from: PrivateMessage['from']): Promise<Actor | null> {
  if (who.admin) {
    const me = await telegramAdmin(db, from);
    return me ? { adminId: me.id } : null;
  }
  return who.agent && who.canInviteDrivers ? { agentId: from.id } : null;
}

async function driversView(db: Db) {
  const tz = await reportTimeZone(db);
  const { drivers, links } = await listDrivers(db);
  const lines = [`🚚 <b>Drivers</b> · ${drivers.length}`];
  if (!drivers.length) lines.push('', 'No drivers yet. Tap ➕ Invite driver to make a link.');
  drivers.slice(0, 40).forEach((d, i) => lines.push(`${i + 1}. ${esc(d.name ?? 'Telegram user')}${d.username ? ' @' + esc(d.username) : ''} · joined ${fmtDMY(d.joinedAt, tz)}${d.invitedBy ? ` · by ${esc(d.invitedBy)}` : ''}`));
  if (drivers.length > 40) lines.push(`…and ${drivers.length - 40} more.`);
  if (links) lines.push('', `🔗 ${links} driver link${links === 1 ? '' : 's'} still open.`);
  const buttons = [
    [{ text: '➕ Invite driver', callback_data: `${CB}new` }],
    ...drivers.slice(0, 20).map((d) => [{ text: `Remove ${(d.name ?? String(d.telegramUserId)).slice(0, 30)}`, callback_data: `${CB}rm:${d.telegramUserId}` }]),
  ];
  return { text: lines.join('\n'), reply_markup: { inline_keyboard: buttons } };
}

/** The drivers list for admins (the 👥 Team screen opens it too). */
export async function sendDriversList(db: Db, chat_id: number) {
  const v = await driversView(db);
  await send(chat_id, v.text, { reply_markup: v.reply_markup });
}

/** /invitedriver (admins and allowed agents) and /drivers (admins). */
export async function driverInviteMessage(db: Db, msg: PrivateMessage, who: Viewer): Promise<boolean> {
  const text = msg.text?.trim() ?? '';
  const cmd = commandOf(text);
  if (cmd === '/drivers' && who.admin) {
    await sendDriversList(db, msg.chat.id);
    return true;
  }
  if (cmd !== '/invitedriver') return false;
  if (!(await actorOf(db, who, msg.from))) await send(msg.chat.id, NOT_ALLOWED);
  else await askDriverExpiry(msg.chat.id, text.replace(/^\S+\s*/, '').slice(0, 80));
  return true;
}

export async function driverInviteCallback(db: Db, cb: PrivateCallback, who: Viewer): Promise<boolean> {
  if (!cb.data.startsWith(CB)) return false;
  const answer = (text?: string) => botApi('answerCallbackQuery', { callback_query_id: cb.id, ...(text ? { text } : {}) }).catch(() => {});
  const [kind, arg = '', ...labelParts] = cb.data.slice(CB.length).split(':');
  const chat = cb.message.chat.id;
  const by = await actorOf(db, who, cb.from);
  if (!by) {
    await answer(who.agent ? NOT_ALLOWED : 'For CFT admins and agents only.');
    return true;
  }
  const adminOnly = ['list', 'rm', 'rmy'].includes(kind);
  if (adminOnly && !by.adminId) {
    await answer('For CFT administrators only.');
    return true;
  }
  if (!(await firstSight(db, who.updateId))) return true;
  try {
    if (kind === 'new') {
      await answer();
      await askDriverExpiry(chat, '');
    } else if (kind === 'list') {
      await answer();
      await sendDriversList(db, chat);
    } else if (kind === 'inv') {
      const label = labelParts.join(':');
      const inv = await createDriverInvite(db, by, Number(arg), label);
      const tz = await reportTimeZone(db);
      await answer('Link ready');
      const share = `https://t.me/share/url?url=${encodeURIComponent(inv.link)}&text=${encodeURIComponent('CFT route map for drivers: truck routes and CFT fuel prices on the way.')}`;
      await edit(
        cb,
        [
          `🚚 <b>Driver link</b>${label ? ` for ${esc(label)}` : ''}`,
          '',
          `<code>${inv.link}</code>`,
          '',
          `Anyone with this link can join until ${fmtDMYHM(inv.expiresAt, tz)} (${HOURS_LABEL[inv.hours]}). Send it to your drivers: when they open it and press Start, they get the CFT route map and you get a message here.`,
        ].join('\n'),
        { reply_markup: { inline_keyboard: [[{ text: '📤 Share link', url: share }], [{ text: 'Turn this link off', callback_data: `${CB}off:${inv.id}` }]] } },
      );
    } else if (kind === 'off' && UUID_RE.test(arg)) {
      const done = await revokeDriverInvite(db, by, arg);
      await answer(done ? 'Link turned off' : 'This link already expired or was turned off');
      if (done) await edit(cb, '🚚 This driver link was turned off. Nobody can join with it.');
    } else if (kind === 'rm') {
      const { drivers } = await listDrivers(db);
      const d = drivers.find((x) => x.telegramUserId === Number(arg));
      await answer();
      if (!d) await send(chat, 'This person is no longer a driver.');
      else await send(chat, `Remove <b>${esc(d.name ?? 'this driver')}</b> as a driver? They lose the route map at once.`, {
        reply_markup: { inline_keyboard: [[{ text: 'Yes, remove', callback_data: `${CB}rmy:${d.telegramUserId}` }, { text: 'Cancel', callback_data: `${CB}no` }]] },
      });
    } else if (kind === 'rmy') {
      const done = await removeDriver(db, by.adminId!, Number(arg));
      await answer(done ? 'Removed' : 'Already removed');
      await edit(cb, done ? '✅ Driver removed. They no longer have the route map.' : 'This person is no longer a driver.');
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
